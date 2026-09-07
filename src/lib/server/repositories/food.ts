import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	InvalidInput,
	baseColumns,
	getScoped,
	guarded,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toBool,
	toDay,
	toDayOrNull,
	toInt,
	toIntOrNull,
	toNumberOrNull,
	toText,
	toTextOrNull,
	writableBy,
	writableScope,
	writeScoped,
	type BaseRow,
	type OwnershipInput,
	type PageOptions,
	type Queryable,
	type RecordBase,
	type WriteResult
} from './base';
import { optionalText, patched, requiredText } from './validate';

/**
 * Food HQ (MODEL-002, feature pack 2).
 *
 * Three things joined: what is in the house, what can be made from it, and
 * what is planned for which day. The shopping list is not a separate list —
 * it is the ingredients whose status says so, which is how the source works
 * and why a "buy this" never drifts out of sync with the pantry.
 *
 * Everything here is household-scoped rather than personal. Dinner is a
 * household fact, unlike a journal entry.
 */

// ─── ingredients ───────────────────────────────────────────────────────────

export const INGREDIENT_STATUSES = ['in_stock', 'shopping_list', 'use_up', 'not_needed'] as const;
export type IngredientStatus = (typeof INGREDIENT_STATUSES)[number];

export interface Ingredient extends RecordBase {
	name: string;
	aisle: string | null;
	category: string | null;
	status: IngredientStatus;
	isStaple: boolean;
	store: string | null;
	quantity: string | null;
	preferredBrand: string | null;
	notes: string | null;
}

interface IngredientRow extends BaseRow {
	name: string;
	aisle: string | null;
	category: string | null;
	status: string;
	is_staple: unknown;
	store: string | null;
	quantity: string | null;
	preferred_brand: string | null;
	notes: string | null;
}

const INGREDIENTS = 'ingredients';

const ingredientColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, aisle, category, status, is_staple, store, quantity, preferred_brand, notes`;

const mapIngredient = (row: IngredientRow): Ingredient => ({
	...mapBase(row),
	name: toText(row.name),
	aisle: toTextOrNull(row.aisle),
	category: toTextOrNull(row.category),
	status: row.status as IngredientStatus,
	isStaple: toBool(row.is_staple),
	store: toTextOrNull(row.store),
	quantity: toTextOrNull(row.quantity),
	preferredBrand: toTextOrNull(row.preferred_brand),
	notes: toTextOrNull(row.notes)
});

export interface IngredientFilters extends PageOptions {
	status?: IngredientStatus | readonly IngredientStatus[];
	aisle?: string;
	search?: string;
	staplesOnly?: boolean;
	includeArchived?: boolean;
	order?: 'name' | 'aisle';
}

export async function listIngredients(
	sql: Queryable,
	viewer: Viewer,
	filters: IngredientFilters = {}
): Promise<Ingredient[]> {
	const { limit, offset } = pageOf(filters);
	const statuses = filters.status
		? Array.isArray(filters.status)
			? filters.status
			: [filters.status as IngredientStatus]
		: null;

	const rows = await sql<IngredientRow[]>`
		select ${ingredientColumns(sql)} from ${sql(INGREDIENTS)}
		where ${readableScope(sql, viewer, INGREDIENTS)}
		  and ${liveScope(sql, INGREDIENTS, filters.includeArchived)}
		  ${statuses ? sql`and status in ${sql([...statuses])}` : sql``}
		  ${filters.aisle ? sql`and aisle = ${filters.aisle}` : sql``}
		  ${filters.staplesOnly ? sql`and is_staple` : sql``}
		  ${filters.search ? sql`and name ilike ${'%' + filters.search.trim() + '%'}` : sql``}
		order by ${filters.order === 'aisle' ? sql`aisle asc nulls last, name asc` : sql`name asc`}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapIngredient);
}

export interface IngredientInput extends OwnershipInput {
	name?: unknown;
	aisle?: unknown;
	category?: unknown;
	status?: unknown;
	isStaple?: unknown;
	store?: unknown;
	quantity?: unknown;
	preferredBrand?: unknown;
	notes?: unknown;
}

function ingredientStatus(value: unknown, fallback: IngredientStatus): IngredientStatus {
	if (value === undefined || value === null || value === '') return fallback;
	const status = String(value).trim().toLowerCase();
	if (!INGREDIENT_STATUSES.includes(status as IngredientStatus)) {
		throw new InvalidInput(`status must be one of ${INGREDIENT_STATUSES.join(', ')}`);
	}
	return status as IngredientStatus;
}

