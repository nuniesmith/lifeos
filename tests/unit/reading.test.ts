import { describe, expect, it } from 'vitest';
import { InvalidInput } from '$lib/server/repositories/base';
import {
	cleanTextArray,
	optionalIsbn,
	optionalQuarterRating
} from '$lib/server/repositories/reading';

/**
 * The pure helpers behind the book catalogue (Reading Tracker R1): none of
 * this touches SQL, so an off-by-one in a bound (3.3 is not a quarter step,
 * an 11-digit ISBN is not 10 or 13) should fail here, not three layers up in
 * an integration test.
 */

describe('optionalQuarterRating', () => {
	it('accepts every quarter step from 0 to 5', () => {
		for (const value of [0, 0.25, 0.5, 0.75, 1, 2.25, 3.5, 4.75, 5]) {
			expect(optionalQuarterRating(value)).toBe(value);
		}
	});

	it('is null for null, undefined and an empty string', () => {
		expect(optionalQuarterRating(null)).toBeNull();
		expect(optionalQuarterRating(undefined)).toBeNull();
		expect(optionalQuarterRating('')).toBeNull();
	});

	it('rejects a value that does not land on a quarter step', () => {
		expect(() => optionalQuarterRating(3.3)).toThrow(InvalidInput);
		expect(() => optionalQuarterRating(0.1)).toThrow(InvalidInput);
	});

	it('rejects outside 0 to 5', () => {
		expect(() => optionalQuarterRating(-0.25)).toThrow(InvalidInput);
		expect(() => optionalQuarterRating(5.25)).toThrow(InvalidInput);
	});

	it('accepts a numeric string, the shape a form field sends', () => {
		expect(optionalQuarterRating('3.25')).toBe(3.25);
	});
});

describe('optionalIsbn', () => {
	it('strips hyphens and spaces from a 13-digit ISBN', () => {
		expect(optionalIsbn('978-0-06-231609-7')).toBe('9780062316097');
		expect(optionalIsbn('978 0 06 231609 7')).toBe('9780062316097');
	});

	it('accepts a bare 10-digit ISBN', () => {
		expect(optionalIsbn('0062316095')).toBe('0062316095');
	});

	it('is null for null, undefined and an empty string', () => {
		expect(optionalIsbn(null)).toBeNull();
		expect(optionalIsbn(undefined)).toBeNull();
		expect(optionalIsbn('')).toBeNull();
		expect(optionalIsbn('   ')).toBeNull();
	});

	it('rejects a length that is neither 10 nor 13 digits', () => {
		expect(() => optionalIsbn('123456789')).toThrow(InvalidInput);
		expect(() => optionalIsbn('123456789012')).toThrow(InvalidInput);
	});

	it('rejects the check-digit letter some ISBN-10s end in', () => {
		// The repository accepts 10 or 13 DIGITS, deliberately not the X some
		// ISBN-10 check digits use — see the comment on this function.
		expect(() => optionalIsbn('006231609X')).toThrow(InvalidInput);
	});

	it('rejects non-digit characters other than hyphens and spaces', () => {
		expect(() => optionalIsbn('978-0-06-231609-7a')).toThrow(InvalidInput);
	});
});

describe('cleanTextArray', () => {
	it('trims and drops blank entries from an array', () => {
		expect(cleanTextArray([' Slow burn ', '', '  ', 'Found family'])).toEqual([
			'Slow burn',
			'Found family'
		]);
	});

	it('splits a comma-separated string, the shape a plain text field sends', () => {
		expect(cleanTextArray('Slow burn, Found family ,Grumpy/sunshine')).toEqual([
			'Slow burn',
			'Found family',
			'Grumpy/sunshine'
		]);
	});

	it('dedupes case-insensitively, keeping the first spelling', () => {
		expect(cleanTextArray(['Slow Burn', 'slow burn', 'SLOW BURN'])).toEqual(['Slow Burn']);
	});

	it('is empty for null, undefined and a non-string, non-array value', () => {
		expect(cleanTextArray(null)).toEqual([]);
		expect(cleanTextArray(undefined)).toEqual([]);
		expect(cleanTextArray(42)).toEqual([]);
	});

	it('is empty for a blank string', () => {
		expect(cleanTextArray('   ')).toEqual([]);
	});
});
