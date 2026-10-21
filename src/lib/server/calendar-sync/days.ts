import type { Viewer } from '../auth/authz';
import type { Queryable } from '../repositories/base';
import { visibleEvents } from '../repositories/calendar-sync';
import { dayInZone, wallClockInZone } from '../zone';
import { expandOccurrences } from './recurrence';

/** An event from a connected calendar, placed on one household day. */
export interface ExternalDay {
	id: string;
	title: string;
	day: string;
	/** 'HH:MM' in the household's zone; null for an all-day event. */
	time: string | null;
	color: string | null;
	calendar: string;
}

/** Enough for any month; a calendar with more on one page is not one to read. */
const LIMIT = 1000;

function addDays(day: string, n: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/**
 * The connected calendars' events for [fromDay, toDay], one entry per day
 * they touch: an all-day event on each of its days, a timed one on the day
 * it starts, at its time, both in the household's zone.
 */
export async function externalDays(
	sql: Queryable,
	viewer: Viewer,
	fromDay: string,
	toDay: string
): Promise<ExternalDay[]> {
	const [household] = await sql<{ timezone: string }[]>`
		select timezone from households where id = ${viewer.householdId}
	`;
	const zone = household?.timezone ?? 'UTC';
	const { events, sources } = await visibleEvents(sql, viewer, fromDay, toDay);
	if (events.length === 0) return [];

	const out: ExternalDay[] = [];
	for (const o of expandOccurrences(events, { fromDay, toDay, zone }, sources)) {
		const base = { title: o.summary || '(no title)', color: o.color, calendar: o.sourceName };
		if (o.allDay) {
			for (
				let d = o.start < fromDay ? fromDay : o.start;
				d < o.end && d <= toDay;
				d = addDays(d, 1)
			) {
				out.push({ ...base, id: `${o.eventId}:${o.start}:${d}`, day: d, time: null });
			}
		} else {
			const start = new Date(o.start);
			const day = dayInZone(start, zone);
			if (day >= fromDay && day <= toDay) {
				out.push({
					...base,
					id: `${o.eventId}:${o.start}`,
					day,
					time: wallClockInZone(start, zone).slice(11, 16)
				});
			}
		}
		if (out.length >= LIMIT) break;
	}
	return out;
}