export function createIngredient(
	sql: Queryable,
	viewer: Viewer,
	input: IngredientInput
): Promise<WriteResult<Ingredient>> {
	return guarded<Ingredient>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		// Conditional rather than a unique index: the database no longer
		// forbids two ingredients with the same name, because the source has
		// them and a constraint there aborts an entire import (migration 0016).
		// Someone typing a duplicate should still be told, and the NOT EXISTS
		// keeps that decision inside one statement.
		const rows = await sql<IngredientRow[]>`
			insert into ${sql(INGREDIENTS)} (
				household_id, owner_user_id, visibility, name, aisle, category, status,
				is_staple, store, quantity, preferred_brand, notes, created_by, updated_by
			)
			select ${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${optionalText(input.aisle, 'aisle')}, ${optionalText(input.category, 'category')},
				${ingredientStatus(input.status, 'in_stock')},
				${input.isStaple === true || input.isStaple === 'on'}::boolean,
				${optionalText(input.store, 'store')}, ${optionalText(input.quantity, 'quantity')},
				${optionalText(input.preferredBrand, 'preferred brand')},
				${optionalText(input.notes, 'notes')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			where not exists (
				select 1 from ${sql(INGREDIENTS)} existing
				where existing.household_id = ${viewer.householdId}::uuid
				  and lower(trim(existing.name)) = lower(trim(${name}))
				  and existing.archived_at is null
			)
			returning ${ingredientColumns(sql)}
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'invalid', message: 'that ingredient already exists' };
		return { ok: true, record: mapIngredient(row) };
	});
}

export function updateIngredient(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: IngredientInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Ingredient>> {
	return guarded<Ingredient>(async () => {
		const row = await getScoped<IngredientRow>(
			sql,
			INGREDIENTS,
			id,
			readableScope(sql, viewer, INGREDIENTS),
			ingredientColumns(sql)
		);
		if (!row) return { ok: false, reason: 'not_found' };
		const current = mapIngredient(row);

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			aisle: patched(patch, 'aisle', current.aisle, (v) => optionalText(v, 'aisle')),
			category: patched(patch, 'category', current.category, (v) => optionalText(v, 'category')),
			status: patched(patch, 'status', current.status, (v) => ingredientStatus(v, current.status)),
			isStaple: patched(patch, 'isStaple', current.isStaple, (v) => v === true || v === 'on'),
			store: patched(patch, 'store', current.store, (v) => optionalText(v, 'store')),
			quantity: patched(patch, 'quantity', current.quantity, (v) => optionalText(v, 'quantity')),
			preferredBrand: patched(patch, 'preferredBrand', current.preferredBrand, (v) =>
				optionalText(v, 'preferred brand')
			),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};

		return writeScoped<IngredientRow, Ingredient>({
			sql,
			table: INGREDIENTS,
			id,
			readScope: readableScope(sql, viewer, INGREDIENTS),
			writeScope: writableScope(sql, viewer, INGREDIENTS),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				name = ${next.name}, aisle = ${next.aisle}, category = ${next.category},
				status = ${next.status}, is_staple = ${next.isStaple}::boolean,
				store = ${next.store}, quantity = ${next.quantity},
				preferred_brand = ${next.preferredBrand}, notes = ${next.notes},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: ingredientColumns(sql),
			map: mapIngredient,
			mayWrite: writableBy(viewer)
		});
	});
}

/** Aisles in use, so the shopping list can be walked in shop order. */
export async function ingredientAisles(sql: Queryable, viewer: Viewer): Promise<string[]> {
	const rows = await sql<{ aisle: string }[]>`
		select distinct aisle from ${sql(INGREDIENTS)}
		where ${readableScope(sql, viewer, INGREDIENTS)}
		  and archived_at is null and aisle is not null
		order by aisle asc
	`;
	return rows.map((r) => toText(r.aisle));
}

export async function ingredientStatusCounts(
	sql: Queryable,
	viewer: Viewer
): Promise<Record<IngredientStatus, number>> {
	const rows = await sql<{ status: string; total: number }[]>`
		select status, count(*)::int as total from ${sql(INGREDIENTS)}
		where ${readableScope(sql, viewer, INGREDIENTS)} and archived_at is null
		group by status
	`;
	const counts = Object.fromEntries(INGREDIENT_STATUSES.map((s) => [s, 0])) as Record<
		IngredientStatus,
		number
	>;
	for (const row of rows) counts[row.status as IngredientStatus] = Number(row.total);
	return counts;
}

// ─── recipes ───────────────────────────────────────────────────────────────

export interface Recipe extends RecordBase {
	name: string;
	notes: string | null;
	url: string | null;
	servings: number | null;
	prepMinutes: number | null;
	cookMinutes: number | null;
	additionalMinutes: number | null;
	/** prep + cook + additional, or null when none of them is known. */
	totalMinutes: number | null;
	kcalPerServing: number | null;
	proteinG: number | null;
	carbsG: number | null;
	fibreG: number | null;
	sugarG: number | null;
	totalFatG: number | null;
	sodiumMg: number | null;
	courses: string[];
	seasons: string[];
	cuisine: string | null;
	occasion: string | null;
	effort: string | null;
	sourceType: string | null;
	status: string | null;
	isFavourite: boolean;
	lastMadeOn: string | null;
}

interface RecipeRow extends BaseRow {
	name: string;
	notes: string | null;
	url: string | null;
	servings: unknown;
	prep_minutes: unknown;
	cook_minutes: unknown;
	additional_minutes: unknown;
	kcal_per_serving: unknown;
	protein_g: unknown;
	carbs_g: unknown;
	fibre_g: unknown;
	sugar_g: unknown;
	total_fat_g: unknown;
	sodium_mg: unknown;
	courses: unknown;
	seasons: unknown;
	cuisine: string | null;
	occasion: string | null;
	effort: string | null;
	source_type: string | null;
	status: string | null;
	is_favourite: unknown;
	last_made_on: string | null;
}

const RECIPES = 'recipes';

const recipeColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, notes, url, servings, prep_minutes, cook_minutes, additional_minutes,
	kcal_per_serving, protein_g, carbs_g, fibre_g, sugar_g, total_fat_g, sodium_mg,
	courses, seasons, cuisine, occasion, effort, source_type, status, is_favourite,
	last_made_on::text as last_made_on`;

/** `text[]` arrives as an array under this driver; anything else is empty. */
const toStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.map((v) => String(v)) : [];

function mapRecipe(row: RecipeRow): Recipe {
	const prep = toIntOrNull(row.prep_minutes);
	const cook = toIntOrNull(row.cook_minutes);
	const extra = toIntOrNull(row.additional_minutes);
	const parts = [prep, cook, extra].filter((n): n is number => n !== null);

	return {
		...mapBase(row),
		name: toText(row.name),
		notes: toTextOrNull(row.notes),
		url: toTextOrNull(row.url),
		servings: toIntOrNull(row.servings),
		prepMinutes: prep,
		cookMinutes: cook,
		additionalMinutes: extra,
		// Derived rather than stored: a stored total goes stale the moment one
		// of its parts is edited.
		totalMinutes: parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null,
		kcalPerServing: toNumberOrNull(row.kcal_per_serving),
		proteinG: toNumberOrNull(row.protein_g),
		carbsG: toNumberOrNull(row.carbs_g),
		fibreG: toNumberOrNull(row.fibre_g),
		sugarG: toNumberOrNull(row.sugar_g),
		totalFatG: toNumberOrNull(row.total_fat_g),
		sodiumMg: toNumberOrNull(row.sodium_mg),
		courses: toStringArray(row.courses),
		seasons: toStringArray(row.seasons),
		cuisine: toTextOrNull(row.cuisine),
		occasion: toTextOrNull(row.occasion),
		effort: toTextOrNull(row.effort),
		sourceType: toTextOrNull(row.source_type),
		status: toTextOrNull(row.status),
		isFavourite: toBool(row.is_favourite),
		lastMadeOn: toDayOrNull(row.last_made_on)
	};
}

export interface RecipeFilters extends PageOptions {
	course?: string;
	season?: string;
	search?: string;
	favouritesOnly?: boolean;
	includeArchived?: boolean;
	order?: 'name' | 'recent';
}

export async function listRecipes(
	sql: Queryable,
	viewer: Viewer,
	filters: RecipeFilters = {}
): Promise<Recipe[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<RecipeRow[]>`
		select ${recipeColumns(sql)} from ${sql(RECIPES)}
		where ${readableScope(sql, viewer, RECIPES)}
		  and ${liveScope(sql, RECIPES, filters.includeArchived)}
		  ${filters.course ? sql`and ${filters.course} = any(courses)` : sql``}
		  ${filters.season ? sql`and ${filters.season} = any(seasons)` : sql``}
		  ${filters.favouritesOnly ? sql`and is_favourite` : sql``}
		  ${filters.search ? sql`and name ilike ${'%' + filters.search.trim() + '%'}` : sql``}
		order by ${filters.order === 'recent' ? sql`last_made_on desc nulls last, name asc` : sql`name asc`}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapRecipe);
}

export async function getRecipe(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<Recipe | null> {
	const row = await getScoped<RecipeRow>(
		sql,
		RECIPES,
		id,
		readableScope(sql, viewer, RECIPES),
		recipeColumns(sql)
	);
	return row ? mapRecipe(row) : null;
}

export interface RecipeInput extends OwnershipInput {
	name?: unknown;
	notes?: unknown;
	url?: unknown;
	servings?: unknown;
	prepMinutes?: unknown;
	cookMinutes?: unknown;
	additionalMinutes?: unknown;
	courses?: unknown;
	seasons?: unknown;
	cuisine?: unknown;
	isFavourite?: unknown;
}

const toArrayInput = (value: unknown): string[] => {
	if (value === undefined || value === null || value === '') return [];
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	// "Breakfast, Snacks" is how the source spells a multi-select.
	return String(value)
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
};

export function createRecipe(
	sql: Queryable,
	viewer: Viewer,
	input: RecipeInput
): Promise<WriteResult<Recipe>> {
	return guarded<Recipe>(async () => {
		const name = requiredText(input.name, 'name', 300);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		const rows = await sql<RecipeRow[]>`
			insert into ${sql(RECIPES)} (
				household_id, owner_user_id, visibility, name, notes, url, servings,
				prep_minutes, cook_minutes, additional_minutes, courses, seasons,
				cuisine, is_favourite, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${optionalText(input.notes, 'notes')}, ${optionalText(input.url, 'url')},
				${toIntOrNull(input.servings ?? null)}::int,
				${toIntOrNull(input.prepMinutes ?? null)}::int,
				${toIntOrNull(input.cookMinutes ?? null)}::int,
				${toIntOrNull(input.additionalMinutes ?? null)}::int,
				${toArrayInput(input.courses)}::text[], ${toArrayInput(input.seasons)}::text[],
				${optionalText(input.cuisine, 'cuisine')},
				${input.isFavourite === true || input.isFavourite === 'on'}::boolean,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${recipeColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapRecipe(row) };
	});
}

