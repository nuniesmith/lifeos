/**
 * One shape for an event from either provider, as calendar_events stores it.
 *
 * Times are wall clocks in `timeZone`, not instants: a series recurs in
 * wall-clock time, so its 9 am stays 9 am across a DST change. A timed
 * event's start and end are 'YYYY-MM-DDTHH:MM:SS'; an all-day event's are
 * 'YYYY-MM-DD', the end exclusive. `timeZone` is an IANA zone, 'UTC', or
 * null for a floating time, which is read in the household's zone.
 */
export interface RemoteEvent {
	/** Google: the event's id. CalDAV: the object's URL. */
	externalId: string;
	/** For a moved or cancelled instance of a series: the start it replaces. '' otherwise. */
	recurrenceId: string;
	uid: string;
	etag: string | null;
	status: 'confirmed' | 'tentative' | 'cancelled';
	summary: string;
	location: string | null;
	allDay: boolean;
	start: string;
	end: string;
	timeZone: string | null;
	/** The RRULE value, without the "RRULE:" prefix. */
	rrule: string | null;
	/** Excluded starts, in the same form and zone as `start`. */
	exdates: string[];
	/** Extra starts, in the same form and zone as `start`. */
	rdates: string[];
	/** Set on events LifeOS pushed itself. */
	lifeosKey: string | null;
	remoteUpdatedAt: string | null;
}

/** One occurrence on a calendar page. Timed ones have instants, all-day ones days. */
export interface Occurrence {
	eventId: string;
	sourceId: string;
	sourceName: string;
	color: string | null;
	summary: string;
	location: string | null;
	allDay: boolean;
	/** Timed: the start and end instants (ISO). All-day: the days, end exclusive. */
	start: string;
	end: string;
	tentative: boolean;
}

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
