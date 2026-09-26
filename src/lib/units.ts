/**
 * Units for the two health readings that come in more than one: blood glucose
 * and weight (migration 0022).
 *
 * Shared by the repository (validation) and the pages (formatting and charts),
 * so it imports nothing from either: no Svelte, no database, no `$lib/server`.
 *
 * A reading is stored in the unit it was taken in, exactly as typed, and is
 * never converted on the way in. Conversion exists only for display, where a
 * chart has to put readings taken in two different units on one axis.
 */

export const GLUCOSE_UNITS = ['mmol/L', 'mg/dL'] as const;
export type GlucoseUnit = (typeof GLUCOSE_UNITS)[number];

export const WEIGHT_UNITS = ['kg', 'lb'] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

export type MeasurementUnit = GlucoseUnit | WeightUnit;

/**
 * What the form offers before someone has recorded either unit: mmol/L is what
 * Canadian meters and labs report, and kg is what a clinic records. After the
 * first reading the form offers whichever unit that person used last instead.
 */
export const DEFAULT_GLUCOSE_UNIT: GlucoseUnit = 'mmol/L';
export const DEFAULT_WEIGHT_UNIT: WeightUnit = 'kg';

export function isGlucoseUnit(value: unknown): value is GlucoseUnit {
	return typeof value === 'string' && (GLUCOSE_UNITS as readonly string[]).includes(value);
}

export function isWeightUnit(value: unknown): value is WeightUnit {
	return typeof value === 'string' && (WEIGHT_UNITS as readonly string[]).includes(value);
}

/**
 * The span a reading in each unit can plausibly take. Wider than any real
 * reading on purpose: an unusual value is exactly what someone tracking it
 * needs to be able to record. What these catch is a number typed against the
 * wrong unit — 112 with mmol/L selected is not a glucose anyone survives, and
 * 6.2 mg/dL is not one either — which is why the two glucose ranges barely
 * overlap. The glucose maxima also sit inside the column's numeric(4, 1).
 */
export const PLAUSIBLE: Record<MeasurementUnit, { min: number; max: number }> = {
	'mmol/L': { min: 0.1, max: 60 },
	'mg/dL': { min: 10, max: 999.9 },
	kg: { min: 0.1, max: 500 },
	lb: { min: 0.1, max: 1100 }
};

/** mg/dL in one mmol/L of glucose: its molar mass, 180.16 g/mol, over ten. */
export const MG_DL_PER_MMOL_L = 18.016;

/** Pounds in one kilogram. Exact: a pound is defined as 0.45359237 kg. */
export const LB_PER_KG = 1 / 0.45359237;

export function convertGlucose(value: number, from: GlucoseUnit, to: GlucoseUnit): number {
	if (from === to) return value;
	return from === 'mmol/L' ? value * MG_DL_PER_MMOL_L : value / MG_DL_PER_MMOL_L;
}

export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number {
	if (from === to) return value;
	return from === 'kg' ? value * LB_PER_KG : value / LB_PER_KG;
}

/** The precision each unit is read at: mg/dL in whole numbers, the rest to
 *  one decimal place, as meters and scales display them. */
const DECIMALS: Record<MeasurementUnit, number> = { 'mmol/L': 1, 'mg/dL': 0, kg: 1, lb: 1 };

/** A converted value, rounded to the precision its unit is read at. */
export function roundFor(value: number, unit: MeasurementUnit): number {
	const scale = 10 ** DECIMALS[unit];
	return Math.round(value * scale) / scale;
}

/**
 * "6.2 mmol/L", "112 mg/dL", "72.4 kg" — or the bare number when the reading
 * recorded no unit, which is every reading imported from Notion until someone
 * sets one. A missing unit is shown as missing, never guessed.
 */
export function withUnit(value: number, unit: string | null | undefined): string {
	return unit ? `${value} ${unit}` : String(value);
}

interface UnitReading<U extends MeasurementUnit> {
	value: number | null;
	unit: U | null;
}

/**
 * The unit a chart of these readings is drawn in: the unit of the most recent
 * reading that recorded one — what the person uses now — or null when none
 * did, in which case the series is drawn as recorded, with no unit at all.
 */
export function chartUnit<U extends MeasurementUnit>(
	newestFirst: readonly UnitReading<U>[]
): U | null {
	for (const reading of newestFirst) {
		if (reading.value !== null && reading.unit !== null) return reading.unit;
	}
	return null;
}

/**
 * One reading's value on a chart drawn in `target`, or null to leave it off.
 *
 * A reading with no unit cannot be placed on an axis that has one: 6.2 could
 * be mmol/L or a mistyped mg/dL, and plotting it either way could draw a line
 * the readings do not support. So it is left off, and the page says how many
 * were. When nothing in the series has a unit (`target` is null), every
 * reading is drawn as recorded, which is all the page could do before units.
 */
export function valueIn<U extends MeasurementUnit>(
	reading: UnitReading<U>,
	target: U | null,
	convert: (value: number, from: U, to: U) => number
): number | null {
	if (reading.value === null) return null;
	if (target === null) return reading.value;
	if (reading.unit === null) return null;
	return roundFor(convert(reading.value, reading.unit, target), target);
}
