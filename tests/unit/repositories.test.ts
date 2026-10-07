import { describe, expect, it } from 'vitest';
import type { Viewer } from '$lib/server/auth/authz';
import {
	InvalidInput,
	isUuid,
	pageOf,
	resolveOwnership,
	toBool,
	toDayOrNull,
	toIntOrNull,
	toNumberOrNull
} from '$lib/server/repositories/base';
import { summariseHabit } from '$lib/server/repositories/habits';
import {
	optionalDay,
	optionalFraction,
	optionalInt,
	optionalText,
	patched,
	requiredText
} from '$lib/server/repositories/validate';

const HOUSE = '11111111-1111-1111-1111-111111111111';
const JORDAN = 'aaaaaaaa-0000-0000-0000-000000000001';
const PARTNER = 'aaaaaaaa-0000-0000-0000-000000000002';

const viewer: Viewer = { userId: JORDAN, householdId: HOUSE, role: 'member' };

describe('reading values back from the driver', () => {
	it('accepts the representations a date column arrives in', () => {
		expect(toDayOrNull('2026-09-05')).toBe('2026-09-05');
		// A Date only appears when a query forgot its ::text cast; this driver
		// parses `date` as UTC midnight, so the UTC components are the day.
		expect(toDayOrNull(new Date('2026-09-05T00:00:00Z'))).toBe('2026-09-05');
		expect(toDayOrNull('2026-09-05 00:00:00+00')).toBe('2026-09-05');
		expect(toDayOrNull(null)).toBeNull();
		expect(() => toDayOrNull('nonsense')).toThrow(TypeError);
	});

	it('coerces booleans, integers and numerics rather than trusting them', () => {
		expect(toBool(true)).toBe(true);
		expect(toBool('f')).toBe(false);
		expect(() => toBool('maybe')).toThrow(TypeError);
		expect(toIntOrNull('7')).toBe(7);
		expect(toIntOrNull(null)).toBeNull();
		// numeric arrives as a string so the driver cannot round it.
		expect(toNumberOrNull('0.3333')).toBeCloseTo(0.3333, 6);
	});

	it('recognises a uuid, so a mistyped url is a miss and not a crash', () => {
		expect(isUuid(HOUSE)).toBe(true);
		expect(isUuid('nope')).toBe(false);
		expect(isUuid(undefined)).toBe(false);
	});
});

describe('paging', () => {
	it('clamps so no caller can ask for the whole table', () => {
		expect(pageOf()).toEqual({ limit: 200, offset: 0 });
		expect(pageOf({ limit: 10_000 })).toEqual({ limit: 500, offset: 0 });
		expect(pageOf({ limit: 0, offset: -5 })).toEqual({ limit: 1, offset: 0 });
	});
});

describe('validation at the boundary', () => {
	it('trims, and treats an emptied field as cleared rather than as blank', () => {
		expect(requiredText('  Water the plants  ', 'title', 500)).toBe('Water the plants');
		expect(optionalText('   ', 'notes')).toBeNull();
		expect(() => requiredText('   ', 'title', 500)).toThrow(InvalidInput);
		expect(() => requiredText('x'.repeat(501), 'title', 500)).toThrow(InvalidInput);
	});

	it('refuses a date that is not a calendar date, and refuses a Date object', () => {
		expect(optionalDay('2026-09-05', 'do date')).toBe('2026-09-05');
		expect(optionalDay('', 'do date')).toBeNull();
		expect(() => optionalDay('2026-02-30', 'do date')).toThrow(InvalidInput);
		// Converting a Date means choosing a timezone, and only the caller knows.
		expect(() => optionalDay(new Date(), 'do date')).toThrow(InvalidInput);
	});

	it('enforces the numeric bounds the columns declare', () => {
		expect(optionalInt('3', 'energy', { min: 1, max: 5 })).toBe(3);
		expect(() => optionalInt(9, 'energy', { min: 1, max: 5 })).toThrow(InvalidInput);
		expect(optionalFraction(0.5, 'progress')).toBe(0.5);
		expect(() => optionalFraction(1.5, 'progress')).toThrow(InvalidInput);
	});

	it('distinguishes a field left alone from a field set to null', () => {
		expect(patched({}, 'notes', 'kept', (v) => optionalText(v, 'notes'))).toBe('kept');
		expect(patched({ notes: null }, 'notes', 'kept', (v) => optionalText(v, 'notes'))).toBeNull();
	});
});

describe('who may own a new record', () => {
	it('defaults to the author and to household visibility', () => {
		expect(resolveOwnership(viewer, {}, { ownerUserId: JORDAN, visibility: 'household' })).toEqual({
			ownerUserId: JORDAN,
			visibility: 'household'
		});
	});

	it('allows an explicitly unowned record, which either member may edit', () => {
		expect(
			resolveOwnership(
				viewer,
				{ ownerUserId: null },
				{ ownerUserId: JORDAN, visibility: 'household' }
			)
		).toEqual({ ownerUserId: null, visibility: 'household' });
	});

	it('refuses to create a record owned by the other member', () => {
		// canWrite would then deny the author: creating something you may not
		// edit is a trap, not a feature.
		expect(() =>
			resolveOwnership(
				viewer,
				{ ownerUserId: PARTNER },
				{ ownerUserId: JORDAN, visibility: 'household' }
			)
		).toThrow(InvalidInput);
	});

	it('leaves an owner it was not asked to change alone', () => {
		// An edit that does not mention the owner is not an attempt to reassign
		// it. Refusing here would report the other member's record as bad input
		// instead of as forbidden, which is what the scope in SQL says.
		expect(resolveOwnership(viewer, {}, { ownerUserId: PARTNER, visibility: 'household' })).toEqual(
			{ ownerUserId: PARTNER, visibility: 'household' }
		);
	});

	it('refuses a private record with no owner, which nobody could read', () => {
		// canRead matches a private record on owner identity, and null matches
		// no one — so this combination is a silent write-only hole.
		expect(() =>
			resolveOwnership(
				viewer,
				{ ownerUserId: null, visibility: 'private' },
				{ ownerUserId: JORDAN, visibility: 'household' }
			)
		).toThrow(InvalidInput);
	});
});

