import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate } from '../db/coerce';
import { MEAL_SLOTS, type MealSlot } from './food';
import { isDay, nextPeriod, periodKey, previousPeriod } from './dates';
import {
	InvalidInput,
	archiveScoped,
	atomically,
	baseColumns,
	getScoped,
	guarded,
	householdToday,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toBool,
	toDay,
	toNumberOrNull,
	toText,
	toTextOrNull,
	toVisibility,
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
import {
	oneOf,
	optionalId,
	optionalNumber,
	optionalText,
	patched,
	requiredDay,
	requiredText
} from './validate';

/**
 * Food log (nutrition) (MODEL-002, feature pack; migration 0032).
 *
 * Food HQ's Notion export held two databases this app had not carried over:
 * Food Library (`foods`, nutrients per serving) and Food Log
 * (`food_log_entries`, what was eaten, when, how much), with a monthly
 * rollup tracking protein totals (`proteinByMonth` below). There is no
 * importer for either — the household re-enters this by hand — so every
 * write here goes through the same validation and authorization a hand-typed
 * form exercises, with no backfilled rows to special-case.
 *
 * `foods` is shaped like `recipes` (migration 0012) — household-scoped,
 * shared by default, `archived_at` and all — and uses `base.ts`'s ordinary
 * `baseColumns`/`mapBase`. `food_log_entries` is shaped like
 * `health_measurements` (migration 0019) — owned, private by default — but
 * has no `archived_at` (see migration 0032's own comment), so it carries its
 * own column list and mapper rather than the shared ones.
 */

// ─── foods ───────────────────────────────────────────────────────────────

export interface Food extends RecordBase {
	name: string;
	brand: string | null;
	serving: string | null;
	kcalPerServing: number | null;
	proteinG: number | null;
	carbsG: number | null;
	fibreG: number | null;
	sugarG: number | null;
	totalFatG: number | null;
	sodiumMg: number | null;
	notes: string | null;
	isFavourite: boolean;
}

interface FoodRow extends BaseRow {
	name: string;
	brand: string | null;
	serving: string | null;
	kcal_per_serving: unknown;
	protein_g: unknown;
	carbs_g: unknown;
	fibre_g: unknown;
	sugar_g: unknown;
	total_fat_g: unknown;
	sodium_mg: unknown;
	notes: string | null;
	is_favourite: unknown;
}

const FOODS = 'foods';

const foodColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, brand, serving, kcal_per_serving, protein_g, carbs_g, fibre_g, sugar_g, total_fat_g,
	sodium_mg, notes, is_favourite`;

function mapFood(row: FoodRow): Food {
	return {
		...mapBase(row),
		name: toText(row.name),
		brand: toTextOrNull(row.brand),
		serving: toTextOrNull(row.serving),
		kcalPerServing: toNumberOrNull(row.kcal_per_serving),
		proteinG: toNumberOrNull(row.protein_g),
		carbsG: toNumberOrNull(row.carbs_g),
		fibreG: toNumberOrNull(row.fibre_g),
		sugarG: toNumberOrNull(row.sugar_g),
		totalFatG: toNumberOrNull(row.total_fat_g),
		sodiumMg: toNumberOrNull(row.sodium_mg),
		notes: toTextOrNull(row.notes),
		isFavourite: toBool(row.is_favourite)
	};
}

export interface FoodFilters extends PageOptions {
	search?: string;
	favouritesOnly?: boolean;
	includeArchived?: boolean;
}

/** Favourites first, the order the library page leads with. */
export async function listFoods(
	sql: Queryable,
	viewer: Viewer,
	filters: FoodFilters = {}
): Promise<Food[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<FoodRow[]>`
		select ${foodColumns(sql)} from ${sql(FOODS)}
		where ${readableScope(sql, viewer, FOODS)}
		  and ${liveScope(sql, FOODS, filters.includeArchived)}
		  ${filters.favouritesOnly ? sql`and is_favourite` : sql``}
		  ${filters.search ? sql`and name ilike ${'%' + filters.search.trim() + '%'}` : sql``}
		order by is_favourite desc, name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapFood);
}

export async function getFood(sql: Queryable, viewer: Viewer, id: string): Promise<Food | null> {
	const row = await getScoped<FoodRow>(
		sql,
		FOODS,
		id,
		readableScope(sql, viewer, FOODS),
		foodColumns(sql)
	);
	return row ? mapFood(row) : null;
}

