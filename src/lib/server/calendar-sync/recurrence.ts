import ICAL from 'ical.js';
import { placeInZone } from '../zone';
import { DATE, type Occurrence, type RemoteEvent } from './model';
import { nextDay } from './ics';

/**
 * Stored events -> the occurrences a page shows for a range of days.
 *
 * A series is expanded in wall-clock time, in its own zone (ical.js iterates
 * the RRULE over a floating start), and only then placed as instants, so a
 * 9 am meeting stays at 9 am on both sides of a DST change. From the rule's
 * occurrences come away the EXDATEs and the instances that a moved or
 * cancelled row replaces; RDATEs are added; the moved instances and the
 * one-offs are their own occurrences.
 *
 * Bounded: an endless series stops at the end of the window, and no series
 * yields more than MAX_STEPS candidates, so a pathological rule (every
 * second, forever) costs a bounded amount of work, not a hung page.
 */

export interface StoredEvent extends RemoteEvent {
	id: string;
	sourceId: string;
}

export interface SourceMeta {
	name: string;
	color: string | null;
}

export interface Window {
	/** Household days, inclusive. */
	fromDay: string;
	toDay: string;
	/** The household's zone, for floating times and for the window's edges. */
	zone: string;
}

const MAX_STEPS = 5000;

interface Span {
	allDay: boolean;
	/** Timed: ms since the epoch. All-day: the day. */
	start: number | string;
	end: number | string;
}

function spanOf(e: { allDay: boolean; start: string; end: string }, zone: string): Span {
	if (e.allDay) return { allDay: true, start: e.start, end: e.end };
	return { allDay: false, start: instant(e.start, zone), end: instant(e.end, zone) };
}

function instant(wall: string, zone: string): number {
	return zone === 'UTC' ? Date.parse(`${wall}Z`) : placeInZone(wall, zone).getTime();
}

function overlaps(span: Span, w: Window, edges: { from: number; to: number }): boolean {
	if (span.allDay) return (span.start as string) <= w.toDay && (span.end as string) > w.fromDay;
	const start = span.start as number;
	const end = span.end as number;
	// An event ending exactly as the window opens (23:00 to midnight the day
	// before) is not in it; a zero-length one at the window's start is.
	return start < edges.to && (end > edges.from || (end === start && start >= edges.from));
}

function addDays(day: string, n: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
	return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function floatingTime(text: string): ICAL.Time {
	const allDay = DATE.test(text);
	const [y, mo, d] = text.slice(0, 10).split('-').map(Number);
	const [h, mi, s] = allDay ? [0, 0, 0] : text.slice(11).split(':').map(Number);
	const t = new ICAL.Time(
		{ year: y!, month: mo!, day: d!, hour: h!, minute: mi!, second: s!, isDate: allDay },
		ICAL.Timezone.localTimezone
	);
	return t;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function textOf(t: ICAL.Time): string {
	const day = `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
	return t.isDate ? day : `${day}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
}

function toOccurrence(e: StoredEvent, span: Span, meta: SourceMeta): Occurrence {
	return {
		eventId: e.id,
		sourceId: e.sourceId,
		sourceName: meta.name,
		color: meta.color,
		summary: e.summary,
		location: e.location,
		allDay: span.allDay,
		start: span.allDay ? (span.start as string) : new Date(span.start as number).toISOString(),
		end: span.allDay ? (span.end as string) : new Date(span.end as number).toISOString(),
		tentative: e.status === 'tentative'
	};
}

/**
 * Where to start iterating a series so the window is reached quickly. A
 * daily or weekly rule with no COUNT repeats exactly every INTERVAL days or
 * weeks, so its start can jump forward by whole periods to just before the
 * window: a daily series begun in 2010 otherwise spends its whole step budget
 * before reaching this month. (COUNT has to be counted from the real start,
 * and month and year steps are few enough to iterate.)
 */
function iterationStart(series: StoredEvent, recur: ICAL.Recur, fromDay: string): string {
	const periodDays = recur.freq === 'DAILY' ? 1 : recur.freq === 'WEEKLY' ? 7 : 0;
	if (!periodDays || recur.count) return series.start;
	const step = periodDays * (recur.interval || 1);
	const behind = daysBetween(series.start.slice(0, 10), fromDay);
	const periods = Math.floor(behind / step) - 1;
	if (periods <= 0) return series.start;
	return addDays(series.start.slice(0, 10), periods * step) + series.start.slice(10);
}

/** The starts a series' rule yields from about `fromDay` to `untilDay`. */
function ruleStarts(series: StoredEvent, fromDay: string, untilDay: string): string[] {
	const out: string[] = [];
	if (!series.rrule) return out;
	let recur: ICAL.Recur;
	try {
		recur = ICAL.Recur.fromString(series.rrule);
	} catch {
		return [series.start];
	}
	const it = recur.iterator(floatingTime(iterationStart(series, recur, fromDay)));
	for (let step = 0; step < MAX_STEPS; step++) {
		const next = it.next();
		if (!next) break;
		const text = textOf(next);
		if (text.slice(0, 10) > untilDay) break;
		out.push(text);
	}
	return out;
}

export function expandOccurrences(
	events: StoredEvent[],
	window: Window,
	meta: Map<string, SourceMeta>
): Occurrence[] {
	const edges = {
		from: placeInZone(`${window.fromDay}T00:00:00`, window.zone).getTime(),
		to: placeInZone(`${nextDay(window.toDay)}T00:00:00`, window.zone).getTime()
	};
	// Instances replace occurrences of the series with the same uid in the
	// same calendar; a cancelled one replaces it with nothing.
	const replaced = new Set<string>();
	for (const e of events) {
		if (e.recurrenceId) replaced.add(`${e.sourceId}\u0000${e.uid}\u0000${e.recurrenceId}`);
	}

	const out: Occurrence[] = [];
	for (const e of events) {
		const source = meta.get(e.sourceId) ?? { name: '', color: null };
		const zone = e.timeZone ?? window.zone;
		if (e.status === 'cancelled') continue;

		if (!e.rrule || e.recurrenceId) {
			const span = spanOf(e, zone);
			if (overlaps(span, window, edges)) out.push(toOccurrence(e, span, source));
			continue;
		}

		// A series: its length, then each start the rule yields (a day of
		// margin past the window, for zones ahead of the household's).
		const length = e.allDay
			? Math.max(1, daysBetween(e.start, e.end))
			: Math.max(0, instant(e.end, zone) - instant(e.start, zone));
		const excluded = new Set(e.exdates);
		const starts = [
			...ruleStarts(e, addDays(window.fromDay, -1), addDays(window.toDay, 1)),
			...e.rdates
		];
		const seen = new Set<string>();
		for (const start of starts) {
			if (seen.has(start) || excluded.has(start)) continue;
			seen.add(start);
			if (replaced.has(`${e.sourceId}\u0000${e.uid}\u0000${start}`)) continue;
			const span: Span = e.allDay
				? { allDay: true, start, end: addDays(start, length) }
				: (() => {
						const at = instant(DATE.test(start) ? `${start}T00:00:00` : start, zone);
						return { allDay: false, start: at, end: at + length };
					})();
			if (overlaps(span, window, edges)) out.push(toOccurrence(e, span, source));
		}
	}
	return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