describe('habit period progress', () => {
	const daily = (completedDays: string[], today: string, target = 1) =>
		summariseHabit({
			completedDays,
			period: 'day',
			target,
			from: '2026-09-01',
			to: '2026-09-07',
			today
		});

	it('measures a weekly target in weeks, not in days', () => {
		// Three per week: the days chosen do not matter, only that each week
		// reaches three.
		const s = summariseHabit({
			completedDays: [
				'2026-08-31',
				'2026-09-02',
				'2026-09-04',
				'2026-09-07',
				'2026-09-08',
				'2026-09-11'
			],
			period: 'week',
			target: 3,
			from: '2026-08-31',
			to: '2026-09-13',
			today: '2026-09-13'
		});
		expect(s.periods.map((p) => p.key)).toEqual(['2026-08-31', '2026-09-07']);
		expect(s.periodsMet).toBe(2);
	});

	it('leaves a week short of its target unmet', () => {
		const s = summariseHabit({
			completedDays: ['2026-08-31', '2026-09-02'],
			period: 'week',
			target: 3,
			from: '2026-08-31',
			to: '2026-09-06',
			today: '2026-09-06'
		});
		expect(s.periodsMet).toBe(0);
		expect(s.completedCount).toBe(2);
		expect(s.expectedCount).toBe(3);
	});

	it('counts only the reported window, and caps the rate at fully done', () => {
		const s = daily(
			['2026-08-20', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'],
			'2026-09-04'
		);
		// The August check-in is outside the window but still real history; it
		// must not inflate the window's own completion count.
		expect(s.completedCount).toBe(4);
		expect(s.expectedCount).toBe(7);
		expect(s.completionRate).toBeCloseTo(4 / 7, 6);

		const over = summariseHabit({
			completedDays: ['2026-09-01', '2026-09-02'],
			period: 'week',
			target: 1,
			from: '2026-08-31',
			to: '2026-09-06',
			today: '2026-09-06'
		});
		expect(over.completionRate).toBe(1);
	});
});

/**
 * Kayla's own framing for the habit rework: "Missing once is normal. The
 * important behaviour is returning." No stored streak counts a broken run
 * any more (habits.ts's own header); these are the two numbers that replaced
 * it, and the boundaries that make "once is normal" actually true rather
 * than just stated.
 */
describe('last logged, and the plan-the-return nudge', () => {
	const daily = (completedDays: string[], today: string, target = 1) =>
		summariseHabit({
			completedDays,
			period: 'day',
			target,
			from: '2026-09-01',
			to: '2026-09-07',
			today
		});

	it('reports the most recent day logged, at or before today', () => {
		const s = daily(['2026-09-01', '2026-09-02', '2026-09-03'], '2026-09-03');
		expect(s.lastLoggedOn).toBe('2026-09-03');
		expect(s.planTheReturn).toBe(false);
	});

	it('does not prompt a return because today simply has not happened yet', () => {
		// Yesterday — the most recent period that has actually finished — was
		// logged, so today still being open is not itself a miss.
		const s = daily(['2026-09-01', '2026-09-02', '2026-09-03'], '2026-09-04');
		expect(s.lastLoggedOn).toBe('2026-09-03');
		expect(s.planTheReturn).toBe(false);
	});

	it('prompts a return once a whole day has passed with nothing logged', () => {
		// today is 09-05; the most recent FULL day is 09-04, which has no log —
		// 09-03 does, but that is not the period this asks about.
		const s = daily(['2026-09-01', '2026-09-02', '2026-09-03'], '2026-09-05');
		expect(s.lastLoggedOn).toBe('2026-09-03');
		expect(s.planTheReturn).toBe(true);
	});

	it('forgets an older gap once the habit has actually returned', () => {
		// Missed 09-04 and 09-05, then logged again on 09-06 — so by 09-07 the
		// most recent full day (09-06) is covered, and the earlier gap is not
		// still being held against it.
		const s = daily(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-06'], '2026-09-07');
		expect(s.lastLoggedOn).toBe('2026-09-06');
		expect(s.planTheReturn).toBe(false);
	});

	it('never compares the prior period against the target — any log counts as returning', () => {
		// Three per week, but last week only got one check-in. periodsMet would
		// call that week short; plan-the-return must not, because one check-in
		// out of three is still someone coming back.
		const s = summariseHabit({
			completedDays: ['2026-08-31', '2026-09-08'],
			period: 'week',
			target: 3,
			from: '2026-08-31',
			to: '2026-09-13',
			today: '2026-09-13'
		});
		expect(s.lastLoggedOn).toBe('2026-09-08');
		expect(s.planTheReturn).toBe(false);
	});

	it('reports nothing to return to when there is no history at all', () => {
		const s = daily([], '2026-09-04');
		expect(s.lastLoggedOn).toBeNull();
		expect(s.planTheReturn).toBe(false);
		expect(s.completionRate).toBe(0);
	});

	it('does not open a brand-new habit on the nudge the moment it is logged', () => {
		// Logged for the very first time today: there is no OLDER history for
		// yesterday's empty period to be a lapse FROM.
		const s = daily(['2026-09-04'], '2026-09-04');
		expect(s.lastLoggedOn).toBe('2026-09-04');
		expect(s.planTheReturn).toBe(false);
	});
});
