import { describe, expect, it } from 'vitest';
import { FOOD_UNITS, formatFoodAmount, isFoodUnit } from '../../src/lib/food-units';

/**
 * The unit list validated in both migration 0026's CHECK and
 * `$lib/server/repositories/food.ts`, and the display string that prefers a
 * structured amount over the free text beside it.
 */

describe('isFoodUnit', () => {
	it('accepts exactly the units the migration allows', () => {
		for (const unit of FOOD_UNITS) expect(isFoodUnit(unit)).toBe(true);
	});

	it('refuses anything else, including a close miss', () => {
		for (const bad of ['stone', 'lb', 'oz', 'Cup', ' g', '', null, undefined, 5]) {
			expect(isFoodUnit(bad)).toBe(false);
		}
	});
});

describe('formatFoodAmount', () => {
	it('is null when there is nothing structured to show', () => {
		expect(formatFoodAmount(null, null)).toBeNull();
		expect(formatFoodAmount(500, null)).toBeNull();
		expect(formatFoodAmount(null, 'g')).toBeNull();
	});

	it('trims a whole number down to it, and keeps real decimals', () => {
		expect(formatFoodAmount(500, 'g')).toBe('500 g');
		expect(formatFoodAmount(1.5, 'cup')).toBe('1.5 cups');
		expect(formatFoodAmount(2, 'kg')).toBe('2 kg');
	});

	it('pluralizes the units that read as words, only above one', () => {
		expect(formatFoodAmount(1, 'cup')).toBe('1 cup');
		expect(formatFoodAmount(2, 'cup')).toBe('2 cups');
		expect(formatFoodAmount(1, 'piece')).toBe('1 piece');
		expect(formatFoodAmount(3, 'piece')).toBe('3 pieces');
		expect(formatFoodAmount(1, 'pinch')).toBe('1 pinch');
		expect(formatFoodAmount(2, 'pinch')).toBe('2 pinches');
		expect(formatFoodAmount(1, 'can')).toBe('1 can');
		expect(formatFoodAmount(2, 'can')).toBe('2 cans');
	});

	it('never pluralizes a unit that is a symbol, even above one', () => {
		expect(formatFoodAmount(2, 'g')).toBe('2 g');
		expect(formatFoodAmount(2, 'kg')).toBe('2 kg');
		expect(formatFoodAmount(2, 'ml')).toBe('2 ml');
		expect(formatFoodAmount(2, 'l')).toBe('2 l');
		expect(formatFoodAmount(2, 'tsp')).toBe('2 tsp');
		expect(formatFoodAmount(2, 'tbsp')).toBe('2 tbsp');
	});
});