/** The ingredients a recipe calls for. */
export async function ingredientsForRecipe(
	sql: Queryable,
	viewer: Viewer,
	recipeId: string
): Promise<{ ingredient: Ingredient; amount: string | null }[]> {
	if (!isUuid(recipeId)) return [];
	// Only `ingredients` and the link table are in the FROM, so the unqualified
	// column list from `baseColumns` stays unambiguous — joining `recipes` here
	// as well would make every `id` a syntax error. The recipe's own scope is
	// checked with EXISTS instead.
	const rows = await sql<(IngredientRow & { amount: string | null })[]>`
		select ${ingredientColumns(sql)}, ri.amount
		from ${sql(INGREDIENTS)}
		join recipe_ingredients ri on ri.ingredient_id = ${sql(INGREDIENTS)}.id
		where ri.recipe_id = ${recipeId}::uuid
		  and ${readableScope(sql, viewer, INGREDIENTS)}
		  and exists (
			select 1 from ${sql(RECIPES)} r
			where r.id = ri.recipe_id and ${readableScope(sql, viewer, 'r')}
		  )
		order by ${sql(INGREDIENTS)}.name asc
	`;
	return rows.map((row) => ({ ingredient: mapIngredient(row), amount: row.amount }));
}

export async function addRecipeIngredient(
	sql: Queryable,
	viewer: Viewer,
	recipeId: string,
	ingredientId: string,
	amount?: string | null
): Promise<WriteResult<{ recipeId: string; ingredientId: string }>> {
	if (!isUuid(recipeId) || !isUuid(ingredientId)) return { ok: false, reason: 'not_found' };

	// Both sides are checked in the statement, so a caller cannot attach an
	// ingredient from another household by guessing an id.
	const rows = await sql<{ recipe_id: string }[]>`
		insert into recipe_ingredients (recipe_id, ingredient_id, amount)
		select r.id, i.id, ${amount ?? null}
		from ${sql(RECIPES)} r, ${sql(INGREDIENTS)} i
		where r.id = ${recipeId}::uuid and ${writableScope(sql, viewer, 'r')}
		  and i.id = ${ingredientId}::uuid and ${readableScope(sql, viewer, 'i')}
		on conflict (recipe_id, ingredient_id) do update set amount = excluded.amount
		returning recipe_id
	`;
	if (!rows[0]) return { ok: false, reason: 'not_found' };
	return { ok: true, record: { recipeId, ingredientId } };
}

