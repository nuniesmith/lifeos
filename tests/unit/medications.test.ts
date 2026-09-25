import { describe, expect, it } from 'vitest';
import { computeDueStatus, type Medication } from '$lib/server/repositories/medications';

/**
 * `computeDueStatus` recomputes the source's `Due Today?` / `Next Due`
 * formulas (migration 0018). It is pure — no database — so every branch of
 * the schedule is exercised directly here rather than through a repository
 * round trip.
 */

const med = (
	overrides: Partial<Pick<Medication, 'scheduleKind' | 'scheduledWeekday' | 'intervalDays'>>
): Pick<Medication, 'scheduleKind' | 'scheduledWeekday' | 'intervalDays'> => ({
	scheduleKind: 'as_needed',
	scheduledWeekday: null,
	intervalDays: null,
	...overrides
});

const TODAY = '2026-09-24'; // a Thursday

describe('a daily medication', () => {
	it('is due today when it has not been logged today', () => {
		const status = computeDueStatus(med({ scheduleKind: 'daily_am' }), [], TODAY);
		expect(status).toEqual({ lastTakenOn: null, nextDueOn: TODAY, isDueToday: true });
	});

	it('stops being due the moment today is logged', () => {
		const status = computeDueStatus(med({ scheduleKind: 'daily_am' }), [TODAY], TODAY);
		expect(status.isDueToday).toBe(false);
		expect(status.lastTakenOn).toBe(TODAY);
	});

	it('is due again the next day even though it was taken yesterday', () => {
		const status = computeDueStatus(med({ scheduleKind: 'daily_pm' }), ['2026-09-23'], TODAY);
		expect(status).toMatchObject({ lastTakenOn: '2026-09-23', nextDueOn: TODAY, isDueToday: true });
	});
});

describe('an as-needed medication', () => {
	it('is never "due", regardless of history', () => {
		expect(computeDueStatus(med({}), [], TODAY)).toEqual({
			lastTakenOn: null,
			nextDueOn: null,
			isDueToday: false
		});
		expect(computeDueStatus(med({}), ['2026-01-01'], TODAY)).toMatchObject({
			nextDueOn: null,
			isDueToday: false
		});
	});

	it('still reports when it was last taken, for the history line', () => {
		const status = computeDueStatus(med({}), [TODAY, '2026-09-20'], TODAY);
		expect(status.lastTakenOn).toBe(TODAY);
	});
});

describe('a scheduled medication with a weekday', () => {
	// TODAY (2026-09-24) is a Thursday: dayOfWeek 4.
	it('is due today when today is the weekday and it is not logged yet', () => {
		const status = computeDueStatus(
			med({ scheduleKind: 'scheduled', scheduledWeekday: 4 }),
			[],
			TODAY
		);
		expect(status).toEqual({ lastTakenOn: null, nextDueOn: TODAY, isDueToday: true });
	});

	it('is not due today once today’s dose is logged', () => {
		const status = computeDueStatus(
			med({ scheduleKind: 'scheduled', scheduledWeekday: 4 }),
			[TODAY],
			TODAY
		);
		expect(status.isDueToday).toBe(false);
	});

	it('finds the next matching weekday when today is not it', () => {
		// Friday (5) is one day after Thursday.
		const status = computeDueStatus(
			med({ scheduleKind: 'scheduled', scheduledWeekday: 5 }),
			[],
			TODAY
		);
		expect(status).toEqual({ lastTakenOn: null, nextDueOn: '2026-09-25', isDueToday: false });
	});

	it('wraps to next week when the weekday has already passed this week', () => {
		// Monday (1) already happened this week (Thursday is later in the week).
		const status = computeDueStatus(
			med({ scheduleKind: 'scheduled', scheduledWeekday: 1 }),
			[],
			TODAY
		);
		expect(status.nextDueOn).toBe('2026-09-28');
	});
});

describe('a scheduled medication with an interval', () => {
	it('is due immediately when it has never been taken', () => {
		const status = computeDueStatus(
			med({ scheduleKind: 'scheduled', intervalDays: 30 }),
			[],
			TODAY
		);
		expect(status).toEqual({ lastTakenOn: null, nextDueOn: TODAY, isDueToday: true });
	});

	it('is not due while inside the interval', () => {
		const status = computeDueStatus(
			med({ scheduleKind: 'scheduled', intervalDays: 30 }),
			['2026-09-20'],
			TODAY
		);
		expect(status).toEqual({
			lastTakenOn: '2026-09-20',
			nextDueOn: '2026-10-20',
			isDueToday: false
		});
	});

	it('stays "due" once the interval is missed, rather than going quiet', () => {
		// Interval is 7 days; last taken 10 days ago, never re-logged.
		const status = computeDueStatus(
			med({ scheduleKind: 'scheduled', intervalDays: 7 }),
			['2026-09-14'],
			TODAY
		);
		expect(status.nextDueOn).toBe('2026-09-21');
		expect(status.isDueToday).toBe(true);
	});

	it('clears once the overdue dose is finally logged today', () => {
		const status = computeDueStatus(
			med({ scheduleKind: 'scheduled', intervalDays: 7 }),
			[TODAY, '2026-09-14'],
			TODAY
		);
		expect(status.isDueToday).toBe(false);
	});
});

describe('a scheduled medication with neither a weekday nor an interval', () => {
	it('reports an unknown next-due date rather than guessing one', () => {
		// The one row migration 0018 cannot resolve from the database alone —
		// see its comment on the `medications` table.
		const status = computeDueStatus(med({ scheduleKind: 'scheduled' }), ['2026-08-01'], TODAY);
		expect(status).toEqual({ lastTakenOn: '2026-08-01', nextDueOn: null, isDueToday: false });
	});
});
