import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createFood,
	createFoodLogEntry,
	createRecipe,
	deleteFoodLogEntry,
	getFoodLogEntry,
	householdToday,
	listFoodLogEntriesForDay,
	listFoods,
	mealTotals,
	nutritionTotals,
	proteinByMonth,
	setFoodArchived,
	updateFood,
	updateFoodLogEntry
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The food log (migration 0032).
 *
 * Two things this covers that nothing else in the suite does: totals summed
 * in SQL over a mix of food-linked, recipe-linked and quick entries (base.ts
 * rule 1), and a food log entry's strict own-entries-only privacy, which is
 * narrower than the ordinary household-visibility rule every other table
 * here uses (base.ts rule 2, and the brief's own "never count another
 * member's private entries").
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
			mustChangeCredentials: true,
			isBootstrap: false
		},
		householdId
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

describe('the food library', () => {
	it('lists favourites first, otherwise by name', async () => {
		await ok(await createFood(sql, owner, { name: 'Fictional Oat Milk' }), 'create oat milk');
		const bar = ok(
			await createFood(sql, owner, { name: 'Fictional Protein Bar', isFavourite: true }),
			'create protein bar'
		).record;

		const list = await listFoods(sql, owner);
		// "Fictional Oat Milk" sorts first alphabetically; the favourite still
		// leads, which is the only thing worth proving here.
		expect(list.map((f) => f.id)[0]).toBe(bar.id);
	});

	it('finds a food by a name search', async () => {
		await ok(await createFood(sql, owner, { name: 'Fictional Chicken Breast' }), 'create');
		await ok(await createFood(sql, owner, { name: 'Fictional Turkey Breast' }), 'create');

		const found = await listFoods(sql, owner, { search: 'chicken' });
		expect(found.map((f) => f.name)).toEqual(['Fictional Chicken Breast']);
	});

	it('archives and restores, leaving the live list', async () => {
		const food = ok(
			await createFood(sql, owner, { name: 'Fictional Almond Butter' }),
			'create'
		).record;

		ok(await setFoodArchived(sql, owner, food.id, true), 'archive');
		expect(await listFoods(sql, owner)).toEqual([]);

		ok(await setFoodArchived(sql, owner, food.id, false), 'restore');
		expect((await listFoods(sql, owner)).map((f) => f.id)).toEqual([food.id]);
	});
});