export interface FoodInput extends OwnershipInput {
	name?: unknown;
	brand?: unknown;
	serving?: unknown;
	kcalPerServing?: unknown;
	proteinG?: unknown;
	carbsG?: unknown;
	fibreG?: unknown;
	sugarG?: unknown;
	totalFatG?: unknown;
	sodiumMg?: unknown;
	notes?: unknown;
	isFavourite?: unknown;
}

/** The table's own CHECKs are `>= 0`, so a negative value is refused here
 *  with a field-level message rather than surfacing as a raw constraint
 *  violation — the same shape `positive` (health-measurements.ts) applies to
 *  its own `> 0` columns. */
function nonNegative(value: unknown, field: string): number | null {
	return optionalNumber(value, field, { min: 0 });
}

interface Nutrients {
	kcalPerServing: number | null;
	proteinG: number | null;
	carbsG: number | null;
	fibreG: number | null;
	sugarG: number | null;
	totalFatG: number | null;
	sodiumMg: number | null;
}

/** Reads the seven nutrient fields from a patch, keeping whatever is stored
 *  for any field the patch does not mention. */
function nutrientsOf(input: FoodInput, current?: Nutrients): Nutrients {
	return {
		kcalPerServing: patched(input, 'kcalPerServing', current?.kcalPerServing ?? null, (v) =>
			nonNegative(v, 'calories')
		),
		proteinG: patched(input, 'proteinG', current?.proteinG ?? null, (v) =>
			nonNegative(v, 'protein')
		),
		carbsG: patched(input, 'carbsG', current?.carbsG ?? null, (v) => nonNegative(v, 'carbs')),
		fibreG: patched(input, 'fibreG', current?.fibreG ?? null, (v) => nonNegative(v, 'fibre')),
		sugarG: patched(input, 'sugarG', current?.sugarG ?? null, (v) => nonNegative(v, 'sugar')),
		totalFatG: patched(input, 'totalFatG', current?.totalFatG ?? null, (v) =>
			nonNegative(v, 'fat')
		),
		sodiumMg: patched(input, 'sodiumMg', current?.sodiumMg ?? null, (v) => nonNegative(v, 'sodium'))
	};
}

const isFavourite = (value: unknown): boolean => value === true || value === 'on';

