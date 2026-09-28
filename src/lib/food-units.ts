/**
 * Units for a structured recipe amount or pantry quantity (migration 0026).
 *
 * `recipe_ingredients.amount` and `ingredients.quantity` stay free text —
 * "2 cups, chopped", imported exactly as the source wrote it — and this list
 * is only for the structured pair beside them (`amount_value`/`amount_unit`,
 * `quantity_value`/`quantity_unit`), which the app writes when someone picks
 * a number and a unit rather than typing a phrase. Deliberately short:
 * weight, metric volume, the spoons and cups a recipe actually calls for, and
 * the three ways a kitchen counts something whole. No import ever populates
 * these columns, so there is no legacy value this list has to stay
 * compatible with — unlike `$lib/units`, which is why this is its own file
 * rather than an addition to that one.
 *
 * Imports nothing from Svelte, the database, or `$lib/server`, so a page can
 * use it directly and the repository can validate against the same list.
 */

export const FOOD_UNITS = [
	'g',
	'kg',
	'ml',
	'l',
	'tsp',
	'tbsp',
	'cup',
	'piece',
	'pinch',
	'can'
] as const;
export type FoodUnit = (typeof FOOD_UNITS)[number];

export function isFoodUnit(value: unknown): value is FoodUnit {
	return typeof value === 'string' && (FOOD_UNITS as readonly string[]).includes(value);
}

/** A handful of these read oddly with a bare count ("2 cup"); the rest are
 *  symbols and are never pluralized ("2 kg", not "2 kgs"). */
const PLURAL: Partial<Record<FoodUnit, string>> = {
	cup: 'cups',
	piece: 'pieces',
	pinch: 'pinches',
	can: 'cans'
};

/**
 * "500 g", "1.5 cup" → "1.5 cups" — a structured amount, trimmed of a
 * trailing ".00" so a whole number reads as one. Null when there is nothing
 * structured to show, so a caller can fall back to the free-text amount.
 */
export function formatFoodAmount(value: number | null, unit: FoodUnit | null): string | null {
	if (value === null || unit === null) return null;
	// numeric(8,2) never carries more than two decimal places, but a value
	// read back through the driver is a JS number and could in principle
	// print more; toFixed pins it to what the column can actually hold.
	const trimmed = Number(value.toFixed(2)).toString();
	const label = value === 1 ? unit : (PLURAL[unit] ?? unit);
	return `${trimmed} ${label}`;
}
