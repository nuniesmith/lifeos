import { describe, expect, it } from 'vitest';
import { advanceDueDate, type BillFrequency } from '$lib/server/repositories/collections';

/**
 * The due-date arithmetic behind "mark paid" (PACK4-002): where a bill's
 * `next_due_on` lands after one payment, for every frequency the table's own
 * CHECK allows. Runs without a database, the same reason dates.ts's own
 * calendar rules do — a wrong clamp here is a quietly wrong due date on
 * /finance, not a crash.
 */

describe('advanceDueDate', () => {
	it('leaves a null due date null, whatever the frequency', () => {
		const frequencies: (BillFrequency | null)[] = [
			null,
			'weekly',
			'biweekly',
			'monthly',
			'quarterly',
			'annual',
			'one_off'
		];
		for (const frequency of frequencies) {
			expect(advanceDueDate(null, frequency)).toBeNull();
		}
	});

	it('leaves the due date exactly where it was when no frequency is recorded', () => {
		// Nothing to advance by a multiple of — guessing one would invent a
		// schedule nobody set.
		expect(advanceDueDate('2026-09-15', null)).toBe('2026-09-15');
	});

	it('clears the due date for a one-off: paying it is the end of it', () => {
		expect(advanceDueDate('2026-09-15', 'one_off')).toBeNull();
	});

	it('adds seven days for weekly and fourteen for biweekly, across a month boundary', () => {
		expect(advanceDueDate('2026-09-28', 'weekly')).toBe('2026-10-05');
		expect(advanceDueDate('2026-09-28', 'biweekly')).toBe('2026-10-12');
	});

	it('adds a calendar month, clamping the 31st into a shorter month', () => {
		expect(advanceDueDate('2026-01-31', 'monthly')).toBe('2026-02-28');
		expect(advanceDueDate('2026-03-31', 'monthly')).toBe('2026-04-30');
		// Not clamped further on the next step: the day-of-month a clamped date
		// resumes is where it landed, not the original 31st trying again.
		expect(advanceDueDate('2026-02-28', 'monthly')).toBe('2026-03-28');
	});

	it('clamps into February the leap-year-aware way', () => {
		// 2024 is a leap year: the 31st clamps to the 29th, not the 28th.
		expect(advanceDueDate('2024-01-31', 'monthly')).toBe('2024-02-29');
		expect(advanceDueDate('2025-01-31', 'monthly')).toBe('2025-02-28');
	});

	it('adds three months for quarterly, across a year boundary', () => {
		expect(advanceDueDate('2026-11-30', 'quarterly')).toBe('2027-02-28');
	});

	it('adds twelve months for annual, keeping the day of month', () => {
		expect(advanceDueDate('2026-09-15', 'annual')).toBe('2027-09-15');
		// A leap-day anniversary clamps in a common year.
		expect(advanceDueDate('2024-02-29', 'annual')).toBe('2025-02-28');
	});
});
