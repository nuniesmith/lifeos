import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isKnownZone, placeInZone, wallClockInZone } from '../zone';
import type { RemoteEvent } from './model';

/**
 * Google Calendar over its REST API, as a service account.
 *
 * Why a service account and not OAuth (decided 2026-10-06): an OAuth app left
 * in "Testing" has its refresh tokens expire after 7 days for calendar
 * scopes, and leaving Testing means Google's verification. A service account
 * never expires; the person shares each calendar with its address instead
 * ("See all event details" to read one, "Make changes to events" for the
 * calendar LifeOS writes to). It can't invite attendees, which LifeOS never
 * does.
 *
 * Sync is incremental with events.list's syncToken (decided over push
 * notifications, which need a public HTTPS endpoint; LifeOS is tailnet-only).
 * singleEvents stays false: expanding instances needs timeMin/timeMax, which
 * Google refuses alongside a syncToken, and an endless series has endless
 * instances. So series come as series, and recurrence.ts expands them.
 */

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

export interface ServiceAccount {
	clientEmail: string;
	privateKey: string;
	tokenUri: string;
}

export async function readServiceAccount(path: string): Promise<ServiceAccount> {
	const json = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
	const clientEmail = json.client_email;
	const privateKey = json.private_key;
	if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
		throw new Error(`${path} is not a service account key (no client_email / private_key)`);
	}
	return {
		clientEmail,
		privateKey,
		tokenUri:
			typeof json.token_uri === 'string' ? json.token_uri : 'https://oauth2.googleapis.com/token'
	};
}

/** The sync token is too old: wipe this calendar's events and sync it in full. */
export class SyncTokenExpired extends Error {}

export class GoogleError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** The signed JWT a service account trades for an access token. */
export function serviceAccountAssertion(account: ServiceAccount, now = Date.now()): string {
	const iat = Math.floor(now / 1000);
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = b64url(
		JSON.stringify({
			iss: account.clientEmail,
			scope: CALENDAR_SCOPE,
			aud: account.tokenUri,
			iat,
			exp: iat + 3600
		})
	);
	const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.privateKey);
	return `${header}.${claims}.${b64url(signature)}`;
}

export interface GoogleEventBody {
	summary: string;
	description?: string;
	location?: string;
	start: { date: string } | { dateTime: string; timeZone: string };
	end: { date: string } | { dateTime: string; timeZone: string };
	recurrence?: string[];
	transparency?: 'opaque' | 'transparent';
	reminders?: { useDefault: boolean };
	source?: { title: string; url: string };
	extendedProperties?: { private: Record<string, string> };
}

/** The parts of a Google event this module reads. */
export interface GoogleEvent {
	id: string;
	status?: 'confirmed' | 'tentative' | 'cancelled';
	etag?: string;
	iCalUID?: string;
	summary?: string;
	location?: string;
	updated?: string;
	start?: { date?: string; dateTime?: string; timeZone?: string };
	end?: { date?: string; dateTime?: string; timeZone?: string };
	recurrence?: string[];
	recurringEventId?: string;
	originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
	extendedProperties?: { private?: Record<string, string> };
}

export interface GoogleClientOptions {
	account: ServiceAccount;
	/** For tests: where the Calendar API lives (default Google's). */
	apiBase?: string;
	fetch?: typeof fetch;
}

