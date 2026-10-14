import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf, type Viewer } from '$lib/server/auth/authz';
import type { AuthUser } from '$lib/server/auth/service';
import { one } from '$lib/server/db/scalar';
import { createRecipe, planMeal } from '$lib/server/repositories';
import { load } from '../../src/routes/(app)/journal/[date]/+page.server';
import type { JournalData } from '../../src/routes/(app)/journal/entry';

/**
 * The day's menu on the journal (PACK2-003), through the journal's own load.
 *
 * The plan's scoping is proved in food-planning.test.ts; these cases prove the
 * journal shows the same thing for the same day — in meal order, and without
 * the other member's private recipe.
 *
 * Every name and date here is invented.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

const DAY = '2026-08-12';

let owner: Viewer;
let partner: Viewer;
let ownerUser: AuthUser;
let partnerUser: AuthUser;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	ownerUser = {
		id: admin.id,
		username: 'admin',
		displayName: 'Admin',
		role: 'admin',
		mustChangeCredentials: false,
		isBootstrap: true
	};
	owner = viewerOf(ownerUser, householdId);

	const created = await createMember(sql, admin.id, householdId, {
		username: 'partner',
		displayName: 'Partner',
		role: 'member'
	});
	if (!created.ok) throw new Error('could not create the member');
	partnerUser = {
		id: created.userId,
		username: 'partner',
		displayName: 'Partner',
		role: 'member',
		mustChangeCredentials: false,
		isBootstrap: false
	};
	partner = viewerOf(partnerUser, householdId);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const open = async (user: AuthUser, date: string) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(await load({ locals: { user }, params: { date } } as any)) as JournalData;

async function recipe(viewer: Viewer, name: string, visibility?: 'private') {
	const made = await createRecipe(sql, viewer, {
		name,
		...(visibility ? { visibility, ownerUserId: viewer.userId } : {})
	});
	if (!made.ok) throw new Error(`could not create ${name}`);
	return made.record;
}

async function plan(viewer: Viewer, slot: 'breakfast' | 'lunch' | 'dinner', id: string) {
	const planned = await planMeal(sql, viewer, DAY, slot, id);
	if (!planned.ok) throw new Error(`could not plan ${slot}`);
}

describe('the journal menu', () => {
	it('lists the day’s meals breakfast first, not by slot name', async () => {
		const soup = await recipe(owner, 'Parsnip soup');
		const salad = await recipe(owner, 'Barley salad');
		const oats = await recipe(owner, 'Oat porridge');
		await plan(owner, 'dinner', soup.id);
		await plan(owner, 'lunch', salad.id);
		await plan(owner, 'breakfast', oats.id);

		const { menu } = await open(ownerUser, DAY);
		expect(menu).toEqual([
			{ slot: 'breakfast', recipeId: oats.id, recipeName: 'Oat porridge' },
			{ slot: 'lunch', recipeId: salad.id, recipeName: 'Barley salad' },
			{ slot: 'dinner', recipeId: soup.id, recipeName: 'Parsnip soup' }
		]);
	});

	it('does not show the other member’s private recipe', async () => {
		const shared = await recipe(owner, 'Parsnip soup');
		const secret = await recipe(partner, 'Surprise cake', 'private');
		await plan(owner, 'dinner', shared.id);
		await plan(partner, 'lunch', secret.id);

		expect((await open(ownerUser, DAY)).menu.map((m) => m.recipeName)).toEqual(['Parsnip soup']);
		expect((await open(partnerUser, DAY)).menu.map((m) => m.recipeName)).toEqual([
			'Surprise cake',
			'Parsnip soup'
		]);
	});

	it('is empty on a day with nothing planned', async () => {
		const soup = await recipe(owner, 'Parsnip soup');
		await plan(owner, 'dinner', soup.id);

		expect((await open(ownerUser, '2026-08-13')).menu).toEqual([]);
	});
});
