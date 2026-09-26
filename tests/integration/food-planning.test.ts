import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	INGREDIENT_STATUSES,
	addPlanToShoppingList,
	addRecipeIngredient,
	createIngredient,
	createRecipe,
	mealPlan,
	planMeal,
	undoPlanShopping,
	unplanMeal,
	updateIngredient,
	type IngredientStatus
} from '$lib/server/repositories';
import { actions } from '../../src/routes/(app)/food/+page.server';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Planning meals from /food, and shopping for the plan.
 *
 * Two households, and two members in the first: the privacy cases need a
 * member who is not the owner (a household row they may read but not write,
 * a private row they may not read at all) as well as a stranger.
 *
 * Every name and date here is invented. The plan sits in a week of 2031 so
 * nothing depends on what today is: Monday 10 March to Sunday 16 March.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

const MONDAY = '2031-03-10';
const WEDNESDAY = '2031-03-12';
const SUNDAY = '2031-03-16';

let owner: Viewer;
let partner: Viewer;
let stranger: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

const person = (viewer: Viewer, username: string, role: 'admin' | 'member') => ({
	id: viewer.userId,
	username,
	displayName: username,
	role,
	mustChangeCredentials: false,
	isBootstrap: false
});

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`).id;
	owner = { userId: admin, householdId, role: 'admin' };

	const created = await createMember(sql, admin, householdId, {
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

	const [other] = await sql<{ id: string }[]>`
		insert into households (name) values ('Next door') returning id
	`;
	stranger = { userId: admin, householdId: other!.id, role: 'admin' };
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what: string) => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

const recipe = async (name: string, who: Viewer = owner, extra: object = {}) =>
	ok(await createRecipe(sql, who, { name, ...extra }), `create ${name}`).record;

const ingredient = async (name: string, status: IngredientStatus, extra: object = {}) =>
	ok(await createIngredient(sql, owner, { name, status, ...extra }), `create ${name}`).record;

/** A recipe that calls for the given ingredients. */
const dish = async (name: string, parts: { id: string }[], who: Viewer = owner) => {
	const made = await recipe(name, who);
	for (const part of parts) {
		ok(await addRecipeIngredient(sql, who, made.id, part.id), `attach to ${name}`);
	}
	return made;
};

const statusOf = async (id: string) =>
	one(await sql<{ status: string }[]>`select status from ingredients where id = ${id}::uuid`)
		.status;

const daysOn = async (date: string) =>
	one(
		await sql<{ n: number }[]>`
			select count(*)::int as n from meal_plans where on_date = ${date}::date
		`
	).n;

/** A day the owner holds with the given ownership, bypassing planMeal. */
const dayAs = async (date: string, visibility: 'household' | 'private', ownerId: string | null) =>
	one(
		await sql<{ id: string }[]>`
			insert into meal_plans (household_id, owner_user_id, visibility, on_date)
			values (${owner.householdId}::uuid, ${ownerId}::uuid, ${visibility}, ${date}::date)
			returning id
		`
	).id;

const link = (dayId: string, recipeId: string, slot = 'dinner') =>
	sql`insert into meal_plan_recipes (meal_plan_id, recipe_id, slot)
	    values (${dayId}::uuid, ${recipeId}::uuid, ${slot})`;

const shopWeek = (who: Viewer = owner) => addPlanToShoppingList(sql, who, MONDAY, SUNDAY);

// ─── planning ──────────────────────────────────────────────────────────────

describe('planning a meal', () => {
	it('opens a shared day on first use', async () => {
		const soup = await recipe('Parsnip soup');
		expect(await daysOn(WEDNESDAY)).toBe(0);

		const planned = ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id), 'plan');
		expect(planned.record.alreadyPlanned).toBe(false);

		// A new day is a household fact, like the plans the import brings in:
		// no owner, visible to both.
		const [day] = await sql<{ owner_user_id: string | null; visibility: string }[]>`
			select owner_user_id, visibility from meal_plans where on_date = ${WEDNESDAY}::date
		`;
		expect(day).toEqual({ owner_user_id: null, visibility: 'household' });

		const [shown] = await mealPlan(sql, partner, MONDAY, SUNDAY);
		expect(shown?.meals).toEqual([
			{ slot: 'dinner', recipeId: soup.id, recipeName: 'Parsnip soup' }
		]);
	});

	it('reuses the day it already has', async () => {
		const soup = await recipe('Parsnip soup');
		const toast = await recipe('Rye toast');
		const first = ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id), 'plan');
		const second = ok(await planMeal(sql, partner, WEDNESDAY, 'breakfast', toast.id), 'plan');

		expect(second.record.mealPlanId).toBe(first.record.mealPlanId);
		expect(await daysOn(WEDNESDAY)).toBe(1);
	});

	it('is harmless to plan the same recipe into the same slot twice', async () => {
		const soup = await recipe('Parsnip soup');
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id), 'plan');
		const again = ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id), 'plan again');

		expect(again.record.alreadyPlanned).toBe(true);
		const [day] = await mealPlan(sql, owner, WEDNESDAY, WEDNESDAY);
		expect(day?.meals).toHaveLength(1);
		expect(await daysOn(WEDNESDAY)).toBe(1);
	});

	it('removes one meal and leaves the rest of the day', async () => {
		const soup = await recipe('Parsnip soup');
		const toast = await recipe('Rye toast');
		const { mealPlanId } = ok(
			await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id),
			'plan'
		).record;
		ok(await planMeal(sql, owner, WEDNESDAY, 'breakfast', toast.id), 'plan');

		ok(await unplanMeal(sql, partner, mealPlanId, 'dinner', soup.id), 'unplan');

		const [day] = await mealPlan(sql, owner, WEDNESDAY, WEDNESDAY);
		expect(day?.meals.map((m) => m.recipeName)).toEqual(['Rye toast']);
		// Removing it again finds nothing, rather than removing something else.
		expect(await unplanMeal(sql, owner, mealPlanId, 'dinner', soup.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('refuses a date that is not one, or a slot that does not exist', async () => {
		const soup = await recipe('Parsnip soup');
		expect(await planMeal(sql, owner, '2031-02-30', 'dinner', soup.id)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		expect(await planMeal(sql, owner, WEDNESDAY, 'elevenses' as 'dinner', soup.id)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('does not offer a recipe that is in the archive', async () => {
		const soup = await recipe('Parsnip soup');
		await sql`update recipes set archived_at = now() where id = ${soup.id}::uuid`;
		expect(await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(await daysOn(WEDNESDAY)).toBe(0);
	});

	it('will not plan onto an archived day, where the meal would vanish', async () => {
		const soup = await recipe('Parsnip soup');
		const day = await dayAs(WEDNESDAY, 'household', null);
		await sql`update meal_plans set archived_at = now() where id = ${day}::uuid`;

		const refused = await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id);
		expect(refused).toMatchObject({ ok: false, reason: 'invalid' });
		expect(refused.ok ? '' : refused.message).toMatch(/archive/i);
		expect(
			await sql`select 1 from meal_plan_recipes where meal_plan_id = ${day}::uuid`
		).toHaveLength(0);
	});
});

describe('who may plan what', () => {
	it('will not let a member plan onto the other member’s private day', async () => {
		const soup = await recipe('Parsnip soup');
		const secret = await dayAs(WEDNESDAY, 'private', owner.userId);

		// Not "forbidden": saying a private plan exists is itself a disclosure.
		expect(await planMeal(sql, partner, WEDNESDAY, 'dinner', soup.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(
			await sql`select 1 from meal_plan_recipes where meal_plan_id = ${secret}::uuid`
		).toHaveLength(0);
		// The owner still can.
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id), 'plan own day');
	});

	it('will not let a member change a shared day the other member owns', async () => {
		const soup = await recipe('Parsnip soup');
		const theirs = await dayAs(WEDNESDAY, 'household', owner.userId);

		expect(await planMeal(sql, partner, WEDNESDAY, 'dinner', soup.id)).toMatchObject({
			ok: false,
			reason: 'forbidden'
		});
		await link(theirs, soup.id);
		expect(await unplanMeal(sql, partner, theirs, 'dinner', soup.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(
			await sql`select 1 from meal_plan_recipes where meal_plan_id = ${theirs}::uuid`
		).toHaveLength(1);
	});

	it('will not let a member plan a recipe they cannot read, and leaves no day behind', async () => {
		const secret = await recipe('Midnight noodles', owner, {
			ownerUserId: owner.userId,
			visibility: 'private'
		});

		expect(await planMeal(sql, partner, WEDNESDAY, 'dinner', secret.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		// The recipe is checked before the day is opened.
		expect(await daysOn(WEDNESDAY)).toBe(0);
	});

	it('does not name a private recipe planned onto a shared day', async () => {
		const secret = await recipe('Midnight noodles', owner, {
			ownerUserId: owner.userId,
			visibility: 'private'
		});
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', secret.id), 'plan own recipe');

		const [mine] = await mealPlan(sql, owner, WEDNESDAY, WEDNESDAY);
		expect(mine?.meals.map((m) => m.recipeName)).toEqual(['Midnight noodles']);
		const [theirs] = await mealPlan(sql, partner, WEDNESDAY, WEDNESDAY);
		expect(theirs?.meals).toEqual([]);
	});

	it('keeps each household’s days apart', async () => {
		const soup = await recipe('Parsnip soup');
		// Another household cannot plan our recipe…
		expect(await planMeal(sql, stranger, WEDNESDAY, 'dinner', soup.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		// …and planning its own on the same date opens its own day.
		const theirs = await recipe('Borscht', stranger);
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id), 'plan ours');
		ok(await planMeal(sql, stranger, WEDNESDAY, 'dinner', theirs.id), 'plan theirs');

		expect(await daysOn(WEDNESDAY)).toBe(2);
		const [ours] = await mealPlan(sql, owner, WEDNESDAY, WEDNESDAY);
		expect(ours?.meals.map((m) => m.recipeName)).toEqual(['Parsnip soup']);
		// Nor can it take a meal off ours.
		expect(await unplanMeal(sql, stranger, ours!.id, 'dinner', soup.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});
});

// ─── the shopping list ─────────────────────────────────────────────────────

describe('adding the week’s ingredients to the shopping list', () => {
	/*
	 * The rule, one status at a time. Only `not_needed` — the one status that
	 * means "not in the house" — moves; the rest are left exactly as they are.
	 * See the head of the section in repositories/food.ts for why.
	 */
	const EXPECTED: Record<IngredientStatus, IngredientStatus> = {
		not_needed: 'shopping_list',
		in_stock: 'in_stock',
		use_up: 'use_up',
		shopping_list: 'shopping_list'
	};

	it('covers every status the schema allows', () => {
		expect(Object.keys(EXPECTED).sort()).toEqual([...INGREDIENT_STATUSES].sort());
	});

	it.each(INGREDIENT_STATUSES)('leaves %s where the rule says', async (status) => {
		const thing = await ingredient('Celeriac', status);
		const soup = await dish('Celeriac soup', [thing]);
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id), 'plan');

		const result = ok(await shopWeek(), 'shop').record;
		expect(await statusOf(thing.id)).toBe(EXPECTED[status]);
		expect(result.added.map((a) => a.id)).toEqual(status === 'not_needed' ? [thing.id] : []);
	});

	it('says what it did with every ingredient it looked at', async () => {
		const parts = [
			await ingredient('Leeks', 'not_needed'),
			await ingredient('Barley', 'not_needed'),
			await ingredient('Butter', 'in_stock'),
			await ingredient('Cream', 'use_up'),
			await ingredient('Thyme', 'shopping_list')
		];
		const stew = await dish('Leek and barley stew', parts);
		ok(await planMeal(sql, owner, MONDAY, 'dinner', stew.id), 'plan');

		expect(ok(await shopWeek(), 'shop').record).toEqual({
			added: [
				{ id: parts[1]!.id, name: 'Barley' },
				{ id: parts[0]!.id, name: 'Leeks' }
			],
			alreadyListed: 1,
			inStock: 1,
			useUp: 1,
			notYours: 0,
			needed: 5
		});
	});

	it('treats a staple by its status like anything else', async () => {
		const salt = await ingredient('Flaky salt', 'not_needed', { isStaple: true });
		const oil = await ingredient('Olive oil', 'in_stock', { isStaple: true });
		const soup = await dish('Tomato soup', [salt, oil]);
		ok(await planMeal(sql, owner, WEDNESDAY, 'lunch', soup.id), 'plan');

		ok(await shopWeek(), 'shop');
		expect(await statusOf(salt.id)).toBe('shopping_list');
		expect(await statusOf(oil.id)).toBe('in_stock');
	});

	it('is idempotent: a second run changes nothing and says so', async () => {
		const leeks = await ingredient('Leeks', 'not_needed');
		const butter = await ingredient('Butter', 'in_stock');
		const stew = await dish('Leek stew', [leeks, butter]);
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', stew.id), 'plan');

		ok(await shopWeek(), 'first run');
		const before = await sql`select id, status, updated_at from ingredients order by id`;
		const second = ok(await shopWeek(), 'second run').record;
		const after = await sql`select id, status, updated_at from ingredients order by id`;

		expect(second.added).toEqual([]);
		expect(second).toMatchObject({ alreadyListed: 1, inStock: 1, needed: 2 });
		// Not even touched: the timestamps are the same.
		expect(after).toEqual(before);
	});

	it('counts an ingredient once, however many meals call for it', async () => {
		const onion = await ingredient('Onion', 'not_needed');
		const soup = await dish('Onion soup', [onion]);
		const tart = await dish('Onion tart', [onion]);
		ok(await planMeal(sql, owner, MONDAY, 'dinner', soup.id), 'plan');
		ok(await planMeal(sql, owner, WEDNESDAY, 'lunch', tart.id), 'plan');

		const result = ok(await shopWeek(), 'shop').record;
		expect(result.needed).toBe(1);
		expect(result.added).toHaveLength(1);
	});

	it('takes in Monday and Sunday, and nothing either side', async () => {
		const first = await ingredient('Radish', 'not_needed');
		const last = await ingredient('Fennel', 'not_needed');
		const before = await ingredient('Kale', 'not_needed');
		const after = await ingredient('Chard', 'not_needed');
		ok(await planMeal(sql, owner, MONDAY, 'dinner', (await dish('A', [first])).id), 'plan');
		ok(await planMeal(sql, owner, SUNDAY, 'dinner', (await dish('B', [last])).id), 'plan');
		ok(await planMeal(sql, owner, '2031-03-09', 'dinner', (await dish('C', [before])).id), 'plan');
		ok(await planMeal(sql, owner, '2031-03-17', 'dinner', (await dish('D', [after])).id), 'plan');

		const result = ok(await shopWeek(), 'shop').record;
		expect(result.added.map((a) => a.name)).toEqual(['Fennel', 'Radish']);
		expect(await statusOf(before.id)).toBe('not_needed');
		expect(await statusOf(after.id)).toBe('not_needed');
	});

	it('leaves archived ingredients and archived days alone', async () => {
		const binned = await ingredient('Old saffron', 'not_needed');
		await sql`update ingredients set archived_at = now() where id = ${binned.id}::uuid`;
		const onArchivedDay = await ingredient('Quince', 'not_needed');
		ok(await planMeal(sql, owner, MONDAY, 'dinner', (await dish('A', [binned])).id), 'plan');
		ok(
			await planMeal(sql, owner, WEDNESDAY, 'dinner', (await dish('B', [onArchivedDay])).id),
			'plan'
		);
		await sql`update meal_plans set archived_at = now() where on_date = ${WEDNESDAY}::date`;

		const result = ok(await shopWeek(), 'shop').record;
		expect(result).toMatchObject({ added: [], needed: 0 });
		expect(await statusOf(binned.id)).toBe('not_needed');
		expect(await statusOf(onArchivedDay.id)).toBe('not_needed');
	});

	it('refuses a range that is backwards or not dates', async () => {
		expect(await addPlanToShoppingList(sql, owner, SUNDAY, MONDAY)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		expect(await addPlanToShoppingList(sql, owner, 'monday', SUNDAY)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});
});

describe('whose ingredients the shopping list may touch', () => {
	it('only moves what the viewer may write, and counts the rest as not theirs', async () => {
		// Shared with the household, but the owner's own: readable by the
		// partner, not writable.
		const saffron = await ingredient('Saffron', 'not_needed', { ownerUserId: owner.userId });
		const rice = await ingredient('Rice', 'not_needed');
		const paella = await dish('Paella', [saffron, rice]);
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', paella.id), 'plan');

		const result = ok(await shopWeek(partner), 'shop as partner').record;
		expect(result.added.map((a) => a.name)).toEqual(['Rice']);
		expect(result.notYours).toBe(1);
		expect(await statusOf(saffron.id)).toBe('not_needed');

		// Its owner can.
		ok(await shopWeek(owner), 'shop as owner');
		expect(await statusOf(saffron.id)).toBe('shopping_list');
	});

	it('neither touches nor counts an ingredient the viewer cannot read', async () => {
		const secret = await ingredient('Truffle oil', 'not_needed', {
			ownerUserId: owner.userId,
			visibility: 'private'
		});
		const rice = await ingredient('Rice', 'not_needed');
		const risotto = await dish('Risotto', [secret, rice]);
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', risotto.id), 'plan');

		const result = ok(await shopWeek(partner), 'shop as partner').record;
		expect(result).toMatchObject({ needed: 1, notYours: 0 });
		expect(result.added.map((a) => a.name)).toEqual(['Rice']);
		expect(await statusOf(secret.id)).toBe('not_needed');
	});

	it('ignores a recipe the viewer cannot read, even on a shared day', async () => {
		const noodles = await ingredient('Rice noodles', 'not_needed');
		const secret = await recipe('Midnight noodles', owner, {
			ownerUserId: owner.userId,
			visibility: 'private'
		});
		ok(await addRecipeIngredient(sql, owner, secret.id, noodles.id), 'attach');
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', secret.id), 'plan');

		const result = ok(await shopWeek(partner), 'shop as partner').record;
		expect(result).toMatchObject({ added: [], needed: 0 });
		expect(await statusOf(noodles.id)).toBe('not_needed');
	});

	it('ignores a day the viewer cannot read', async () => {
		const figs = await ingredient('Figs', 'not_needed');
		const tart = await dish('Fig tart', [figs]);
		await link(await dayAs(WEDNESDAY, 'private', owner.userId), tart.id);

		expect(ok(await shopWeek(partner), 'shop as partner').record.needed).toBe(0);
		expect(await statusOf(figs.id)).toBe('not_needed');
		// It is the owner's plan, and the owner's run does see it.
		expect(ok(await shopWeek(owner), 'shop as owner').record.added).toHaveLength(1);
	});

	it('never crosses households', async () => {
		const ours = await ingredient('Leeks', 'not_needed');
		ok(
			await planMeal(sql, owner, WEDNESDAY, 'dinner', (await dish('Leek stew', [ours])).id),
			'plan'
		);

		const theirs = ok(
			await createIngredient(sql, stranger, { name: 'Beetroot', status: 'not_needed' }),
			'create theirs'
		).record;
		const borscht = await recipe('Borscht', stranger);
		ok(await addRecipeIngredient(sql, stranger, borscht.id, theirs.id), 'attach theirs');
		ok(await planMeal(sql, stranger, WEDNESDAY, 'dinner', borscht.id), 'plan theirs');

		// Their run moves theirs and nothing of ours…
		const result = ok(await shopWeek(stranger), 'shop as stranger').record;
		expect(result.added.map((a) => a.name)).toEqual(['Beetroot']);
		expect(await statusOf(ours.id)).toBe('not_needed');
		// …and undoing with our ids does nothing to ours either.
		ok(await shopWeek(owner), 'shop as owner');
		expect(ok(await undoPlanShopping(sql, stranger, [ours.id]), 'undo').record.restored).toBe(0);
		expect(await statusOf(ours.id)).toBe('shopping_list');
	});
});

describe('undoing it', () => {
	it('puts back exactly what was added, and nothing that was already listed', async () => {
		const leeks = await ingredient('Leeks', 'not_needed');
		const thyme = await ingredient('Thyme', 'shopping_list');
		const stew = await dish('Leek stew', [leeks, thyme]);
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', stew.id), 'plan');

		const { added } = ok(await shopWeek(), 'shop').record;
		const undone = ok(
			await undoPlanShopping(
				sql,
				owner,
				added.map((a) => a.id)
			),
			'undo'
		).record;

		expect(undone).toEqual({ restored: 1, leftAlone: 0 });
		expect(await statusOf(leeks.id)).toBe('not_needed');
		// Thyme was on the list before; it stays there.
		expect(await statusOf(thyme.id)).toBe('shopping_list');
	});

	it('does not un-buy something bought in the meantime', async () => {
		const leeks = await ingredient('Leeks', 'not_needed');
		const barley = await ingredient('Barley', 'not_needed');
		ok(
			await planMeal(sql, owner, WEDNESDAY, 'dinner', (await dish('Stew', [leeks, barley])).id),
			'plan'
		);

		const { added } = ok(await shopWeek(), 'shop').record;
		ok(await updateIngredient(sql, owner, leeks.id, { status: 'in_stock' }), 'got it');

		const undone = ok(
			await undoPlanShopping(
				sql,
				owner,
				added.map((a) => a.id)
			),
			'undo'
		).record;
		expect(undone).toEqual({ restored: 1, leftAlone: 1 });
		expect(await statusOf(leeks.id)).toBe('in_stock');
		expect(await statusOf(barley.id)).toBe('not_needed');
	});

	it('cannot reach an ingredient the viewer may not write', async () => {
		const saffron = await ingredient('Saffron', 'shopping_list', { ownerUserId: owner.userId });
		const undone = ok(await undoPlanShopping(sql, partner, [saffron.id]), 'undo').record;
		expect(undone).toEqual({ restored: 0, leftAlone: 1 });
		expect(await statusOf(saffron.id)).toBe('shopping_list');
	});

	it('ignores anything that is not an id', async () => {
		expect(ok(await undoPlanShopping(sql, owner, ['not-an-id', '']), 'undo').record).toEqual({
			restored: 0,
			leftAlone: 0
		});
	});
});

// ─── all or nothing ────────────────────────────────────────────────────────

/**
 * A failure planted in the database for one statement, and removed after.
 * Owned by the test role, which owns the schema here and in CI.
 */
async function withTripwire(
	table: 'ingredients' | 'meal_plan_recipes',
	when: string,
	fn: () => Promise<void>
) {
	await sql.unsafe(`
		create or replace function lifeos_test_tripwire() returns trigger language plpgsql as $$
		begin
			if ${when} then raise exception 'tripwire'; end if;
			return new;
		end $$;
		create trigger lifeos_test_tripwire before insert or update on ${table}
			for each row execute function lifeos_test_tripwire();
	`);
	try {
		await fn();
	} finally {
		await sql.unsafe(`
			drop trigger if exists lifeos_test_tripwire on ${table};
			drop function if exists lifeos_test_tripwire();
		`);
	}
}

describe('all or nothing', () => {
	it('changes no ingredient when one of them fails part way through', async () => {
		const parts = [
			await ingredient('Apricot', 'not_needed'),
			await ingredient('Tripwire', 'not_needed'),
			await ingredient('Zucchini', 'not_needed')
		];
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', (await dish('Mixed', parts)).id), 'plan');

		await withTripwire('ingredients', `new.name = 'Tripwire'`, async () => {
			await expect(shopWeek()).rejects.toThrow(/tripwire/);
		});

		for (const part of parts) expect(await statusOf(part.id)).toBe('not_needed');
		// And with the failure gone, the same call goes through.
		expect(ok(await shopWeek(), 'shop').record.added).toHaveLength(3);
	});

	it('leaves no empty day behind when the meal itself cannot be written', async () => {
		const soup = await recipe('Parsnip soup');
		await withTripwire('meal_plan_recipes', 'true', async () => {
			await expect(planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id)).rejects.toThrow(/tripwire/);
		});
		// The day was opened first and the link failed after it: both went.
		expect(await daysOn(WEDNESDAY)).toBe(0);
	});

	it('composes inside a caller’s transaction, rolling back only its own work', async () => {
		const parts = [
			await ingredient('Apricot', 'not_needed'),
			await ingredient('Tripwire', 'not_needed')
		];
		ok(await planMeal(sql, owner, WEDNESDAY, 'dinner', (await dish('Mixed', parts)).id), 'plan');

		await withTripwire(
			'ingredients',
			`new.name = 'Tripwire' and new.status = 'shopping_list'`,
			async () => {
				await sql.begin(async (tx) => {
					await tx`update ingredients set notes = 'kept' where id = ${parts[0]!.id}::uuid`;
					// A savepoint, not a second transaction: the failure unwinds the
					// shopping-list change and leaves the caller's own write alone.
					await expect(addPlanToShoppingList(tx, owner, MONDAY, SUNDAY)).rejects.toThrow(
						/tripwire/
					);
				});
			}
		);

		const [apricot] = await sql<{ status: string; notes: string | null }[]>`
			select status, notes from ingredients where id = ${parts[0]!.id}::uuid
		`;
		expect(apricot).toEqual({ status: 'not_needed', notes: 'kept' });
	});
});

// ─── the page's actions ────────────────────────────────────────────────────

type Action = keyof typeof actions;

/** Posts a form to one of /food's actions as `who`. */
async function post(name: Action, who: Viewer, fields: Record<string, string | string[]>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		for (const one of [value].flat()) body.append(key, one);
	}
	const event = {
		locals: {
			user: who === partner ? person(who, 'partner', 'member') : person(who, 'admin', 'admin')
		},
		request: new Request(`http://localhost/food?/${name}`, { method: 'POST', body })
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await actions[name]!(event as any)) as any;
}