// ─── the plan ──────────────────────────────────────────────────────────────

export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

export interface PlannedMeal {
	slot: MealSlot;
	recipeId: string;
	recipeName: string;
}

export interface MealPlanDay {
	id: string;
	onDate: string;
	name: string | null;
	notes: string | null;
	meals: PlannedMeal[];
}

/** The plan across a date window, with what is on each day. */
export async function mealPlan(
	sql: Queryable,
	viewer: Viewer,
	from: string,
	to: string
): Promise<MealPlanDay[]> {
	const rows = await sql<
		{
			id: string;
			on_date: string;
			name: string | null;
			notes: string | null;
			slot: string | null;
			recipe_id: string | null;
			recipe_name: string | null;
		}[]
	>`
		select p.id, p.on_date::text as on_date, p.name, p.notes,
		       m.slot, m.recipe_id, r.name as recipe_name
		from meal_plans p
		left join meal_plan_recipes m on m.meal_plan_id = p.id
		left join recipes r on r.id = m.recipe_id
		where ${readableScope(sql, viewer, 'p')}
		  and p.archived_at is null
		  and p.on_date between ${from}::date and ${to}::date
		order by p.on_date asc, m.slot asc, r.name asc
	`;

	const byDay = new Map<string, MealPlanDay>();
	for (const row of rows) {
		let day = byDay.get(row.id);
		if (!day) {
			day = {
				id: row.id,
				onDate: toDay(row.on_date),
				name: toTextOrNull(row.name),
				notes: toTextOrNull(row.notes),
				meals: []
			};
			byDay.set(row.id, day);
		}
		if (row.slot && row.recipe_id && row.recipe_name) {
			day.meals.push({
				slot: row.slot as MealSlot,
				recipeId: row.recipe_id,
				recipeName: toText(row.recipe_name)
			});
		}
	}
	return [...byDay.values()];
}

