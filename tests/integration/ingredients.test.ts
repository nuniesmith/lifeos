import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addRecipeIngredient,
	attachNewIngredientToRecipe,
	createIngredient,
	createRecipe,
	ingredientsForRecipe,
	listIngredients,
	removeRecipeIngredient,
	setIngredientArchived,
	updateIngredient
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Full editing of an ingredient, and structured amounts on both `ingredients`
 * and `recipe_ingredients` (migration 0026, PACK2-002).
 *
 * `tests/integration/food.test.ts` and `recipes.test.ts` already cover the
 * pantry/shopping-list mechanic and the base `addRecipeIngredient` — this
 * file is the new surface only: full ingredient edits, archive/restore,
 * detaching, creating-and-attaching in one step, and the structured pair
 * beside each free-text amount.
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

const ingredient = async (name: string, extra: object = {}, who: Viewer = viewer) =>
	ok(await createIngredient(sql, who, { name, ...extra }), `create ${name}`).record;

const recipe = async (name: string, extra: object = {}, who: Viewer = viewer) =>
	ok(await createRecipe(sql, who, { name, ...extra }), `create ${name}`).record;

// ─── editing an ingredient fully ────────────────────────────────────────────

describe('editing an ingredient', () => {
	it('sets every field, and clearing one field leaves the rest alone', async () => {
		const oats = await ingredient('Rolled oats', { aisle: 'Grains', status: 'in_stock' });

		const saved = ok(
			await updateIngredient(sql, viewer, oats.id, {
				aisle: 'Baking',
				category: 'Dry goods',
				store: 'Corner shop',
				isStaple: true,
				quantity: '1 bag',
				preferredBrand: 'Housebrand',
				notes: 'Keeps for months.'
			}),
			'edit'
		).record;
		expect(saved).toMatchObject({
			name: 'Rolled oats',
			aisle: 'Baking',
			category: 'Dry goods',
			store: 'Corner shop',
			isStaple: true,
			quantity: '1 bag',
			preferredBrand: 'Housebrand',
			notes: 'Keeps for months.'
		});

		const cleared = ok(
			await updateIngredient(sql, viewer, oats.id, { notes: '' }),
			'clear notes'
		).record;
		expect(cleared).toMatchObject({ notes: null, store: 'Corner shop', isStaple: true });
	});

	it('refuses a save from a stale version', async () => {
		const oats = await ingredient('Rolled oats');
		const stale = oats.updatedAt;
		ok(await updateIngredient(sql, viewer, oats.id, { store: 'Shop A' }, stale), 'first');

		const second = await updateIngredient(sql, viewer, oats.id, { store: 'Shop B' }, stale);
		expect(second).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('archives and restores, leaving the live pantry list', async () => {
		const oats = await ingredient('Rolled oats');
		ok(await setIngredientArchived(sql, viewer, oats.id, true), 'archive');

		expect(await listIngredients(sql, viewer, { search: 'oats' })).toEqual([]);
		expect(
			(await listIngredients(sql, viewer, { search: 'oats', includeArchived: true }))[0]?.archivedAt
		).not.toBeNull();

		ok(await setIngredientArchived(sql, viewer, oats.id, false), 'restore');
		expect((await listIngredients(sql, viewer, { search: 'oats' }))[0]?.archivedAt).toBeNull();
	});

	it('never archives another household’s ingredient', async () => {
		const theirs = await ingredient('Not ours', {}, elsewhere);
		expect(await setIngredientArchived(sql, viewer, theirs.id, true)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});
});

// ─── structured quantity on an ingredient ───────────────────────────────────

describe('an ingredient’s structured quantity', () => {
	it('is null until someone sets one, and prefers pairing the two fields', async () => {
		const plain = await ingredient('Rolled oats', { quantity: '1 bag' });
		expect(plain).toMatchObject({ quantity: '1 bag', quantityValue: null, quantityUnit: null });

		const measured = ok(
			await createIngredient(sql, viewer, {
				name: 'Cheddar',
				quantityValue: '500',
				quantityUnit: 'g'
			}),
			'create with a structured quantity'
		).record;
		expect(measured).toMatchObject({ quantityValue: 500, quantityUnit: 'g' });
	});

	it('refuses a number with no unit, and a unit not on the list', async () => {
		expect(
			await createIngredient(sql, viewer, { name: 'Cheddar', quantityValue: '500' })
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect(
			await createIngredient(sql, viewer, {
				name: 'Cheddar',
				quantityValue: '500',
				quantityUnit: 'stone'
			})
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses zero and a negative amount', async () => {
		for (const bad of ['0', '-2']) {
			expect(
				await createIngredient(sql, viewer, {
					name: 'Cheddar',
					quantityValue: bad,
					quantityUnit: 'g'
				})
			).toMatchObject({ ok: false, reason: 'invalid' });
		}
	});

	it('clears the unit when the value is cleared, even if a unit is still sent', async () => {
		const cheese = await ingredient('Cheddar', { quantityValue: '500', quantityUnit: 'g' });
		const cleared = ok(
			await updateIngredient(sql, viewer, cheese.id, { quantityValue: '', quantityUnit: 'kg' }),
			'clear the amount'
		).record;
		expect(cleared).toMatchObject({ quantityValue: null, quantityUnit: null });
	});

	it('keeps the stored unit when an unrelated edit does not mention the quantity', async () => {
		const cheese = await ingredient('Cheddar', { quantityValue: '500', quantityUnit: 'g' });
		const saved = ok(
			await updateIngredient(sql, viewer, cheese.id, { store: 'Corner shop' }),
			'unrelated edit'
		).record;
		expect(saved).toMatchObject({ quantityValue: 500, quantityUnit: 'g', store: 'Corner shop' });
	});

	it('requires a fresh unit for a value that changed', async () => {
		const cheese = await ingredient('Cheddar', { quantityValue: '500', quantityUnit: 'g' });
		expect(await updateIngredient(sql, viewer, cheese.id, { quantityValue: '1' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});

		const changed = ok(
			await updateIngredient(sql, viewer, cheese.id, { quantityValue: '1', quantityUnit: 'kg' }),
			'change with a unit'
		).record;
		expect(changed).toMatchObject({ quantityValue: 1, quantityUnit: 'kg' });
	});

	it('is enforced by the table itself, not only by this module', async () => {
		const insert = (value: number | null, unit: string) => sql`
			insert into ingredients (household_id, name, quantity_value, quantity_unit)
			values (${viewer.householdId}::uuid, 'Raw insert', ${value}, ${unit})
		`;
		await expect(insert(null, 'g')).rejects.toThrow(/quantity_unit_needs_value/);
		await expect(insert(500, 'stone')).rejects.toThrow(/quantity_unit_check/);
		await expect(sql`
			insert into ingredients (household_id, name, quantity_value)
			values (${viewer.householdId}::uuid, 'Raw insert 2', 0)
		`).rejects.toThrow(/quantity_value_check/);
	});
});

// ─── attaching, detaching, and structured amounts on the pairing ───────────

describe('a recipe’s ingredients', () => {
	it('attaches with a structured amount, and prefers it over the text on display', async () => {
		const soup = await recipe('Soup');
		const broccoli = await ingredient('Broccoli');

		ok(
			await addRecipeIngredient(sql, viewer, soup.id, broccoli.id, {
				text: '1 head, chopped',
				value: '250',
				unit: 'g'
			}),
			'attach with a structured amount'
		);
		const [linked] = await ingredientsForRecipe(sql, viewer, soup.id);
		expect(linked).toMatchObject({ amount: '1 head, chopped', amountValue: 250, amountUnit: 'g' });
	});

	it('changes the amount by attaching again — the pairing has one primary key', async () => {
		const soup = await recipe('Soup');
		const broccoli = await ingredient('Broccoli');
		ok(await addRecipeIngredient(sql, viewer, soup.id, broccoli.id, '1 head'), 'first attach');

		ok(
			await addRecipeIngredient(sql, viewer, soup.id, broccoli.id, {
				value: '2',
				unit: 'piece'
			}),
			'change the amount'
		);
		const [linked] = await ingredientsForRecipe(sql, viewer, soup.id);
		// The free-text amount was not sent this time, and the whole amount is
		// replaced rather than merged field by field — the same "send the whole
		// thing" contract createIngredient and updateRecipe already use.
		expect(linked).toMatchObject({ amount: null, amountValue: 2, amountUnit: 'piece' });

		const parts = await ingredientsForRecipe(sql, viewer, soup.id);
		expect(parts).toHaveLength(1);
	});

	it('refuses an amount with no unit, and one that is not greater than zero', async () => {
		const soup = await recipe('Soup');
		const broccoli = await ingredient('Broccoli');
		expect(
			await addRecipeIngredient(sql, viewer, soup.id, broccoli.id, { value: '2' })
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect(
			await addRecipeIngredient(sql, viewer, soup.id, broccoli.id, { value: '0', unit: 'g' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('detaches an ingredient, leaving the rest of the recipe alone', async () => {
		const soup = await recipe('Soup');
		const broccoli = await ingredient('Broccoli');
		const cheddar = await ingredient('Cheddar');
		ok(await addRecipeIngredient(sql, viewer, soup.id, broccoli.id), 'attach broccoli');
		ok(await addRecipeIngredient(sql, viewer, soup.id, cheddar.id), 'attach cheddar');

		ok(await removeRecipeIngredient(sql, viewer, soup.id, broccoli.id), 'detach');
		const left = await ingredientsForRecipe(sql, viewer, soup.id);
		expect(left.map((p) => p.ingredient.name)).toEqual(['Cheddar']);

		// The ingredient itself is untouched — only the pairing is gone.
		expect(await listIngredients(sql, viewer, { search: 'broccoli' })).toHaveLength(1);
	});

	it('refuses to detach from a recipe that is not the viewer’s to write', async () => {
		const soup = await recipe('Soup');
		const broccoli = await ingredient('Broccoli');
		ok(await addRecipeIngredient(sql, viewer, soup.id, broccoli.id), 'attach');

		expect(await removeRecipeIngredient(sql, elsewhere, soup.id, broccoli.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(await ingredientsForRecipe(sql, viewer, soup.id)).toHaveLength(1);
	});

	it('creates a new ingredient and attaches it in one transaction', async () => {
		const soup = await recipe('Soup');
		const result = ok(
			await attachNewIngredientToRecipe(
				sql,
				viewer,
				soup.id,
				{ name: 'Fresh basil', aisle: 'Produce' },
				{ text: 'a handful' }
			),
			'create and attach'
		).record;

		const [linked] = await ingredientsForRecipe(sql, viewer, soup.id);
		expect(linked?.ingredient).toMatchObject({ id: result.ingredientId, name: 'Fresh basil' });
		expect(linked?.amount).toBe('a handful');
		// It is a real, ordinary ingredient afterwards — findable and editable
		// like any other, not a special "recipe-only" record.
		expect(await listIngredients(sql, viewer, { search: 'basil' })).toHaveLength(1);
	});

	it('leaves no orphan ingredient when the attach half fails', async () => {
		const theirs = await recipe('Not ours', {}, elsewhere);
		const before = await listIngredients(sql, viewer, { search: 'orphan' });
		expect(before).toEqual([]);

		// The recipe belongs to another household, so the attach half of the
		// transaction is refused — and the create half must not have kept its
		// insert either, or a search would find an ingredient nothing calls for.
		expect(
			await attachNewIngredientToRecipe(sql, viewer, theirs.id, { name: 'Orphan basil' })
		).toMatchObject({ ok: false, reason: 'not_found' });
		expect(await listIngredients(sql, viewer, { search: 'orphan' })).toEqual([]);
	});

	it('refuses to attach a new ingredient whose name already exists', async () => {
		const soup = await recipe('Soup');
		await ingredient('Basil');
		expect(
			await attachNewIngredientToRecipe(sql, viewer, soup.id, { name: 'Basil' })
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await ingredientsForRecipe(sql, viewer, soup.id)).toEqual([]);
	});

	it('is enforced by the table itself, not only by this module', async () => {
		const soup = await recipe('Soup');
		const broccoli = await ingredient('Broccoli');
		await expect(sql`
			insert into recipe_ingredients (recipe_id, ingredient_id, amount_unit)
			values (${soup.id}::uuid, ${broccoli.id}::uuid, 'g')
		`).rejects.toThrow(/amount_unit_needs_value/);
		await expect(sql`
			insert into recipe_ingredients (recipe_id, ingredient_id, amount_value, amount_unit)
			values (${soup.id}::uuid, ${broccoli.id}::uuid, 250, 'stone')
		`).rejects.toThrow(/amount_unit_check/);
	});
});

// ─── through a client configured the way the app’s is ──────────────────────

describe('through a client configured the way the app’s is', () => {
	it('creates and edits an ingredient, and attaches it to a recipe', async () => {
		// `$lib/server/db` hands its client to drizzle(), which replaces the
		// driver's timestamp serializers with pass-throughs — a JS Date sent as
		// a parameter then reaches the wire unconverted and throws (see the
		// same block at the end of health-measurements.test.ts). Every write
		// path this file exercises passes `expectedUpdatedAt` as a real Date,
		// the way a route handler does with `ingredient.updatedAt`, so it is
		// proven here rather than only against the plain client above.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createIngredient(appLike, viewer, {
					name: 'Cheddar',
					quantityValue: '500',
					quantityUnit: 'g'
				}),
				'create through the app-like client'
			).record;
			const edited = ok(
				await updateIngredient(
					appLike,
					viewer,
					created.id,
					{ quantityValue: '1', quantityUnit: 'kg' },
					created.updatedAt
				),
				'edit through the app-like client'
			).record;
			expect(edited).toMatchObject({ quantityValue: 1, quantityUnit: 'kg' });

			const soup = ok(
				await createRecipe(appLike, viewer, { name: 'Soup' }),
				'create recipe through the app-like client'
			).record;
			ok(
				await addRecipeIngredient(appLike, viewer, soup.id, edited.id, {
					value: '250',
					unit: 'g'
				}),
				'attach through the app-like client'
			);
			const [linked] = await ingredientsForRecipe(appLike, viewer, soup.id);
			expect(linked).toMatchObject({ amountValue: 250, amountUnit: 'g' });
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