describe('the /food actions', () => {
	it('plans from the form and refuses a slot the schema does not have', async () => {
		const soup = await recipe('Parsnip soup');
		expect(
			await post('plan', owner, { date: WEDNESDAY, slot: 'dinner', recipeId: soup.id })
		).toEqual({ planned: { date: WEDNESDAY, slot: 'dinner', alreadyPlanned: false } });
		const refused = await post('plan', owner, {
			date: WEDNESDAY,
			slot: 'supper',
			recipeId: soup.id
		});
		expect(refused.status).toBe(400);
	});

	it('says whose day it is when a member cannot change it', async () => {
		const soup = await recipe('Parsnip soup');
		await dayAs(WEDNESDAY, 'household', owner.userId);
		const refused = await post('plan', partner, {
			date: WEDNESDAY,
			slot: 'dinner',
			recipeId: soup.id
		});
		expect(refused.status).toBe(403);
		expect(refused.data.error).toMatch(/someone else/);
	});

	it('shops for the whole week containing the date it is given', async () => {
		const radish = await ingredient('Radish', 'not_needed');
		const fennel = await ingredient('Fennel', 'not_needed');
		ok(await planMeal(sql, owner, MONDAY, 'dinner', (await dish('A', [radish])).id), 'plan');
		ok(await planMeal(sql, owner, SUNDAY, 'dinner', (await dish('B', [fennel])).id), 'plan');

		// A Wednesday is widened to its Monday–Sunday week, not trusted as a range.
		const result = await post('shopWeek', owner, { from: WEDNESDAY });
		expect(result.shopped.from).toBe(MONDAY);
		expect(result.shopped.added.map((a: { name: string }) => a.name)).toEqual(['Fennel', 'Radish']);

		const undone = await post('undoShopWeek', owner, {
			id: result.shopped.added.map((a: { id: string }) => a.id)
		});
		expect(undone).toEqual({ unshopped: { restored: 2, leftAlone: 0 } });
	});

	it('removes a meal from the form', async () => {
		const soup = await recipe('Parsnip soup');
		const { mealPlanId } = ok(
			await planMeal(sql, owner, WEDNESDAY, 'dinner', soup.id),
			'plan'
		).record;
		expect(await post('unplan', owner, { mealPlanId, slot: 'dinner', recipeId: soup.id })).toEqual({
			unplanned: true
		});
		expect(
			(await post('unplan', owner, { mealPlanId, slot: 'dinner', recipeId: soup.id })).status
		).toBe(404);
	});
});