export async function planMeal(
	sql: Queryable,
	viewer: Viewer,
	onDate: string,
	slot: MealSlot,
	recipeId: string
): Promise<WriteResult<{ mealPlanId: string }>> {
	if (!isUuid(recipeId)) return { ok: false, reason: 'not_found' };
	if (!MEAL_SLOTS.includes(slot)) return { ok: false, reason: 'invalid', message: 'unknown slot' };

	return guarded(async () => {
		// The day is created on demand: planning a dinner should not require
		// first creating an empty menu for the date.
		const [plan] = await sql<{ id: string }[]>`
			insert into meal_plans (household_id, on_date, created_by, updated_by)
			values (${viewer.householdId}::uuid, ${onDate}::date, ${viewer.userId}::uuid,
			        ${viewer.userId}::uuid)
			on conflict (household_id, on_date) do update set updated_at = now()
			returning id
		`;
		if (!plan) return { ok: false, reason: 'invalid', message: 'could not open that day' };

		const rows = await sql<{ meal_plan_id: string }[]>`
			insert into meal_plan_recipes (meal_plan_id, recipe_id, slot)
			select ${plan.id}::uuid, r.id, ${slot}
			from recipes r
			where r.id = ${recipeId}::uuid and ${readableScope(sql, viewer, 'r')}
			on conflict do nothing
			returning meal_plan_id
		`;
		// No row means either the recipe is unreachable or it was already
		// planned; the second is not a failure.
		if (!rows[0]) {
			const [existing] = await sql<{ count: number }[]>`
				select count(*)::int as count from meal_plan_recipes
				where meal_plan_id = ${plan.id}::uuid and recipe_id = ${recipeId}::uuid and slot = ${slot}
			`;
			if (!existing?.count) return { ok: false, reason: 'not_found' };
		}
		return { ok: true, record: { mealPlanId: plan.id } };
	});
}