export class GoogleClient {
	private token: { value: string; expires: number } | null = null;
	private readonly apiBase: string;
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly options: GoogleClientOptions) {
		this.apiBase = (options.apiBase ?? 'https://www.googleapis.com/calendar/v3').replace(/\/$/, '');
		this.fetchImpl = options.fetch ?? fetch;
	}

	get serviceAccountEmail(): string {
		return this.options.account.clientEmail;
	}

	private async accessToken(): Promise<string> {
		if (this.token && this.token.expires - 60_000 > Date.now()) return this.token.value;
		const res = await this.fetchImpl(this.options.account.tokenUri, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: serviceAccountAssertion(this.options.account)
			})
		});
		const body = (await res.json().catch(() => ({}))) as {
			access_token?: string;
			expires_in?: number;
			error_description?: string;
		};
		if (!res.ok || !body.access_token) {
			throw new GoogleError(
				res.status,
				`Google sign-in failed: ${body.error_description ?? res.status}`
			);
		}
		this.token = {
			value: body.access_token,
			expires: Date.now() + (body.expires_in ?? 3600) * 1000
		};
		return body.access_token;
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.fetchImpl(`${this.apiBase}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${await this.accessToken()}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (res.status === 204) return undefined as T;
		const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
		if (!res.ok) {
			throw new GoogleError(res.status, data.error?.message ?? `Google answered ${res.status}`);
		}
		return data;
	}

	/** The calendar's name and zone; a 404 means it isn't shared with the account. */
	async getCalendar(calendarId: string): Promise<{ summary: string; timeZone: string | null }> {
		const cal = await this.call<{ summary?: string; timeZone?: string }>(
			'GET',
			`/calendars/${encodeURIComponent(calendarId)}`
		);
		return { summary: cal.summary ?? calendarId, timeZone: cal.timeZone ?? null };
	}

	/**
	 * Everything changed since `syncToken` (every event, without one), page
	 * by page, deletions included. Throws SyncTokenExpired on 410.
	 */
	async listEvents(
		calendarId: string,
		syncToken: string | null
	): Promise<{ events: GoogleEvent[]; nextSyncToken: string }> {
		const events: GoogleEvent[] = [];
		let pageToken: string | undefined;
		for (;;) {
			const query = new URLSearchParams({ maxResults: '2500', showDeleted: 'true' });
			if (syncToken) query.set('syncToken', syncToken);
			if (pageToken) query.set('pageToken', pageToken);
			let page: { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
			try {
				page = await this.call(
					'GET',
					`/calendars/${encodeURIComponent(calendarId)}/events?${query}`
				);
			} catch (err) {
				if (err instanceof GoogleError && err.status === 410)
					throw new SyncTokenExpired(err.message);
				throw err;
			}
			events.push(...(page.items ?? []));
			if (page.nextPageToken) {
				pageToken = page.nextPageToken;
				continue;
			}
			if (!page.nextSyncToken) throw new GoogleError(500, 'Google returned no sync token');
			return { events, nextSyncToken: page.nextSyncToken };
		}
	}

	insertEvent(calendarId: string, body: GoogleEventBody): Promise<GoogleEvent> {
		return this.call('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body);
	}

	/** A full replacement, so a field LifeOS stopped sending is cleared too. */
	updateEvent(calendarId: string, eventId: string, body: GoogleEventBody): Promise<GoogleEvent> {
		return this.call(
			'PUT',
			`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			body
		);
	}

	async deleteEvent(calendarId: string, eventId: string): Promise<void> {
		try {
			await this.call(
				'DELETE',
				`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
			);
		} catch (err) {
			// Already gone (deleted by hand in Google) is what was wanted.
			if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) return;
			throw err;
		}
	}
}

// ─── mapping ────────────────────────────────────────────────────────────────

const ICS_STAMP = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/** An EXDATE/RDATE value ('20261028T090000', '…Z', '20261028') in the series' zone. */
function recurrenceValue(
	value: string,
	tzid: string | null,
	seriesZone: string | null
): string | null {
	const m = ICS_STAMP.exec(value.trim());
	if (!m) return null;
	const [, y, mo, d, h, mi, s, z] = m;
	const day = `${y}-${mo}-${d}`;
	if (h === undefined) return day;
	const wall = `${day}T${h}:${mi}:${s}`;
	const from = z ? 'UTC' : tzid && isKnownZone(tzid) ? tzid : seriesZone;
	if (!seriesZone || from === seriesZone || !from) return wall;
	const instant = from === 'UTC' ? new Date(`${wall}Z`) : placeInZone(wall, from);
	return wallClockInZone(instant, seriesZone);
}

function parseRecurrence(lines: string[] | undefined, seriesZone: string | null) {
	let rrule: string | null = null;
	const exdates: string[] = [];
	const rdates: string[] = [];
	for (const line of lines ?? []) {
		const colon = line.indexOf(':');
		if (colon < 0) continue;
		const [name, ...params] = line.slice(0, colon).split(';');
		const values = line.slice(colon + 1);
		const tzid = params.find((p) => p.toUpperCase().startsWith('TZID='))?.slice(5) ?? null;
		const upper = name?.toUpperCase();
		if (upper === 'RRULE') rrule = values;
		else if (upper === 'EXDATE' || upper === 'RDATE') {
			const target = upper === 'EXDATE' ? exdates : rdates;
			for (const v of values.split(',')) {
				const text = recurrenceValue(v, tzid, seriesZone);
				if (text) target.push(text);
			}
		}
	}
	return { rrule, exdates, rdates };
}

function timeOf(
	t: { date?: string; dateTime?: string; timeZone?: string } | undefined,
	zone: string | null
): string | null {
	if (!t) return null;
	if (t.date) return t.date;
	if (!t.dateTime) return null;
	return wallClockInZone(new Date(t.dateTime), zone ?? 'UTC');
}

/**
 * A Google event as a calendar_events row; null for one to delete (a
 * cancelled series or one-off). A cancelled *instance* of a series is kept,
 * as a cancelled row: it is what removes that occurrence from the series.
 *
 * `uid` is the series' own event id, not iCalUID: an incremental sync sends a
 * cancelled instance as little more than its id, recurringEventId and
 * originalStartTime, with no iCalUID, and the instance has to group with its
 * series (recurrence.ts) all the same.
 */
export function fromGoogleEvent(e: GoogleEvent, calendarZone: string | null): RemoteEvent | null {
	const isInstance = Boolean(e.recurringEventId);
	if (e.status === 'cancelled' && !isInstance) return null;

	const allDay = Boolean(e.start?.date ?? e.originalStartTime?.date);
	// A series recurs in its own zone; a one-off with only an offset is an
	// instant, kept as UTC.
	const named = e.start?.timeZone ?? e.originalStartTime?.timeZone;
	const zone = allDay
		? null
		: named && isKnownZone(named)
			? named
			: e.recurrence || isInstance
				? isKnownZone(calendarZone)
					? calendarZone
					: 'UTC'
				: 'UTC';

	const recurrenceId = isInstance ? (timeOf(e.originalStartTime, zone) ?? '') : '';
	const start = timeOf(e.start, zone) ?? recurrenceId;
	const end = timeOf(e.end, zone) ?? start;
	const { rrule, exdates, rdates } = parseRecurrence(e.recurrence, zone);

	return {
		externalId: e.id,
		recurrenceId,
		uid: e.recurringEventId ?? e.id,
		etag: e.etag ?? null,
		status: e.status ?? 'confirmed',
		summary: e.summary ?? '',
		location: e.location ?? null,
		allDay,
		start,
		end: end < start ? start : end,
		timeZone: zone,
		rrule,
		exdates,
		rdates,
		lifeosKey: e.extendedProperties?.private?.lifeosKey ?? null,
		remoteUpdatedAt: e.updated ?? null
	};
}
