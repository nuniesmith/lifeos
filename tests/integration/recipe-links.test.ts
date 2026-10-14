import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf, type Viewer } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addRelatedRecipe,
	createRecipe,
	listRelatedRecipes,
	removeRelatedRecipe
} from '$lib/server/repositories';

/**
 * Related recipes (migration 0039, PACK2-001).
 *
 * One link per pair, shown from both ends; never a recipe to itself; and the
 * same scoping as library links — a link starts and ends on a recipe the
 * viewer may write, reaches only one they may read, and never names the
 * other member's private recipe.
 *
 * Every name here is invented.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	owner = viewerOf(
		{
			id: admin.id,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		householdId
	);
	const created = await createMember(sql, admin.id, householdId, {
		username: 'partner',
		displayName: 'Partner',
		role: 'member'
	});
	if (!created.ok) throw new Error('could not create the member');
	partner = viewerOf(
		{
			id: created.userId,
			username: 'partner',
			displayName: 'Partner',
			role: 'member',
			mustChangeCredentials: false,
			isBootstrap: false
		},
		householdId
	);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

async function recipe(viewer: Viewer, name: string, privately = false) {
	const made = await createRecipe(sql, viewer, {
		name,
		...(privately ? { visibility: 'private', ownerUserId: viewer.userId } : {})
	});
	if (!made.ok) throw new Error(`could not create ${name}`);
	return made.record.id;
}

const names = async (viewer: Viewer, id: string) =>
	(await listRelatedRecipes(sql, viewer, id)).map((r) => r.name);

describe('related recipes', () => {
	it('links a pair once, from either end, and shows it on both', async () => {
		const soup = await recipe(owner, 'Fictional leek soup');
		const bread = await recipe(owner, 'Fictional soda bread');
		const salad = await recipe(owner, 'Fictional bean salad');

		expect(await addRelatedRecipe(sql, owner, soup, bread)).toMatchObject({
			ok: true,
			record: { recipeId: bread, name: 'Fictional soda bread' }
		});
		// The same pair from the other end, and again: still one link.
		expect((await addRelatedRecipe(sql, owner, bread, soup)).ok).toBe(true);
		expect((await addRelatedRecipe(sql, owner, soup, bread)).ok).toBe(true);
		await addRelatedRecipe(sql, owner, soup, salad);

		const [count] = await sql<{ n: number }[]>`select count(*)::int as n from recipe_links`;
		expect(count!.n).toBe(2);
		expect(await names(owner, soup)).toEqual(['Fictional bean salad', 'Fictional soda bread']);
		expect(await names(owner, bread)).toEqual(['Fictional leek soup']);

		// Unlinked from the far end; asking again is still success.
		expect(await removeRelatedRecipe(sql, owner, bread, soup)).toBe(true);
		expect(await removeRelatedRecipe(sql, owner, bread, soup)).toBe(false);
		expect(await names(owner, soup)).toEqual(['Fictional bean salad']);
	});

	it('refuses a recipe related to itself', async () => {
		const soup = await recipe(owner, 'Fictional leek soup');
		expect(await addRelatedRecipe(sql, owner, soup, soup)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('never names, or links to, the other member’s private recipe', async () => {
		const soup = await recipe(owner, 'Fictional leek soup');
		const secret = await recipe(partner, 'Fictional surprise cake', true);

		// The owner cannot reach it to link to it.
		expect(await addRelatedRecipe(sql, owner, soup, secret)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});

		// Linked by its own member, it still does not show to the owner —
		// neither from the shared recipe nor by asking about the private one.
		expect((await addRelatedRecipe(sql, partner, secret, soup)).ok).toBe(true);
		expect(await names(owner, soup)).toEqual([]);
		expect(await names(owner, secret)).toEqual([]);
		expect(await names(partner, soup)).toEqual(['Fictional surprise cake']);

		// Nor can the owner remove it from the private end.
		expect(await removeRelatedRecipe(sql, owner, secret, soup)).toBe(false);
		expect(await names(partner, soup)).toEqual(['Fictional surprise cake']);
	});

	it('goes with a recipe that is deleted', async () => {
		const soup = await recipe(owner, 'Fictional leek soup');
		const bread = await recipe(owner, 'Fictional soda bread');
		await addRelatedRecipe(sql, owner, soup, bread);
		await sql`delete from recipes where id = ${bread}::uuid`;
		expect(await names(owner, soup)).toEqual([]);
	});
});
