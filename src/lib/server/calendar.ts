import { addDays, daysBetween, isDay, weekWindow } from './repositories/dates';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A stable six-week grid, always starting on Monday. */
export interface CalendarWindow {
	month: string;
	from: string;
	to: string;
}

export function calendarMonth(value: string | null | undefined, fallback: string): string {
	const candidate = value ?? '';
	return MONTH_PATTERN.test(candidate) && isDay(`${candidate}-01`)
		? candidate
		: fallback.slice(0, 7);
}

export function calendarWindowForMonth(month: string): CalendarWindow {
	if (!MONTH_PATTERN.test(month) || !isDay(`${month}-01`)) {
		throw new TypeError(`not a calendar month: ${month}`);
	}
	const first = `${month}-01`;
	const week = weekWindow(first, 1);
	return { month, from: week.start, to: addDays(week.start, 41) };
}

export function calendarDays(window: CalendarWindow): number {
	return daysBetween(window.from, window.to);
}
