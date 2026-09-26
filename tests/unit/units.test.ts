import { describe, expect, it } from 'vitest';
import {
	PLAUSIBLE,
	chartUnit,
	convertGlucose,
	convertWeight,
	isGlucoseUnit,
	isWeightUnit,
	roundFor,
	valueIn,
	withUnit
} from '$lib/units';

/**
 * Units for glucose and weight (migration 0022). Readings are stored as typed
 * and never converted on the way in, so everything here is display: the two
 * conversions, the precision each unit is read at, and how a chart of
 * readings taken in two units — or in none — is drawn.
 */

describe('converting glucose', () => {
	it('turns mmol/L into mg/dL at 18.016 per mmol/L', () => {
		expect(roundFor(convertGlucose(5.5, 'mmol/L', 'mg/dL'), 'mg/dL')).toBe(99);
		expect(roundFor(convertGlucose(10, 'mmol/L', 'mg/dL'), 'mg/dL')).toBe(180);
	});

	it('turns mg/dL back into mmol/L', () => {
		expect(roundFor(convertGlucose(100, 'mg/dL', 'mmol/L'), 'mmol/L')).toBe(5.6);
		expect(roundFor(convertGlucose(180, 'mg/dL', 'mmol/L'), 'mmol/L')).toBe(10);
	});

	it('leaves a value alone when the units already match', () => {
		expect(convertGlucose(6.2, 'mmol/L', 'mmol/L')).toBe(6.2);
		expect(convertGlucose(112, 'mg/dL', 'mg/dL')).toBe(112);
	});
});

describe('converting weight', () => {
	it('uses the exact definition of the pound', () => {
		expect(convertWeight(0.45359237, 'kg', 'lb')).toBeCloseTo(1, 12);
		expect(roundFor(convertWeight(70, 'kg', 'lb'), 'lb')).toBe(154.3);
		expect(roundFor(convertWeight(154.3, 'lb', 'kg'), 'kg')).toBe(70);
	});

	it('leaves a value alone when the units already match', () => {
		expect(convertWeight(72.4, 'kg', 'kg')).toBe(72.4);
	});
});

describe('roundFor', () => {
	it('reads mg/dL in whole numbers and everything else to one decimal', () => {
		expect(roundFor(99.088, 'mg/dL')).toBe(99);
		expect(roundFor(5.5506, 'mmol/L')).toBe(5.6);
		expect(roundFor(154.3236, 'lb')).toBe(154.3);
		expect(roundFor(69.9898, 'kg')).toBe(70);
	});
});

describe('recognising a unit', () => {
	it('accepts exactly the symbols the table stores', () => {
		expect(isGlucoseUnit('mmol/L')).toBe(true);
		expect(isGlucoseUnit('mg/dL')).toBe(true);
		expect(isWeightUnit('kg')).toBe(true);
		expect(isWeightUnit('lb')).toBe(true);
	});

	it('refuses near misses rather than normalising them', () => {
		for (const value of ['mmol/l', 'MG/DL', 'mg/dl ', '', null, undefined, 5, 'kg']) {
			expect(isGlucoseUnit(value)).toBe(false);
		}
		for (const value of ['KG', 'lbs', 'pounds', 'stone', '', null, 'mg/dL']) {
			expect(isWeightUnit(value)).toBe(false);
		}
	});
});

describe('the plausible ranges', () => {
	const within = (value: number, unit: keyof typeof PLAUSIBLE) =>
		value >= PLAUSIBLE[unit].min && value <= PLAUSIBLE[unit].max;

	it('tell the two glucose units apart for the numbers people actually type', () => {
		// The mix-up the ranges exist to catch, in both directions.
		expect(within(112, 'mmol/L')).toBe(false);
		expect(within(112, 'mg/dL')).toBe(true);
		expect(within(6.2, 'mg/dL')).toBe(false);
		expect(within(6.2, 'mmol/L')).toBe(true);
	});

	it('still take an unusual real reading in either unit', () => {
		expect(within(2.1, 'mmol/L')).toBe(true); // a hypo
		expect(within(33.3, 'mmol/L')).toBe(true); // a meter's "HI"
		expect(within(38, 'mg/dL')).toBe(true);
		expect(within(600, 'mg/dL')).toBe(true);
	});

	it('keep the glucose maximum inside the column, numeric(4, 1)', () => {
		expect(PLAUSIBLE['mg/dL'].max).toBeLessThanOrEqual(999.9);
		expect(PLAUSIBLE['mmol/L'].max).toBeLessThanOrEqual(999.9);
	});
});

describe('withUnit', () => {
	it('puts the unit after the number, as it was recorded', () => {
		expect(withUnit(6.2, 'mmol/L')).toBe('6.2 mmol/L');
		expect(withUnit(112, 'mg/dL')).toBe('112 mg/dL');
		expect(withUnit(154.3, 'lb')).toBe('154.3 lb');
	});

	it('shows the bare number when the reading recorded no unit, never a guessed one', () => {
		expect(withUnit(6.2, null)).toBe('6.2');
		expect(withUnit(71.4, undefined)).toBe('71.4');
	});
});

describe('chartUnit', () => {
	it('is the unit of the most recent reading that recorded one', () => {
		expect(
			chartUnit([
				{ value: 70, unit: 'kg' },
				{ value: 155, unit: 'lb' }
			])
		).toBe('kg');
	});

	it('skips readings without a value or without a unit', () => {
		expect(
			chartUnit([
				{ value: null, unit: null },
				{ value: 71.4, unit: null },
				{ value: 155, unit: 'lb' }
			])
		).toBe('lb');
	});

	it('is null when nothing in the series recorded a unit', () => {
		expect(chartUnit([{ value: 71.4, unit: null }])).toBeNull();
		expect(chartUnit([])).toBeNull();
	});
});

describe('valueIn', () => {
	it('converts a reading onto the chart’s unit, at that unit’s precision', () => {
		expect(valueIn({ value: 70, unit: 'kg' }, 'lb', convertWeight)).toBe(154.3);
		expect(valueIn({ value: 112, unit: 'mg/dL' }, 'mmol/L', convertGlucose)).toBe(6.2);
	});

	it('draws a reading already in the chart’s unit as it is', () => {
		expect(valueIn({ value: 6.2, unit: 'mmol/L' }, 'mmol/L', convertGlucose)).toBe(6.2);
	});

	it('leaves off a reading with no unit when the chart has one, rather than guess', () => {
		expect(valueIn({ value: 6.2, unit: null }, 'mg/dL', convertGlucose)).toBeNull();
	});

	it('draws every reading as recorded when nothing in the series has a unit', () => {
		expect(valueIn({ value: 71.4, unit: null }, null, convertWeight)).toBe(71.4);
	});

	it('is a gap, not a zero, when the reading has no value', () => {
		expect(valueIn({ value: null, unit: 'kg' }, 'kg', convertWeight)).toBeNull();
	});
});
