import { describe, expect, it } from 'vitest';
import {
	addDays,
	dayOfWeek,
	daysBetween,
	daysInMonth,
	isDay,
	nextOccurrence,
	nextPeriod,
	periodKey,
	periodsBetween,
	previousPeriod,
	weekWindow
} from '$lib/server/repositories/dates';

/**
 * The calendar rules behind "overdue", "this week", and the next birthday.
 *
 * These run without a database on purpose: they are the definitions the whole
 * derived layer is built on, and a wrong one is a quiet wrong number on the
 * Home page rather than a crash.
 */

describe('calendar days', () => {
	it('accepts a real day and rejects one the calendar does not have', () => {
		expect(isDay('2026-09-05')).toBe(true);
		expect(isDay('2026-02-30')).toBe(false);
		expect(isDay('2026-13-01')).toBe(false);
		expect(isDay('2026-9-5')).toBe(false);
		expect(isDay('not a date')).toBe(false);
		expect(isDay(new Date())).toBe(false);
	});

	it('knows February in a leap year and a common year', () => {
		expect(daysInMonth(2024, 2)).toBe(29);
		expect(daysInMonth(2026, 2)).toBe(28);
		expect(isDay('2024-02-29')).toBe(true);
		expect(isDay('2026-02-29')).toBe(false);
	});

	it('adds days across a month and a year boundary', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
	});

	it('counts days in both directions', () => {
		expect(daysBetween('2026-09-01', '2026-09-08')).toBe(7);
		expect(daysBetween('2026-09-08', '2026-09-01')).toBe(-7);
		expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0);
	});

	it('does not drift when the arithmetic crosses a daylight-saving change', () => {
		// Canada springs forward on 8 March 2026. Local-time arithmetic loses
		// or gains an hour here and can land a day early.
		expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
		expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
		expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
		expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
	});
});

describe('the working week', () => {
	it('starts on Monday by default and includes both ends', () => {
		expect(dayOfWeek('2026-08-31')).toBe(1);
		// A Saturday is still inside the week that began the previous Monday.
		expect(weekWindow('2026-09-05')).toEqual({ start: '2026-08-31', end: '2026-09-06' });
		expect(weekWindow('2026-08-31')).toEqual({ start: '2026-08-31', end: '2026-09-06' });
		expect(weekWindow('2026-09-06')).toEqual({ start: '2026-08-31', end: '2026-09-06' });
	});

	it('can start on Sunday for a household that reads a calendar that way', () => {
		expect(weekWindow('2026-09-05', 0)).toEqual({ start: '2026-08-30', end: '2026-09-05' });
	});
});

describe('periods', () => {
	it('identifies a period by its first day', () => {
		expect(periodKey('2026-09-05', 'day')).toBe('2026-09-05');
		expect(periodKey('2026-09-05', 'week')).toBe('2026-08-31');
		expect(periodKey('2026-09-05', 'month')).toBe('2026-09-01');
	});

	it('steps backwards and forwards, including over a year end', () => {
		expect(previousPeriod('2026-09-05', 'day')).toBe('2026-09-04');
		expect(previousPeriod('2026-08-31', 'week')).toBe('2026-08-24');
		expect(previousPeriod('2026-01-01', 'month')).toBe('2025-12-01');
		expect(nextPeriod('2026-12-01', 'month')).toBe('2027-01-01');
	});

	it('enumerates the periods a window covers', () => {
		expect(periodsBetween('2026-09-01', '2026-09-03', 'day')).toEqual([
			'2026-09-01',
			'2026-09-02',
			'2026-09-03'
		]);
		// A window that straddles two weeks covers both, even partially.
		expect(periodsBetween('2026-09-05', '2026-09-07', 'week')).toEqual([
			'2026-08-31',
			'2026-09-07'
		]);
		expect(periodsBetween('2026-09-03', '2026-09-01', 'day')).toEqual([]);
	});
});

describe('the next occurrence of an important date', () => {
	it('returns a one-off date only while it is still ahead', () => {
		expect(nextOccurrence('2026-09-10', 'none', '2026-09-05')).toBe('2026-09-10');
		expect(nextOccurrence('2026-09-05', 'none', '2026-09-05')).toBe('2026-09-05');
		expect(nextOccurrence('2026-09-01', 'none', '2026-09-05')).toBeNull();
	});

	it('rolls a birthday to this year, then to next year once it has passed', () => {
		expect(nextOccurrence('1985-11-20', 'yearly', '2026-09-05')).toBe('2026-11-20');
		expect(nextOccurrence('1985-03-02', 'yearly', '2026-09-05')).toBe('2027-03-02');
		// The anniversary falling today is today's, not next year's.
		expect(nextOccurrence('1985-09-05', 'yearly', '2026-09-05')).toBe('2026-09-05');
	});

	it('clamps a 29 February anniversary into a common year', () => {
		expect(nextOccurrence('2024-02-29', 'yearly', '2026-01-01')).toBe('2026-02-28');
		expect(nextOccurrence('2024-02-29', 'yearly', '2028-01-01')).toBe('2028-02-29');
	});

	it('clamps a month-end monthly date instead of rolling into the next month', () => {
		expect(nextOccurrence('2026-01-31', 'monthly', '2026-02-01')).toBe('2026-02-28');
		expect(nextOccurrence('2026-01-31', 'monthly', '2026-03-01')).toBe('2026-03-31');
		expect(nextOccurrence('2026-01-15', 'monthly', '2026-09-20')).toBe('2026-10-15');
	});

	it('never fires a recurrence before the date it was set on', () => {
		expect(nextOccurrence('2030-06-01', 'yearly', '2026-09-05')).toBe('2030-06-01');
	});

	it('treats an unparsed custom rule as one-off rather than guessing', () => {
		// recurrence_rule is free text that nothing reads yet; inventing a
		// reading here would schedule reminders the household never asked for.
		expect(nextOccurrence('2026-09-01', 'custom', '2026-09-05')).toBeNull();
		expect(nextOccurrence('2026-09-10', 'custom', '2026-09-05')).toBe('2026-09-10');
	});
});