describe('logging an entry', () => {
	it('snapshots the food’s name at log time, unaffected by a later rename', async () => {
		const food = ok(
			await createFood(sql, owner, {
				name: 'Fictional Protein Bar',
				proteinG: 20,
				kcalPerServing: 200
			}),
			'create food'
		).record;

		const entry = ok(
			await createFoodLogEntry(sql, owner, {
				foodId: food.id,
				servings: 1.5,
				meal: 'snack',
				eatenOn: '2026-09-20'
			}),
			'log entry'
		).record;
		expect(entry).toMatchObject({
			name: 'Fictional Protein Bar',
			servings: 1.5,
			meal: 'snack',
			foodId: food.id,
			recipeId: null,
			ownerUserId: owner.userId,
			visibility: 'private'
		});

		ok(
			await updateFood(sql, owner, food.id, { name: 'Fictional Protein Bar (New Flavour)' }),
			'rename food'
		);
		expect((await getFoodLogEntry(sql, owner, entry.id))?.name).toBe('Fictional Protein Bar');
	});

	it('survives the food being removed outright — the FK sets null, the snapshot stays', async () => {
		const food = ok(
			await createFood(sql, owner, { name: 'Fictional Granola' }),
			'create food'
		).record;
		const entry = ok(
			await createFoodLogEntry(sql, owner, {
				foodId: food.id,
				meal: 'breakfast',
				eatenOn: '2026-09-20'
			}),
			'log entry'
		).record;

		// The app itself only ever archives a food; this proves the schema's own
		// safety net (migration 0032's `on delete set null`) for the case where
		// a row is removed some other way — a database cleanup, say.
		await sql`delete from foods where id = ${food.id}::uuid`;

		const survived = await getFoodLogEntry(sql, owner, entry.id);
		expect(survived).toMatchObject({ foodId: null, name: 'Fictional Granola' });
	});

	it('requires a typed name and refuses picking both a food and a recipe', async () => {
		const quick = await createFoodLogEntry(sql, owner, { meal: 'lunch', eatenOn: '2026-09-20' });
		expect(quick).toMatchObject({ ok: false, reason: 'invalid' });

		const food = ok(await createFood(sql, owner, { name: 'Fictional Rice' }), 'create food').record;
		const recipe = ok(
			await createRecipe(sql, owner, { name: 'Fictional Curry' }),
			'create recipe'
		).record;
		const both = await createFoodLogEntry(sql, owner, {
			foodId: food.id,
			recipeId: recipe.id,
			meal: 'dinner'
		});
		expect(both).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('is enforced by the table itself, not only by this module', async () => {
		const food = ok(await createFood(sql, owner, { name: 'Fictional Rice' }), 'create food').record;
		const recipe = ok(
			await createRecipe(sql, owner, { name: 'Fictional Curry' }),
			'create recipe'
		).record;
		await expect(
			sql`
				insert into food_log_entries (
					household_id, owner_user_id, eaten_on, meal, food_id, recipe_id, name, servings
				) values (
					${owner.householdId}::uuid, ${owner.userId}::uuid, '2026-09-20'::date, 'lunch',
					${food.id}::uuid, ${recipe.id}::uuid, 'Both at once', 1
				)
			`
		).rejects.toThrow(/food_log_entries_check/);
	});

	it('deletes outright — no archive, no trace left in the day', async () => {
		const entry = ok(
			await createFoodLogEntry(sql, owner, {
				meal: 'breakfast',
				eatenOn: '2026-09-20',
				name: 'Toast'
			}),
			'log a quick entry'
		).record;

		expect(await deleteFoodLogEntry(sql, owner, entry.id)).toBe(true);
		expect(await getFoodLogEntry(sql, owner, entry.id)).toBeNull();
		// Deleting an already-gone (or someone else's) id is simply not found.
		expect(await deleteFoodLogEntry(sql, owner, entry.id)).toBe(false);
	});

	it('conflicts on a stale edit', async () => {
		const entry = ok(
			await createFoodLogEntry(sql, owner, { meal: 'lunch', eatenOn: '2026-09-20', name: 'Soup' }),
			'log entry'
		).record;

		const stale = await updateFoodLogEntry(
			sql,
			owner,
			entry.id,
			{ servings: 2 },
			new Date('2000-01-01')
		);
		expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
	});

	describe('privacy', () => {
		it('cannot log a food the writer cannot read', async () => {
			const theirs = ok(
				await createFood(sql, partner, {
					name: 'Fictional Partner Snack',
					visibility: 'private',
					ownerUserId: partner.userId
				}),
				'partner creates a private food'
			).record;

			const attempt = await createFoodLogEntry(sql, owner, { foodId: theirs.id, meal: 'snack' });
			expect(attempt).toMatchObject({ ok: false, reason: 'not_found' });
		});

		it('shows another member’s entry for the day only when it is household-visible and asked for', async () => {
			await ok(
				await createFoodLogEntry(sql, partner, {
					meal: 'lunch',
					eatenOn: '2026-09-20',
					name: 'Partner’s private lunch'
				}),
				'partner logs a private entry'
			);
			const shared = ok(
				await createFoodLogEntry(sql, partner, {
					meal: 'dinner',
					eatenOn: '2026-09-20',
					name: 'Shared dinner',
					visibility: 'household'
				}),
				'partner logs a shared entry'
			).record;

			const ownOnly = await listFoodLogEntriesForDay(sql, owner, '2026-09-20');
			expect(ownOnly).toEqual([]);

			const withHousehold = await listFoodLogEntriesForDay(sql, owner, '2026-09-20', {
				includeHousehold: true
			});
			expect(withHousehold.map((e) => e.id)).toEqual([shared.id]);
		});
	});
});

describe('nutritionTotals', () => {
	it('sums overrides and servings in SQL, and reports what it could not total', async () => {
		const food = ok(
			await createFood(sql, owner, {
				name: 'Fictional Protein Bar',
				proteinG: 20,
				kcalPerServing: 200
			}),
			'create food'
		).record;
		// carbs_g left null on purpose: the recipe has no carbs figure at all.
		const [recipe] = await sql<{ id: string }[]>`
			insert into recipes (household_id, name, protein_g, kcal_per_serving, created_by, updated_by)
			values (${owner.householdId}::uuid, 'Fictional Lentil Soup', 18, 250,
			        ${owner.userId}::uuid, ${owner.userId}::uuid)
			returning id
		`;

		// Day 1: 1.5 servings of the bar (30 g protein, 300 kcal), a second bar
		// with its kcal overridden but protein left to the source (20 g), and a
		// quick entry that only states its kcal — its protein is unknown, not 0.
		await ok(
			await createFoodLogEntry(sql, owner, {
				foodId: food.id,
				servings: 1.5,
				meal: 'snack',
				eatenOn: '2026-09-20'
			}),
			'log 1.5 bars'
		);
		await ok(
			await createFoodLogEntry(sql, owner, {
				foodId: food.id,
				servings: 1,
				meal: 'snack',
				eatenOn: '2026-09-20',
				kcalOverride: 999
			}),
			'log an overridden bar'
		);
		await ok(
			await createFoodLogEntry(sql, owner, {
				meal: 'snack',
				eatenOn: '2026-09-20',
				name: 'Fictional gas-station snack',
				kcalOverride: 150
			}),
			'log a quick snack'
		);

		// Day 2: two servings of the soup — protein known (36 g), carbs unknown.
		await ok(
			await createFoodLogEntry(sql, owner, {
				recipeId: recipe!.id,
				servings: 2,
				meal: 'dinner',
				eatenOn: '2026-09-21'
			}),
			'log the soup'
		);

		// A shared entry of the partner's, the same day, with a very different
		// protein figure — it must not move the owner's own totals at all.
		await ok(
			await createFoodLogEntry(sql, partner, {
				meal: 'dinner',
				eatenOn: '2026-09-20',
				name: 'Partner’s dinner',
				visibility: 'household',
				proteinGOverride: 500
			}),
			'partner logs a shared dinner'
		);

		const totals = await nutritionTotals(sql, owner, '2026-09-20', '2026-09-21');
		expect(totals).toHaveLength(2);

		const [day1, day2] = totals;
		expect(day1).toMatchObject({
			day: '2026-09-20',
			kcal: 300 + 999 + 150,
			kcalUnknown: 0,
			proteinG: 30 + 20,
			proteinGUnknown: 1
		});
		expect(day2).toMatchObject({
			day: '2026-09-21',
			kcal: 500,
			kcalUnknown: 0,
			proteinG: 36,
			proteinGUnknown: 0,
			carbsG: null,
			carbsGUnknown: 1
		});
	});
});

describe('mealTotals', () => {
	it('groups kcal and protein by meal, own entries only', async () => {
		const food = ok(
			await createFood(sql, owner, {
				name: 'Fictional Protein Bar',
				proteinG: 20,
				kcalPerServing: 200
			}),
			'create food'
		).record;
		await ok(
			await createFoodLogEntry(sql, owner, {
				foodId: food.id,
				servings: 1,
				meal: 'breakfast',
				eatenOn: '2026-09-20'
			}),
			'log breakfast'
		);
		await ok(
			await createFoodLogEntry(sql, owner, {
				meal: 'dinner',
				eatenOn: '2026-09-20',
				name: 'Fictional takeout',
				kcalOverride: 700
			}),
			'log dinner'
		);
		// A shared entry of the partner's, same day and meal — must not merge
		// into the owner's own breakfast total.
		await ok(
			await createFoodLogEntry(sql, partner, {
				meal: 'breakfast',
				eatenOn: '2026-09-20',
				name: 'Partner’s breakfast',
				visibility: 'household',
				kcalOverride: 900
			}),
			'partner logs a shared breakfast'
		);

		const totals = await mealTotals(sql, owner, '2026-09-20');
		const byMeal = Object.fromEntries(totals.map((t) => [t.meal, t]));
		expect(byMeal.breakfast).toMatchObject({ kcal: 200, kcalUnknown: 0, proteinG: 20 });
		expect(byMeal.dinner).toMatchObject({ kcal: 700, kcalUnknown: 0, proteinGUnknown: 1 });
		expect(byMeal.lunch).toBeUndefined();
		expect(byMeal.snack).toBeUndefined();
	});
});

describe('proteinByMonth', () => {
	it('zero-fills the window and totals the current month', async () => {
		const today = await householdToday(sql, owner.householdId);
		await ok(
			await createFoodLogEntry(sql, owner, {
				meal: 'lunch',
				eatenOn: today,
				name: 'Fictional today lunch',
				proteinGOverride: 42
			}),
			'log today'
		);

		const series = await proteinByMonth(sql, owner, 3);
		expect(series).toHaveLength(3);
		expect(series.at(-1)).toMatchObject({ proteinG: 42, unknownEntries: 0 });
		expect(series[0]?.proteinG).toBeNull();
	});
});

describe('through a client configured the way the app’s is', () => {
	it('writes a food and a log entry through a drizzle-wrapped client', async () => {
		// See health-measurements.test.ts's own copy of this test for why: the
		// app's client is wrapped by drizzle(), which makes a JS Date parameter
		// throw where the plain client above would silently convert it.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const food = ok(
				await createFood(appLike, owner, { name: 'Fictional Drizzle Food', proteinG: 10 }),
				'create a food through the app-like client'
			).record;
			ok(
				await updateFood(appLike, owner, food.id, { proteinG: 12 }, food.updatedAt),
				'edit it through the app-like client'
			);

			const entry = ok(
				await createFoodLogEntry(appLike, owner, {
					foodId: food.id,
					meal: 'breakfast',
					eatenOn: '2026-09-20'
				}),
				'log an entry through the app-like client'
			).record;
			const edited = ok(
				await updateFoodLogEntry(appLike, owner, entry.id, { servings: 2 }, entry.updatedAt),
				'edit the entry through the app-like client'
			).record;
			expect(edited.servings).toBe(2);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
