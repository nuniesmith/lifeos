import ICAL from 'ical.js';
import { isKnownZone, placeInZone, wallClockInZone } from '../zone';
import type { RemoteEvent } from './model';

/**
 * One CalDAV object (an .ics resource) as calendar_events rows.
 *
 * An object holds one event: its series, plus any instances moved or
 * cancelled (RECURRENCE-ID), all under the same URL. Every time is turned
 * into a wall clock in the series' own zone -- the start, the end, EXDATE,
 * RDATE and RECURRENCE-ID alike -- so matching an instance to the occurrence
 * it replaces is a string comparison (recurrence.ts).
 *
 * A malformed event is skipped rather than failing the calendar: one bad
 * object from a phone must not stop every other event from syncing.
 */

type Time = ICAL.Time;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function dateOf(t: Time): string {
	return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
}

function wallOf(t: Time): string {
	return `${dateOf(t)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
}

/**
 * The zone a property's time is written in: its TZID when Intl knows it,
 * 'UTC' for a Z time, null when floating. An unknown TZID (a Windows name, a
 * vendor label) is resolved through the object's own VTIMEZONE instead, in
 * `readTime`, so the event still lands at the right instant.
 */
function zoneOf(prop: ICAL.Property, t: Time): string | null {
	const tzid = prop.getParameter('tzid');
	if (typeof tzid === 'string' && isKnownZone(tzid)) return tzid;
	if (t.zone && (t.zone.tzid === 'UTC' || t.zone === ICAL.Timezone.utcTimezone)) return 'UTC';
	if (typeof tzid === 'string') return `vtimezone:${tzid}`;
	return null;
}

/** The instant of a time in `zone`; null for a floating time. */
function instantOf(t: Time, zone: string | null): Date | null {
	if (zone === null) return null;
	if (zone === 'UTC')
		return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second));
	if (zone.startsWith('vtimezone:')) return t.toJSDate();
	return placeInZone(wallOf(t), zone);
}

/** A time as a wall clock (or day) in the series' zone. */
function inSeriesZone(t: Time, zone: string | null, seriesZone: string | null): string {
	if (t.isDate) return dateOf(t);
	if (zone === seriesZone || zone === null || seriesZone === null) return wallOf(t);
	const instant = instantOf(t, zone);
	return instant ? wallClockInZone(instant, seriesZone) : wallOf(t);
}

function valuesOf(component: ICAL.Component, name: string): { prop: ICAL.Property; time: Time }[] {
	const out: { prop: ICAL.Property; time: Time }[] = [];
	for (const prop of component.getAllProperties(name)) {
		for (const v of prop.getValues()) {
			// RDATE may also be a PERIOD; only dates and date-times are kept.
			if (v instanceof ICAL.Time) out.push({ prop, time: v });
		}
	}
	return out;
}

function statusOf(value: unknown): RemoteEvent['status'] {
	const s = String(value ?? '').toLowerCase();
	return s === 'cancelled' || s === 'tentative' ? s : 'confirmed';
}

export function parseCalendarObject(
	ics: string,
	externalId: string,
	etag: string | null
): RemoteEvent[] {
	let root: ICAL.Component;
	try {
		root = new ICAL.Component(ICAL.parse(ics));
	} catch {
		return [];
	}
	// Register the object's own VTIMEZONEs, so an unknown TZID still converts.
	for (const tz of root.getAllSubcomponents('vtimezone')) {
		try {
			ICAL.TimezoneService.register(tz);
		} catch {
			// a broken VTIMEZONE only costs that zone's conversion
		}
	}

	const events: RemoteEvent[] = [];
	for (const vevent of root.getAllSubcomponents('vevent')) {
		try {
			const startProp = vevent.getFirstProperty('dtstart');
			const start = startProp?.getFirstValue();
			if (!startProp || !(start instanceof ICAL.Time)) continue;
			const event = new ICAL.Event(vevent);
			const allDay = start.isDate;

			let zone = allDay ? null : zoneOf(startProp, start);
			let startText: string;
			if (allDay) startText = dateOf(start);
			else if (zone?.startsWith('vtimezone:')) {
				// No IANA name: keep the instant, as UTC, which is exact for a
				// one-off and right except across DST for a series.
				startText = wallClockInZone(start.toJSDate(), 'UTC');
				zone = 'UTC';
			} else startText = wallOf(start);

			let endText: string;
			const end = event.endDate;
			if (allDay) {
				endText = end && end.isDate && dateOf(end) > startText ? dateOf(end) : nextDay(startText);
			} else if (end) {
				const endProp = vevent.getFirstProperty('dtend') ?? startProp;
				endText = inSeriesZone(end, zoneOf(endProp, end), zone);
				if (endText < startText) endText = startText;
			} else endText = startText;

			const recurrenceProp = vevent.getFirstProperty('recurrence-id');
			const recurrence = recurrenceProp?.getFirstValue();
			const rrule = vevent.getFirstPropertyValue('rrule');
			const lastModified = vevent.getFirstPropertyValue('last-modified');

			events.push({
				externalId,
				recurrenceId:
					recurrenceProp && recurrence instanceof ICAL.Time
						? inSeriesZone(recurrence, zoneOf(recurrenceProp, recurrence), zone)
						: '',
				uid: String(vevent.getFirstPropertyValue('uid') ?? externalId),
				etag,
				status: statusOf(vevent.getFirstPropertyValue('status')),
				summary: String(vevent.getFirstPropertyValue('summary') ?? ''),
				location: (vevent.getFirstPropertyValue('location') as string | null) ?? null,
				allDay,
				start: startText,
				end: endText,
				timeZone: zone,
				rrule: rrule instanceof ICAL.Recur ? rrule.toString() : null,
				exdates: valuesOf(vevent, 'exdate').map(({ prop, time }) =>
					inSeriesZone(time, zoneOf(prop, time), zone)
				),
				rdates: valuesOf(vevent, 'rdate').map(({ prop, time }) =>
					inSeriesZone(time, zoneOf(prop, time), zone)
				),
				lifeosKey: (vevent.getFirstPropertyValue('x-lifeos-key') as string | null) ?? null,
				remoteUpdatedAt:
					lastModified instanceof ICAL.Time ? lastModified.toJSDate().toISOString() : null
			});
		} catch {
			// skip this event, keep the rest of the object
		}
	}
	return events;
}

export function nextDay(day: string): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}