export async function unplanMeal(
	sql: Queryable,
	viewer: Viewer,
	mealPlanId: string,
	slot: MealSlot,
	recipeId: string
): Promise<WriteResult<{ mealPlanId: string }>> {
	if (!isUuid(mealPlanId) || !isUuid(recipeId)) return { ok: false, reason: 'not_found' };

	const rows = await sql<{ meal_plan_id: string }[]>`
		delete from meal_plan_recipes m
		using meal_plans p
		where m.meal_plan_id = p.id
		  and m.meal_plan_id = ${mealPlanId}::uuid
		  and m.recipe_id = ${recipeId}::uuid
		  and m.slot = ${slot}
		  and ${writableScope(sql, viewer, 'p')}
		returning m.meal_plan_id
	`;
	if (!rows[0]) return { ok: false, reason: 'not_found' };
	return { ok: true, record: { mealPlanId } };
}

// ─── prep ──────────────────────────────────────────────────────────────────

export const PREP_WHEN = ['batch_prep', 'night_before', 'before_cooking'] as const;
export type PrepWhen = (typeof PREP_WHEN)[number];

export interface PrepTask extends RecordBase {
	name: string;
	isDone: boolean;
	whenToDo: PrepWhen | null;
	recipeId: string | null;
	notes: string | null;
}

interface PrepTaskRow extends BaseRow {
	name: string;
	is_done: unknown;
	when_to_do: string | null;
	recipe_id: string | null;
	notes: string | null;
}

const PREP = 'prep_tasks';

const prepColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, is_done, when_to_do, recipe_id, notes`;

const mapPrep = (row: PrepTaskRow): PrepTask => ({
	...mapBase(row),
	name: toText(row.name),
	isDone: toBool(row.is_done),
	whenToDo: (row.when_to_do as PrepWhen | null) ?? null,
	recipeId: row.recipe_id,
	notes: toTextOrNull(row.notes)
});

export async function listPrepTasks(
	sql: Queryable,
	viewer: Viewer,
	filters: { openOnly?: boolean; includeArchived?: boolean } & PageOptions = {}
): Promise<PrepTask[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<PrepTaskRow[]>`
		select ${prepColumns(sql)} from ${sql(PREP)}
		where ${readableScope(sql, viewer, PREP)}
		  and ${liveScope(sql, PREP, filters.includeArchived)}
		  ${filters.openOnly ? sql`and not is_done` : sql``}
		order by is_done asc, name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapPrep);
}

export function setPrepTaskDone(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	done: boolean
): Promise<WriteResult<PrepTask>> {
	return guarded<PrepTask>(async () =>
		writeScoped<PrepTaskRow, PrepTask>({
			sql,
			table: PREP,
			id,
			readScope: readableScope(sql, viewer, PREP),
			writeScope: writableScope(sql, viewer, PREP),
			assignments: sql`
				is_done = ${done}::boolean, updated_at = now(),
				updated_by = ${viewer.userId}::uuid`,
			columns: prepColumns(sql),
			map: mapPrep,
			mayWrite: writableBy(viewer)
		})
	);
}

/** Counts for the page header, in one round trip. */
export async function foodSummary(
	sql: Queryable,
	viewer: Viewer
): Promise<{ recipes: number; shoppingList: number; openPrep: number }> {
	const [row] = await sql<{ recipes: number; shopping: number; prep: number }[]>`
		select
			(select count(*)::int from recipes r
			 where ${readableScope(sql, viewer, 'r')} and r.archived_at is null) as recipes,
			(select count(*)::int from ingredients i
			 where ${readableScope(sql, viewer, 'i')} and i.archived_at is null
			   and i.status = 'shopping_list') as shopping,
			(select count(*)::int from prep_tasks p
			 where ${readableScope(sql, viewer, 'p')} and p.archived_at is null
			   and not p.is_done) as prep
	`;
	return {
		recipes: toInt(row?.recipes ?? 0),
		shoppingList: toInt(row?.shopping ?? 0),
		openPrep: toInt(row?.prep ?? 0)
	};
}
