import { describe, expect, it } from 'vitest';
import { calendarMonth, calendarWindowForMonth } from '../../src/lib/server/calendar';

describe('calendar windows', () => {
	it('starts every six-week grid on Monday', () => {
		expect(calendarWindowForMonth('2026-09')).toEqual({
			month: '2026-09',
			from: '2026-08-31',
			to: '2026-10-11'
		});
	});

	it('handles year boundaries', () => {
		expect(calendarWindowForMonth('2027-01')).toMatchObject({
			from: '2026-12-28',
			to: '2027-02-07'
		});
	});

	it('falls back from malformed query values', () => {
		expect(calendarMonth('2026-13', '2026-09-05')).toBe('2026-09');
		expect(calendarMonth('not-a-month', '2026-09-05')).toBe('2026-09');
		expect(calendarMonth('2026-02', '2026-09-05')).toBe('2026-02');
	});
});
