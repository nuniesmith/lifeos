import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addRecipeIngredient,
	createIngredient,
	createRecipe,
	foodSummary,
	ingredientAisles,
	ingredientStatusCounts,
	ingredientsForRecipe,
	listIngredients,
	listRecipes,
	mealPlan,
	planMeal,
	unplanMeal,
	updateIngredient
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Food HQ (migration 0012).
 *
 * The shopping list is not a list — it is a status on the pantry. That is the
 * property worth protecting: a "buy this" that lives in its own table drifts
 * out of sync with what is actually in the house, and nobody notices until
 * they are standing in the shop.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let viewer: Viewer;
let elsewhere: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	viewer = viewerOf(
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

	// A second household, to prove nothing leaks across the boundary.
	const [other] = await sql<{ id: string }[]>`
		insert into households (name) values ('Next door') returning id
	`;
	elsewhere = viewerOf(
		{
			id: admin.id,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		other!.id
	);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what: string) => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

const ingredient = async (name: string, extra: object = {}) =>
	ok(await createIngredient(sql, viewer, { name, ...extra }), `create ${name}`).record;

const recipe = async (name: string, extra: object = {}) =>
	ok(await createRecipe(sql, viewer, { name, ...extra }), `create ${name}`).record;

describe('the pantry and the shopping list', () => {
	it('treats the shopping list as a status, not a separate list', async () => {
		await ingredient('Cheddar', { status: 'in_stock' });
		const broccoli = await ingredient('Broccoli', { status: 'shopping_list' });

		expect(
			(await listIngredients(sql, viewer, { status: 'shopping_list' })).map((i) => i.name)
		).toEqual(['Broccoli']);

		// Buying it moves it into the pantry; there is nothing to keep in sync
		// because there was never a second copy.
		ok(await updateIngredient(sql, viewer, broccoli.id, { status: 'in_stock' }), 'buy');
		expect(await listIngredients(sql, viewer, { status: 'shopping_list' })).toEqual([]);
		expect((await listIngredients(sql, viewer, { status: 'in_stock' })).map((i) => i.name)).toEqual(
			['Broccoli', 'Cheddar']
		);
	});

	it('counts each status for the page chips', async () => {
		await ingredient('Cheddar', { status: 'in_stock' });
		await ingredient('Broccoli', { status: 'shopping_list' });
		await ingredient('Buttermilk', { status: 'use_up' });

		expect(await ingredientStatusCounts(sql, viewer)).toEqual({
			in_stock: 1,
			shopping_list: 1,
			use_up: 1,
			not_needed: 0
		});
	});

	it('refuses a status it does not know', async () => {
		expect(await createIngredient(sql, viewer, { name: 'Mystery', status: 'maybe' })).toMatchObject(
			{
				ok: false,
				reason: 'invalid'
			}
		);
	});

	it('refuses a duplicate name, case-insensitively', async () => {
		await ingredient('Cheddar');
		expect(await createIngredient(sql, viewer, { name: 'cheddar' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('orders by aisle so the list can be walked', async () => {
		await ingredient('Cheddar', { aisle: 'Dairy', status: 'shopping_list' });
		await ingredient('Apples', { aisle: 'Produce', status: 'shopping_list' });
		await ingredient('Butter', { aisle: 'Dairy', status: 'shopping_list' });

		const walked = await listIngredients(sql, viewer, { status: 'shopping_list', order: 'aisle' });
		expect(walked.map((i) => i.name)).toEqual(['Butter', 'Cheddar', 'Apples']);
		expect(await ingredientAisles(sql, viewer)).toEqual(['Dairy', 'Produce']);
	});
});

describe('recipes', () => {
	it('derives the total time rather than storing it', async () => {
		const soup = await recipe('Soup', { prepMinutes: 10, cookMinutes: 25, additionalMinutes: 5 });
		expect(soup.totalMinutes).toBe(40);

		// A recipe with no times at all has no total, rather than a total of 0
		// — zero minutes is a claim, absence is not.
		const unknown = await recipe('Mystery');
		expect(unknown.totalMinutes).toBeNull();
	});

	it('splits a comma-separated course list into an array', async () => {
		const soup = await recipe('Soup', { courses: 'Lunch, Dinner', seasons: ['Winter'] });
		expect(soup.courses).toEqual(['Lunch', 'Dinner']);
		expect(soup.seasons).toEqual(['Winter']);

		expect((await listRecipes(sql, viewer, { course: 'Dinner' })).map((r) => r.name)).toEqual([
			'Soup'
		]);
		expect(await listRecipes(sql, viewer, { course: 'Breakfast' })).toEqual([]);
	});

	it('joins ingredients with the amount on the pairing', async () => {
		const soup = await recipe('Soup');
		const cheddar = await ingredient('Cheddar');
		const broccoli = await ingredient('Broccoli');

		ok(await addRecipeIngredient(sql, viewer, soup.id, cheddar.id, '2 cups, grated'), 'attach');
		ok(await addRecipeIngredient(sql, viewer, soup.id, broccoli.id), 'attach');

		const parts = await ingredientsForRecipe(sql, viewer, soup.id);
		expect(parts.map((p) => p.ingredient.name)).toEqual(['Broccoli', 'Cheddar']);
		// The amount belongs to the pairing, not the ingredient: cheddar is not
		// "2 cups" in general.
		expect(parts.find((p) => p.ingredient.name === 'Cheddar')?.amount).toBe('2 cups, grated');
	});

	it('refuses to attach an ingredient from another household', async () => {
		const soup = await recipe('Soup');
		const theirs = ok(
			await createIngredient(sql, elsewhere, { name: 'Not ours' }),
			'create elsewhere'
		).record;

		expect(await addRecipeIngredient(sql, viewer, soup.id, theirs.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(await ingredientsForRecipe(sql, viewer, soup.id)).toEqual([]);
	});
});

describe('the plan', () => {
	it('opens a day on demand when something is planned onto it', async () => {
		const soup = await recipe('Soup');
		// Planning dinner should not require first creating an empty menu.
		ok(await planMeal(sql, viewer, '2026-08-24', 'dinner', soup.id), 'plan');

		const week = await mealPlan(sql, viewer, '2026-08-24', '2026-08-30');
		expect(week).toHaveLength(1);
		expect(week[0]?.meals).toEqual([{ slot: 'dinner', recipeId: soup.id, recipeName: 'Soup' }]);
	});

	it('holds two recipes in one slot', async () => {
		const bowl = await recipe('Cheeseburger bowl');
		const sauce = await recipe('Big Mac sauce');
		ok(await planMeal(sql, viewer, '2026-08-24', 'dinner', bowl.id), 'plan');
		ok(await planMeal(sql, viewer, '2026-08-24', 'dinner', sauce.id), 'plan');

		// A dinner really is two recipes sometimes — the bowl and what goes on it.
		const [day] = await mealPlan(sql, viewer, '2026-08-24', '2026-08-24');
		expect(day?.meals.map((m) => m.recipeName).sort()).toEqual([
			'Big Mac sauce',
			'Cheeseburger bowl'
		]);
	});

	it('keeps the same recipe in two different slots apart', async () => {
		const leftovers = await recipe('Leftovers');
		ok(await planMeal(sql, viewer, '2026-08-24', 'lunch', leftovers.id), 'plan');
		ok(await planMeal(sql, viewer, '2026-08-24', 'dinner', leftovers.id), 'plan');

		const [day] = await mealPlan(sql, viewer, '2026-08-24', '2026-08-24');
		expect(day?.meals.map((m) => m.slot).sort()).toEqual(['dinner', 'lunch']);
	});

	it('is idempotent, so planning the same thing twice is not an error', async () => {
		const soup = await recipe('Soup');
		ok(await planMeal(sql, viewer, '2026-08-24', 'dinner', soup.id), 'plan');
		expect(await planMeal(sql, viewer, '2026-08-24', 'dinner', soup.id)).toMatchObject({
			ok: true
		});

		const [day] = await mealPlan(sql, viewer, '2026-08-24', '2026-08-24');
		expect(day?.meals).toHaveLength(1);
	});

	it('removes one meal without disturbing the rest of the day', async () => {
		const soup = await recipe('Soup');
		const pancakes = await recipe('Pancakes');
		ok(await planMeal(sql, viewer, '2026-08-24', 'dinner', soup.id), 'plan');
		ok(await planMeal(sql, viewer, '2026-08-24', 'breakfast', pancakes.id), 'plan');

		const [before] = await mealPlan(sql, viewer, '2026-08-24', '2026-08-24');
		ok(await unplanMeal(sql, viewer, before!.id, 'dinner', soup.id), 'unplan');

		const [after] = await mealPlan(sql, viewer, '2026-08-24', '2026-08-24');
		expect(after?.meals.map((m) => m.recipeName)).toEqual(['Pancakes']);
	});

	it('refuses to plan a recipe from another household', async () => {
		const theirs = ok(await createRecipe(sql, elsewhere, { name: 'Not ours' }), 'create').record;
		expect(await planMeal(sql, viewer, '2026-08-24', 'dinner', theirs.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('never shows another household’s plan', async () => {
		const soup = await recipe('Soup');
		ok(await planMeal(sql, viewer, '2026-08-24', 'dinner', soup.id), 'plan');
		expect(await mealPlan(sql, elsewhere, '2026-08-24', '2026-08-30')).toEqual([]);
	});
});

describe('the summary', () => {
	it('counts recipes, the shopping list and open prep in one pass', async () => {
		await recipe('Soup');
		await recipe('Pancakes');
		await ingredient('Broccoli', { status: 'shopping_list' });
		await ingredient('Cheddar', { status: 'in_stock' });
		await sql`
			insert into prep_tasks (household_id, name, is_done)
			values (${viewer.householdId}::uuid, 'Chop veggies', false),
			       (${viewer.householdId}::uuid, 'Shred cheese', true)
		`;

		expect(await foodSummary(sql, viewer)).toEqual({
			recipes: 2,
			shoppingList: 1,
			openPrep: 1
		});
	});

	it('counts nothing from another household', async () => {
		await recipe('Soup');
		await ingredient('Broccoli', { status: 'shopping_list' });
		expect(await foodSummary(sql, elsewhere)).toEqual({
			recipes: 0,
			shoppingList: 0,
			openPrep: 0
		});
	});
});
