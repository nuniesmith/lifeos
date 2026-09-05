import { describe, expect, it } from 'vitest';
import { toDate, toDateOrNull } from '$lib/server/db/coerce';

describe('timestamp coercion', () => {
	it('passes a Date through unchanged', () => {
		const d = new Date('2026-09-04T12:00:00Z');
		expect(toDate(d)).toBe(d);
	});

	it('parses the ISO string the driver actually returns in production', () => {
		// This is the shape that broke session resolution: a string where a
		// Date was assumed, so .getTime() threw and every request went anonymous.
		expect(toDate('2026-09-04 12:00:00+00').getTime()).toBe(Date.parse('2026-09-04T12:00:00Z'));
	});

	it('accepts epoch milliseconds', () => {
		expect(toDate(1_757_000_000_000).getTime()).toBe(1_757_000_000_000);
	});

	it('passes null and undefined through', () => {
		expect(toDateOrNull(null)).toBeNull();
		expect(toDateOrNull(undefined)).toBeNull();
	});

	it('returns null rather than an Invalid Date', () => {
		expect(toDateOrNull('not a timestamp')).toBeNull();
		expect(toDateOrNull(new Date('nonsense'))).toBeNull();
		expect(toDateOrNull({})).toBeNull();
	});

	it('throws when a required timestamp is absent', () => {
		expect(() => toDate(null)).toThrow(TypeError);
	});
});