export function createFood(
	sql: Queryable,
	viewer: Viewer,
	input: FoodInput
): Promise<WriteResult<Food>> {
	return guarded<Food>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const nutrients = nutrientsOf(input);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		const rows = await sql<FoodRow[]>`
			insert into ${sql(FOODS)} (
				household_id, owner_user_id, visibility, name, brand, serving,
				kcal_per_serving, protein_g, carbs_g, fibre_g, sugar_g, total_fat_g, sodium_mg,
				notes, is_favourite, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${optionalText(input.brand, 'brand', 200)}, ${optionalText(input.serving, 'serving', 100)},
				${nutrients.kcalPerServing}, ${nutrients.proteinG}, ${nutrients.carbsG}, ${nutrients.fibreG},
				${nutrients.sugarG}, ${nutrients.totalFatG}, ${nutrients.sodiumMg},
				${optionalText(input.notes, 'notes')}, ${isFavourite(input.isFavourite)}::boolean,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${foodColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapFood(row) };
	});
}

/**
 * Edits a food under the version the caller read it at. Only the fields
 * present in the patch change, the same optimistic-concurrency contract
 * `updateRecipe` (food.ts) uses for its own record.
 */
export function updateFood(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: FoodInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Food>> {
	return guarded<Food>(async () => {
		const current = await getFood(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			brand: patched(patch, 'brand', current.brand, (v) => optionalText(v, 'brand', 200)),
			serving: patched(patch, 'serving', current.serving, (v) => optionalText(v, 'serving', 100)),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes')),
			isFavourite: patched(patch, 'isFavourite', current.isFavourite, isFavourite)
		};
		const nutrients = nutrientsOf(patch, current);
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<FoodRow, Food>({
			sql,
			table: FOODS,
			id,
			readScope: readableScope(sql, viewer, FOODS),
			writeScope: writableScope(sql, viewer, FOODS),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				name = ${next.name}, brand = ${next.brand}, serving = ${next.serving},
				kcal_per_serving = ${nutrients.kcalPerServing}, protein_g = ${nutrients.proteinG},
				carbs_g = ${nutrients.carbsG}, fibre_g = ${nutrients.fibreG}, sugar_g = ${nutrients.sugarG},
				total_fat_g = ${nutrients.totalFatG}, sodium_mg = ${nutrients.sodiumMg},
				notes = ${next.notes}, is_favourite = ${next.isFavourite}::boolean,
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: foodColumns(sql),
			map: mapFood,
			mayWrite: writableBy(viewer)
		});
	});
}

export const setFoodArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Food>> =>
	archiveScoped<FoodRow, Food>({
		sql,
		table: FOODS,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: foodColumns(sql),
		map: mapFood
	});

// ─── food log entries ───────────────────────────────────────────────────

/** What the sheet needs of an entry, plus everything the totals query joins
 *  in from its food or recipe; no `archivedAt` — see migration 0032. */
export interface FoodLogEntry {
	id: string;
	householdId: string;
	ownerUserId: string;
	visibility: 'household' | 'private';
	notionPageId: string | null;
	sourceRecordId: string | null;
	eatenOn: string;
	meal: MealSlot;
	foodId: string | null;
	recipeId: string | null;
	name: string;
	servings: number;
	kcalOverride: number | null;
	proteinGOverride: number | null;
	carbsGOverride: number | null;
	fibreGOverride: number | null;
	sugarGOverride: number | null;
	totalFatGOverride: number | null;
	sodiumMgOverride: number | null;
	notes: string | null;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string | null;
	updatedBy: string | null;
}

interface FoodLogEntryRow {
	id: string;
	household_id: string;
	owner_user_id: string;
	visibility: unknown;
	notion_page_id: string | null;
	source_record_id: string | null;
	eaten_on: string;
	meal: string;
	food_id: string | null;
	recipe_id: string | null;
	name: string;
	servings: unknown;
	kcal_override: unknown;
	protein_g_override: unknown;
	carbs_g_override: unknown;
	fibre_g_override: unknown;
	sugar_g_override: unknown;
	total_fat_g_override: unknown;
	sodium_mg_override: unknown;
	notes: string | null;
	created_at: unknown;
	updated_at: unknown;
	created_by: string | null;
	updated_by: string | null;
}

const ENTRIES = 'food_log_entries';

const entryColumns = (sql: Queryable): Fragment => sql`
	id, household_id, owner_user_id, visibility, notion_page_id, source_record_id,
	eaten_on::text as eaten_on, meal, food_id, recipe_id, name, servings,
	kcal_override, protein_g_override, carbs_g_override, fibre_g_override, sugar_g_override,
	total_fat_g_override, sodium_mg_override, notes,
	created_at, updated_at, created_by, updated_by`;

function mapEntry(row: FoodLogEntryRow): FoodLogEntry {
	return {
		id: row.id,
		householdId: row.household_id,
		ownerUserId: row.owner_user_id,
		visibility: toVisibility(row.visibility),
		notionPageId: row.notion_page_id,
		sourceRecordId: row.source_record_id,
		eatenOn: toDay(row.eaten_on),
		meal: row.meal as MealSlot,
		foodId: row.food_id,
		recipeId: row.recipe_id,
		name: toText(row.name),
		servings: toNumberOrNull(row.servings) ?? 1,
		kcalOverride: toNumberOrNull(row.kcal_override),
		proteinGOverride: toNumberOrNull(row.protein_g_override),
		carbsGOverride: toNumberOrNull(row.carbs_g_override),
		fibreGOverride: toNumberOrNull(row.fibre_g_override),
		sugarGOverride: toNumberOrNull(row.sugar_g_override),
		totalFatGOverride: toNumberOrNull(row.total_fat_g_override),
		sodiumMgOverride: toNumberOrNull(row.sodium_mg_override),
		notes: toTextOrNull(row.notes),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
		createdBy: row.created_by,
		updatedBy: row.updated_by
	};
}

export async function getFoodLogEntry(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<FoodLogEntry | null> {
	const row = await getScoped<FoodLogEntryRow>(
		sql,
		ENTRIES,
		id,
		readableScope(sql, viewer, ENTRIES),
		entryColumns(sql)
	);
	return row ? mapEntry(row) : null;
}

/** The viewer's own rows for one day, regardless of visibility — the day
 *  view's default before the "show household" toggle is asked for. */
function ownDayScope(sql: Queryable, viewer: Viewer, day: string): Fragment {
	return sql`${sql(ENTRIES)}.household_id = ${viewer.householdId}::uuid
		and ${sql(ENTRIES)}.owner_user_id = ${viewer.userId}::uuid
		and ${sql(ENTRIES)}.eaten_on = ${day}::date`;
}

export interface DayEntriesOptions {
	/** Also include other household members' household-visible entries for
	 *  the day. Off by default: a food log defaults to just the viewer's own
	 *  day, the same as `health_measurements`. */
	includeHousehold?: boolean;
}

/** One day's entries for the viewer, oldest-logged first — the order they
 *  were added within each meal group. */
export async function listFoodLogEntriesForDay(
	sql: Queryable,
	viewer: Viewer,
	day: string,
	options: DayEntriesOptions = {}
): Promise<FoodLogEntry[]> {
	if (!isDay(day)) return [];
	const scope = options.includeHousehold
		? sql`${readableScope(sql, viewer, ENTRIES)} and ${sql(ENTRIES)}.eaten_on = ${day}::date`
		: ownDayScope(sql, viewer, day);
	const rows = await sql<FoodLogEntryRow[]>`
		select ${entryColumns(sql)} from ${sql(ENTRIES)}
		where ${scope}
		order by created_at asc
	`;
	return rows.map(mapEntry);
}

export interface FoodLogEntryInput extends OwnershipInput {
	eatenOn?: unknown;
	meal?: unknown;
	foodId?: unknown;
	recipeId?: unknown;
	/** Only used for a quick entry — one with neither `foodId` nor `recipeId`
	 *  resolving to a source. A linked entry's name always comes from its
	 *  source instead (see `name` below), so this is ignored otherwise. */
	name?: unknown;
	servings?: unknown;
	kcalOverride?: unknown;
	proteinGOverride?: unknown;
	carbsGOverride?: unknown;
	fibreGOverride?: unknown;
	sugarGOverride?: unknown;
	totalFatGOverride?: unknown;
	sodiumMgOverride?: unknown;
	notes?: unknown;
}

function validateSourceChoice(foodId: string | null, recipeId: string | null): void {
	if (foodId !== null && recipeId !== null) {
		throw new InvalidInput('choose a food or a recipe, not both');
	}
}

/**
 * Resolves an optional link to a food, along with the name to snapshot.
 *
 * Checked readable in the same transaction as the write that follows (the
 * same shape `resolveGoalId` in savings.ts uses for its own link), so a
 * caller cannot attach an entry to a food it cannot see by guessing that
 * food's id. `undefined` means "named but not reachable" — refused by the
 * caller — distinct from the `{ id: null, name: null }` of "no food chosen".
 */
async function resolveFoodLink(
	sql: Queryable,
	viewer: Viewer,
	foodId: string | null
): Promise<{ id: string | null; name: string | null } | undefined> {
	if (foodId === null) return { id: null, name: null };
	if (!isUuid(foodId)) return undefined;
	const rows = await sql<{ id: string; name: string }[]>`
		select id, name from ${sql(FOODS)}
		where id = ${foodId}::uuid and ${readableScope(sql, viewer, FOODS)}
	`;
	const row = rows[0];
	return row ? { id: row.id, name: row.name } : undefined;
}

/** As {@link resolveFoodLink}, for the recipe side of the same choice. */
async function resolveRecipeLink(
	sql: Queryable,
	viewer: Viewer,
	recipeId: string | null
): Promise<{ id: string | null; name: string | null } | undefined> {
	if (recipeId === null) return { id: null, name: null };
	if (!isUuid(recipeId)) return undefined;
	const rows = await sql<{ id: string; name: string }[]>`
		select id, name from recipes
		where id = ${recipeId}::uuid and ${readableScope(sql, viewer, 'recipes')}
	`;
	const row = rows[0];
	return row ? { id: row.id, name: row.name } : undefined;
}

/** Blank means the ordinary one serving; the table refuses anything not
 *  greater than 0, so a bad value is refused here with a field-level message. */
function servingsOf(value: unknown): number {
	if (value === undefined || value === null || value === '') return 1;
	const n = optionalNumber(value, 'servings');
	if (n === null || n <= 0) throw new InvalidInput('servings must be greater than 0');
	return n;
}

interface Overrides {
	kcal: number | null;
	protein: number | null;
	carbs: number | null;
	fibre: number | null;
	sugar: number | null;
	fat: number | null;
	sodium: number | null;
}

function overridesOf(input: FoodLogEntryInput, current?: Overrides): Overrides {
	return {
		kcal: patched(input, 'kcalOverride', current?.kcal ?? null, (v) => nonNegative(v, 'calories')),
		protein: patched(input, 'proteinGOverride', current?.protein ?? null, (v) =>
			nonNegative(v, 'protein')
		),
		carbs: patched(input, 'carbsGOverride', current?.carbs ?? null, (v) => nonNegative(v, 'carbs')),
		fibre: patched(input, 'fibreGOverride', current?.fibre ?? null, (v) => nonNegative(v, 'fibre')),
		sugar: patched(input, 'sugarGOverride', current?.sugar ?? null, (v) => nonNegative(v, 'sugar')),
		fat: patched(input, 'totalFatGOverride', current?.fat ?? null, (v) => nonNegative(v, 'fat')),
		sodium: patched(input, 'sodiumMgOverride', current?.sodium ?? null, (v) =>
			nonNegative(v, 'sodium')
		)
	};
}

export function createFoodLogEntry(
	sql: Queryable,
	viewer: Viewer,
	input: FoodLogEntryInput
): Promise<WriteResult<FoodLogEntry>> {
	return guarded<FoodLogEntry>(() =>
		atomically(sql, async (tx): Promise<WriteResult<FoodLogEntry>> => {
			const rawFoodId = optionalId(input.foodId, 'food');
			const rawRecipeId = optionalId(input.recipeId, 'recipe');
			validateSourceChoice(rawFoodId, rawRecipeId);

			const food = await resolveFoodLink(tx, viewer, rawFoodId);
			if (food === undefined) {
				return { ok: false, reason: 'not_found', message: 'could not find that food' };
			}
			const recipe = await resolveRecipeLink(tx, viewer, rawRecipeId);
			if (recipe === undefined) {
				return { ok: false, reason: 'not_found', message: 'could not find that recipe' };
			}

			// A linked entry is always named after its source; only a quick entry
			// — neither link resolved to anything — needs a typed name at all.
			const name = food.name ?? recipe.name ?? requiredText(input.name, 'name', 200);
			const eatenOn =
				input.eatenOn === undefined
					? await householdToday(tx, viewer.householdId)
					: requiredDay(input.eatenOn, 'date');
			const meal = oneOf(input.meal, 'meal', MEAL_SLOTS);
			const servings = servingsOf(input.servings);
			const overrides = overridesOf(input);
			const notes = optionalText(input.notes, 'notes');

			const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
				ownerUserId: viewer.userId,
				visibility: 'private'
			});
			if (ownerUserId === null) throw new InvalidInput('a log entry needs an owner');

			const rows = await tx<FoodLogEntryRow[]>`
				insert into ${tx(ENTRIES)} (
					household_id, owner_user_id, visibility, eaten_on, meal, food_id, recipe_id, name,
					servings, kcal_override, protein_g_override, carbs_g_override, fibre_g_override,
					sugar_g_override, total_fat_g_override, sodium_mg_override, notes,
					created_by, updated_by
				) values (
					${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility},
					${eatenOn}::date, ${meal}, ${food.id}::uuid, ${recipe.id}::uuid, ${name},
					${servings}::numeric, ${overrides.kcal}, ${overrides.protein}, ${overrides.carbs},
					${overrides.fibre}, ${overrides.sugar}, ${overrides.fat}, ${overrides.sodium}, ${notes},
					${viewer.userId}::uuid, ${viewer.userId}::uuid
				)
				returning ${entryColumns(tx)}
			`;
			const row = rows[0];
			if (!row) throw new Error('insert returned no row');
			return { ok: true, record: mapEntry(row) };
		})
	);
}

/**
 * Edits an entry under the version the caller read it at.
 *
 * Touching `foodId` or `recipeId` re-resolves and re-snapshots `name` from
 * whatever the patch now points at (or refuses, the same as on create); left
 * alone, a linked entry's name stays exactly what was logged, and only a
 * quick entry's own typed name is independently editable.
 */
export function updateFoodLogEntry(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: FoodLogEntryInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<FoodLogEntry>> {
	return guarded<FoodLogEntry>(() =>
		atomically(sql, async (tx): Promise<WriteResult<FoodLogEntry>> => {
			const current = await getFoodLogEntry(tx, viewer, id);
			if (!current) return { ok: false, reason: 'not_found' };

			let foodId = current.foodId;
			let recipeId = current.recipeId;
			let name = current.name;

			if ('foodId' in patch || 'recipeId' in patch) {
				const rawFoodId = 'foodId' in patch ? optionalId(patch.foodId, 'food') : current.foodId;
				const rawRecipeId =
					'recipeId' in patch ? optionalId(patch.recipeId, 'recipe') : current.recipeId;
				validateSourceChoice(rawFoodId, rawRecipeId);

				const food = await resolveFoodLink(tx, viewer, rawFoodId);
				if (food === undefined) {
					return { ok: false, reason: 'not_found', message: 'could not find that food' };
				}
				const recipe = await resolveRecipeLink(tx, viewer, rawRecipeId);
				if (recipe === undefined) {
					return { ok: false, reason: 'not_found', message: 'could not find that recipe' };
				}
				foodId = food.id;
				recipeId = recipe.id;
				name = food.name ?? recipe.name ?? requiredText(patch.name ?? current.name, 'name', 200);
			} else if (current.foodId === null && current.recipeId === null && patch.name !== undefined) {
				name = requiredText(patch.name, 'name', 200);
			}

			const eatenOn = patched(patch, 'eatenOn', current.eatenOn, (v) => requiredDay(v, 'date'));
			const meal = patched(patch, 'meal', current.meal, (v) => oneOf(v, 'meal', MEAL_SLOTS));
			const servings = patch.servings !== undefined ? servingsOf(patch.servings) : current.servings;
			const overrides = overridesOf(patch, {
				kcal: current.kcalOverride,
				protein: current.proteinGOverride,
				carbs: current.carbsGOverride,
				fibre: current.fibreGOverride,
				sugar: current.sugarGOverride,
				fat: current.totalFatGOverride,
				sodium: current.sodiumMgOverride
			});
			const notes = patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'));
			const ownership = resolveOwnership(viewer, patch, {
				ownerUserId: current.ownerUserId,
				visibility: current.visibility
			});

			return writeScoped<FoodLogEntryRow, FoodLogEntry>({
				sql: tx,
				table: ENTRIES,
				id,
				readScope: readableScope(tx, viewer, ENTRIES),
				writeScope: writableScope(tx, viewer, ENTRIES),
				...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
				assignments: tx`
					eaten_on = ${eatenOn}::date, meal = ${meal}, food_id = ${foodId}::uuid,
					recipe_id = ${recipeId}::uuid, name = ${name}, servings = ${servings}::numeric,
					kcal_override = ${overrides.kcal}, protein_g_override = ${overrides.protein},
					carbs_g_override = ${overrides.carbs}, fibre_g_override = ${overrides.fibre},
					sugar_g_override = ${overrides.sugar}, total_fat_g_override = ${overrides.fat},
					sodium_mg_override = ${overrides.sodium}, notes = ${notes},
					owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
					updated_at = now(), updated_by = ${viewer.userId}::uuid`,
				columns: entryColumns(tx),
				map: mapEntry,
				mayWrite: writableBy(viewer)
			});
		})
	);
}

/**
 * Removes a log entry outright.
 *
 * A food log has no "still true, just not now" reading of an eaten meal the
 * way a recipe or a task does — a wrong entry is corrected by deleting it and
 * logging the right one, the way an accidental habit check-in is unlogged
 * (`unlogHabit`, habits.ts), not archived. See migration 0032's own comment.
 * Missing is treated as success by the caller's own idempotent expectations
 * elsewhere in this layer, but here a caller needs to know whether its own
 * delete actually removed something, so this returns whether a row went.
 */
export async function deleteFoodLogEntry(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<boolean> {
	if (!isUuid(id)) return false;
	const rows = await sql<{ id: string }[]>`
		delete from ${sql(ENTRIES)}
		where id = ${id}::uuid and ${writableScope(sql, viewer, ENTRIES)}
		returning id
	`;
	return rows.length > 0;
}

// ─── totals ────────────────────────────────────────────────────────────────

export interface FoodLogDayTotals {
	day: string;
	kcal: number | null;
	kcalUnknown: number;
	proteinG: number | null;
	proteinGUnknown: number;
	carbsG: number | null;
	carbsGUnknown: number;
	fibreG: number | null;
	fibreGUnknown: number;
	sugarG: number | null;
	sugarGUnknown: number;
	totalFatG: number | null;
	totalFatGUnknown: number;
	sodiumMg: number | null;
	sodiumMgUnknown: number;
}

interface DayTotalsRow {
	day: string;
	kcal: string | null;
	kcal_unknown: number;
	protein_g: string | null;
	protein_g_unknown: number;
	carbs_g: string | null;
	carbs_g_unknown: number;
	fibre_g: string | null;
	fibre_g_unknown: number;
	sugar_g: string | null;
	sugar_g_unknown: number;
	total_fat_g: string | null;
	total_fat_g_unknown: number;
	sodium_mg: string | null;
	sodium_mg_unknown: number;
}

function mapDayTotals(row: DayTotalsRow): FoodLogDayTotals {
	return {
		day: toDay(row.day),
		kcal: toNumberOrNull(row.kcal),
		kcalUnknown: row.kcal_unknown,
		proteinG: toNumberOrNull(row.protein_g),
		proteinGUnknown: row.protein_g_unknown,
		carbsG: toNumberOrNull(row.carbs_g),
		carbsGUnknown: row.carbs_g_unknown,
		fibreG: toNumberOrNull(row.fibre_g),
		fibreGUnknown: row.fibre_g_unknown,
		sugarG: toNumberOrNull(row.sugar_g),
		sugarGUnknown: row.sugar_g_unknown,
		totalFatG: toNumberOrNull(row.total_fat_g),
		totalFatGUnknown: row.total_fat_g_unknown,
		sodiumMg: toNumberOrNull(row.sodium_mg),
		sodiumMgUnknown: row.sodium_mg_unknown
	};
}

/**
 * Per-day nutrition totals for the viewer's OWN entries only, `from` and `to`
 * inclusive — never another member's, private or household-visible, which is
 * why this scopes by `owner_user_id` directly rather than `readableScope`
 * (base.ts's header, rule 2, and the brief's own privacy rule).
 *
 * Every nutrient is `coalesce(override, servings * per_serving)`, computed in
 * SQL so the numeric totals are exact (base.ts rule 1, the same reason
 * `savingsSummary` sums in SQL rather than in JS). A nutrient unknown on both
 * the entry and its source — no override, and no food or recipe carrying a
 * value for it — is excluded from the sum (`sum` already ignores `null`)
 * rather than counted as zero, and separately counted per day so a page can
 * say "Protein 85 g (2 entries unknown)" rather than a total that silently
 * under-counts.
 *
 * The join to `foods`/`recipes` carries no visibility check of its own: a
 * food or recipe was only ever linked here because it was readable to this
 * same viewer at the moment they logged it (`resolveFoodLink`/
 * `resolveRecipeLink`), and this query only ever touches the viewer's own
 * entries — so a source made private afterwards still contributes its
 * number to a total the viewer already owns, the same way `savingsSummary`'s
 * all-time total still counts a contribution toward a goal that has since
 * gone private, while leaving the goal's *name* out of the breakdown.
 */
export async function nutritionTotals(
	sql: Queryable,
	viewer: Viewer,
	from: string,
	to: string
): Promise<FoodLogDayTotals[]> {
	const rows = await sql<DayTotalsRow[]>`
		select
			e.eaten_on::text as day,
			sum(coalesce(e.kcal_override, e.servings * coalesce(f.kcal_per_serving, r.kcal_per_serving)))
				as kcal,
			count(*) filter (
				where e.kcal_override is null and coalesce(f.kcal_per_serving, r.kcal_per_serving) is null
			)::int as kcal_unknown,
			sum(coalesce(e.protein_g_override, e.servings * coalesce(f.protein_g, r.protein_g)))
				as protein_g,
			count(*) filter (
				where e.protein_g_override is null and coalesce(f.protein_g, r.protein_g) is null
			)::int as protein_g_unknown,
			sum(coalesce(e.carbs_g_override, e.servings * coalesce(f.carbs_g, r.carbs_g))) as carbs_g,
			count(*) filter (
				where e.carbs_g_override is null and coalesce(f.carbs_g, r.carbs_g) is null
			)::int as carbs_g_unknown,
			sum(coalesce(e.fibre_g_override, e.servings * coalesce(f.fibre_g, r.fibre_g))) as fibre_g,
			count(*) filter (
				where e.fibre_g_override is null and coalesce(f.fibre_g, r.fibre_g) is null
			)::int as fibre_g_unknown,
			sum(coalesce(e.sugar_g_override, e.servings * coalesce(f.sugar_g, r.sugar_g))) as sugar_g,
			count(*) filter (
				where e.sugar_g_override is null and coalesce(f.sugar_g, r.sugar_g) is null
			)::int as sugar_g_unknown,
			sum(coalesce(e.total_fat_g_override, e.servings * coalesce(f.total_fat_g, r.total_fat_g)))
				as total_fat_g,
			count(*) filter (
				where e.total_fat_g_override is null and coalesce(f.total_fat_g, r.total_fat_g) is null
			)::int as total_fat_g_unknown,
			sum(coalesce(e.sodium_mg_override, e.servings * coalesce(f.sodium_mg, r.sodium_mg)))
				as sodium_mg,
			count(*) filter (
				where e.sodium_mg_override is null and coalesce(f.sodium_mg, r.sodium_mg) is null
			)::int as sodium_mg_unknown
		from ${sql(ENTRIES)} e
		left join ${sql(FOODS)} f on f.id = e.food_id
		left join recipes r on r.id = e.recipe_id
		where e.household_id = ${viewer.householdId}::uuid
		  and e.owner_user_id = ${viewer.userId}::uuid
		  and e.eaten_on between ${from}::date and ${to}::date
		group by e.eaten_on
		order by e.eaten_on asc
	`;
	return rows.map(mapDayTotals);
}

export interface FoodLogMonthProtein {
	/** The month's first day, `YYYY-MM-01` — `periodKey(day, 'month')`'s own
	 *  format (dates.ts), so a caller can line this up with any other
	 *  month-keyed series in the app. */
	month: string;
	proteinG: number | null;
	unknownEntries: number;
}

interface MonthProteinRow {
	month: string;
	protein_g: string | null;
	unknown: number;
}

/**
 * Protein by month for the last `months` months (12 by default) ending on
 * the household's current month — the Notion rollup, and what reviews will
 * use. Zero-filled: every month in the window gets an entry, `null` when
 * nothing was logged, so a chart never has to reconstruct the gaps itself.
 */
export async function proteinByMonth(
	sql: Queryable,
	viewer: Viewer,
	months = 12
): Promise<FoodLogMonthProtein[]> {
	const today = await householdToday(sql, viewer.householdId);
	let from = periodKey(today, 'month');
	for (let i = 1; i < months; i++) from = previousPeriod(from, 'month');

	const rows = await sql<MonthProteinRow[]>`
		select
			date_trunc('month', e.eaten_on)::date::text as month,
			sum(coalesce(e.protein_g_override, e.servings * coalesce(f.protein_g, r.protein_g)))
				as protein_g,
			count(*) filter (
				where e.protein_g_override is null and coalesce(f.protein_g, r.protein_g) is null
			)::int as unknown
		from ${sql(ENTRIES)} e
		left join ${sql(FOODS)} f on f.id = e.food_id
		left join recipes r on r.id = e.recipe_id
		where e.household_id = ${viewer.householdId}::uuid
		  and e.owner_user_id = ${viewer.userId}::uuid
		  and e.eaten_on >= ${from}::date
		group by date_trunc('month', e.eaten_on)
	`;
	const byMonth = new Map(rows.map((row) => [row.month, row]));

	const series: FoodLogMonthProtein[] = [];
	let key = from;
	for (let i = 0; i < months; i++) {
		const row = byMonth.get(key);
		series.push({
			month: key,
			proteinG: row ? toNumberOrNull(row.protein_g) : null,
			unknownEntries: row ? row.unknown : 0
		});
		key = nextPeriod(key, 'month');
	}
	return series;
}
