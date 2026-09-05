/**
 * Calendar arithmetic for the derived queries (MODEL-003).
 *
 * Every function here works on `YYYY-MM-DD` strings, never on Date objects
 * with a time component. A "day" in this application is a wall-clock date in
 * the household's timezone; the moment it becomes a timestamp, "today" starts
 * depending on where the process runs, and the Home view shows yesterday's
 * tasks to somebody. The one Date used internally is pinned to UTC so the
 * arithmetic cannot drift across a daylight-saving boundary.
 *
 * Pure and dependency-free, so the rules that decide what counts as overdue,
 * as this week, or as a broken streak are unit-testable without a database.
 */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Days in a month, with the leap year handled by the calendar itself. */
export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whether a string is a real calendar day, so `2026-02-30` is rejected. */
export function isDay(value: unknown): value is string {
	if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	if (month < 1 || month > 12 || day < 1) return false;
	return day <= daysInMonth(year, month);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Formats the UTC components of a Date as a day. */
export function formatDay(date: Date): string {
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Parses a day into a UTC-midnight Date, for arithmetic only. */
export function dayToUtc(day: string): Date {
	if (!isDay(day)) throw new TypeError(`not a calendar date: ${day}`);
	return new Date(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, amount: number): string {
	const d = dayToUtc(day);
	d.setUTCDate(d.getUTCDate() + amount);
	return formatDay(d);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
	return Math.round((dayToUtc(to).getTime() - dayToUtc(from).getTime()) / 86_400_000);
}

/** 0 is Sunday, matching `Date.getUTCDay` and PostgreSQL's `dow`. */
export function dayOfWeek(day: string): number {
	return dayToUtc(day).getUTCDay();
}

export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The calendar week containing a day, inclusive at both ends.
 *
 * Monday by default. "This week" in a planner means the current calendar week,
 * not the next seven days: on a Friday, a rolling window would quietly pull in
 * half of next week and make the view look busier than the week actually is.
 */
export function weekWindow(
	day: string,
	weekStartsOn: WeekStart = 1
): { start: string; end: string } {
	const back = (dayOfWeek(day) - weekStartsOn + 7) % 7;
	const start = addDays(day, -back);
	return { start, end: addDays(start, 6) };
}

export type Period = 'day' | 'week' | 'month';

/** The identity of the period a day falls in: its first day. */
export function periodKey(day: string, period: Period, weekStartsOn: WeekStart = 1): string {
	if (period === 'day') return day;
	if (period === 'week') return weekWindow(day, weekStartsOn).start;
	return `${day.slice(0, 7)}-01`;
}

/** The period before a period key. */
export function previousPeriod(key: string, period: Period): string {
	if (period === 'day') return addDays(key, -1);
	if (period === 'week') return addDays(key, -7);
	const year = Number(key.slice(0, 4));
	const month = Number(key.slice(5, 7));
	return month === 1 ? `${year - 1}-12-01` : `${year}-${pad(month - 1)}-01`;
}

/** Every period key from `from` to `to` inclusive, in order. */
export function periodsBetween(
	from: string,
	to: string,
	period: Period,
	weekStartsOn: WeekStart = 1
): string[] {
	if (daysBetween(from, to) < 0) return [];
	const last = periodKey(to, period, weekStartsOn);
	const keys: string[] = [];
	let key = periodKey(from, period, weekStartsOn);
	// Bounded so a mistaken range cannot spin: a decade of days is the ceiling.
	for (let guard = 0; guard < 4000 && key <= last; guard++) {
		keys.push(key);
		key = nextPeriod(key, period);
	}
	return keys;
}

/** The period after a period key. */
export function nextPeriod(key: string, period: Period): string {
	if (period === 'day') return addDays(key, 1);
	if (period === 'week') return addDays(key, 7);
	const year = Number(key.slice(0, 4));
	const month = Number(key.slice(5, 7));
	return month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
}

export type Recurrence = 'none' | 'yearly' | 'monthly' | 'custom';

/** A day-of-month clamped to a month that may be shorter. */
function onDayOfMonth(year: number, month: number, day: number): string {
	return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

/**
 * The first occurrence of a recurring date on or after `from`.
 *
 * The clamping matters for exactly the dates a household cares about: a 29
 * February anniversary lands on 28 February in a common year, and a 31st
 * monthly date lands on the 30th or the 28th rather than rolling into the next
 * month, which is what naive date addition does.
 *
 * `custom` is treated as one-off. `recurrence_rule` is free text that nothing
 * yet parses, and inventing a reading of it here would silently schedule
 * reminders on days the household never chose.
 */
export function nextOccurrence(
	onDate: string,
	recurrence: Recurrence,
	from: string
): string | null {
	if (!isDay(onDate) || !isDay(from)) throw new TypeError('expected calendar dates');
	// A recurrence never fires before the date it was set on.
	if (onDate >= from) return onDate;
	if (recurrence === 'none' || recurrence === 'custom') return null;

	const day = Number(onDate.slice(8, 10));

	if (recurrence === 'yearly') {
		const month = Number(onDate.slice(5, 7));
		const year = Number(from.slice(0, 4));
		for (const candidateYear of [year, year + 1]) {
			const candidate = onDayOfMonth(candidateYear, month, day);
			if (candidate >= from) return candidate;
		}
		return null;
	}

	let year = Number(from.slice(0, 4));
	let month = Number(from.slice(5, 7));
	// Thirteen months covers a full year plus the clamped month-end case.
	for (let i = 0; i < 13; i++) {
		const candidate = onDayOfMonth(year, month, day);
		if (candidate >= from) return candidate;
		if (month === 12) {
			year += 1;
			month = 1;
		} else {
			month += 1;
		}
	}
	return null;
}
