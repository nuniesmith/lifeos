import { calendarMultiGet, createAccount, fetchCalendars, syncCollection } from 'tsdav';
import type { DAVAccount, DAVResponse } from 'tsdav';
import { parseCalendarObject } from './ics';
import type { RemoteEvent } from './model';

/**
 * CalDAV: iCloud, or any CalDAV server (Nextcloud, Fastmail, Radicale).
 *
 * iCloud speaks CalDAV only with an app-specific password (2FA accounts,
 * which every Apple ID now is), at https://caldav.icloud.com, and offers no
 * push, so LifeOS polls. Each poll is an RFC 6578 sync-collection REPORT with
 * the last sync token, which answers with only what changed: changed objects
 * by URL and etag, deleted ones by URL. Changed objects are then fetched with
 * calendar-multiget.
 *
 * The new token is read from the REPORT's own answer, never re-read from the
 * collection afterwards: a change landing between the two would be inside
 * the re-read token and so never fetched.
 */

export const ICLOUD_URL = 'https://caldav.icloud.com';

export interface CaldavCredentials {
	serverUrl: string;
	username: string;
	password: string;
}

export interface CaldavCalendar {
	url: string;
	name: string;
	color: string | null;
	timeZone: string | null;
}

export class CaldavError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

function authHeaders(c: CaldavCredentials): Record<string, string> {
	return {
		authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`
	};
}

/** The text of an xml-js compact node, or of a plain string. */
function textOf(node: unknown): string | null {
	if (typeof node === 'string') return node;
	if (node && typeof node === 'object' && '_text' in node)
		return String((node as { _text: unknown })._text);
	return null;
}

function hexColor(value: unknown): string | null {
	const text = textOf(value);
	// Apple writes #RRGGBBAA; LifeOS keeps #RRGGBB.
	const m = /^#([0-9a-fA-F]{6})/.exec(text ?? '');
	return m ? `#${m[1]}` : null;
}

function zoneFromVtimezone(value: unknown): string | null {
	const m = /TZID:([^\r\n]+)/.exec(textOf(value) ?? '');
	return m ? m[1]!.trim() : null;
}

async function account(c: CaldavCredentials): Promise<DAVAccount> {
	try {
		return await createAccount({
			account: { serverUrl: c.serverUrl, accountType: 'caldav', credentials: c },
			headers: authHeaders(c)
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// tsdav reports a refused sign-in as a failed discovery
		throw new CaldavError(401, `could not sign in to ${c.serverUrl}: ${message}`);
	}
}

/** Signs in and lists the calendars that hold events (not reminders). */
export async function discoverCalendars(c: CaldavCredentials): Promise<CaldavCalendar[]> {
	const acct = await account(c);
	const calendars = await fetchCalendars({ account: acct, headers: authHeaders(c) });
	return calendars
		.filter((cal) => !cal.components || cal.components.includes('VEVENT'))
		.map((cal) => ({
			url: cal.url,
			name: (typeof cal.displayName === 'string' && cal.displayName.trim()) || 'Calendar',
			color: hexColor(cal.calendarColor),
			timeZone: zoneFromVtimezone(cal.timezone)
		}));
}

export interface CaldavChanges {
	/** Objects to store, each replacing whatever was stored under its URL. */
	changed: { url: string; events: RemoteEvent[] }[];
	deleted: string[];
	syncToken: string;
	/** True when the token was refused and this is every object again. */
	full: boolean;
}

function syncTokenOf(responses: DAVResponse[]): string | null {
	for (const r of responses) {
		const raw = r.raw as
			{ multistatus?: { syncToken?: unknown; 'sync-token'?: unknown } } | undefined;
		const token = textOf(raw?.multistatus?.syncToken ?? raw?.multistatus?.['sync-token']);
		if (token) return token;
	}
	return null;
}

const refusedToken = (responses: DAVResponse[]) =>
	responses.length === 1 &&
	(responses[0]!.status ?? 0) >= 400 &&
	(responses[0]!.status ?? 0) < 500 &&
	JSON.stringify(responses[0]!.raw ?? '').includes('valid-sync-token');

/** What changed in a calendar since `syncToken`; everything, without one. */
export async function syncCalendar(
	c: CaldavCredentials,
	calendarUrl: string,
	syncToken: string | null
): Promise<CaldavChanges> {
	const headers = authHeaders(c);
	const report = (token: string | null) =>
		syncCollection({
			url: calendarUrl,
			props: { 'd:getetag': {} },
			syncLevel: 1,
			syncToken: token ?? undefined,
			headers
		});

	let full = !syncToken;
	let responses = await report(syncToken);
	if (syncToken && refusedToken(responses)) {
		full = true;
		responses = await report(null);
	}
	const failure = responses.find((r) => !r.href && (r.status ?? 0) >= 400);
	if (failure)
		throw new CaldavError(
			failure.status ?? 0,
			`sync of ${calendarUrl} failed: ${failure.statusText}`
		);

	const token = syncTokenOf(responses);
	if (!token) throw new CaldavError(0, `${calendarUrl} returned no sync token`);

	const base = new URL(calendarUrl);
	const absolute = (href: string) => new URL(href, base).toString();
	const deleted: string[] = [];
	const changedUrls: string[] = [];
	for (const r of responses) {
		if (!r.href) continue;
		const url = absolute(r.href);
		if (url.replace(/\/$/, '') === calendarUrl.replace(/\/$/, '')) continue;
		if (r.status === 404) deleted.push(url);
		else if (url.endsWith('.ics')) changedUrls.push(url);
	}

	const changed: CaldavChanges['changed'] = [];
	// Fetched in batches: a first sync of a big calendar is thousands of objects.
	for (let i = 0; i < changedUrls.length; i += 100) {
		const batch = changedUrls.slice(i, i + 100);
		const objects = await calendarMultiGet({
			url: calendarUrl,
			props: { 'd:getetag': {}, 'c:calendar-data': {} },
			objectUrls: batch.map((u) => new URL(u).pathname),
			depth: '1',
			headers
		});
		for (const o of objects) {
			if (!o.href || !o.ok) continue;
			const url = absolute(o.href);
			const props = o.props as { calendarData?: unknown; getetag?: unknown } | undefined;
			const ics = textOf(props?.calendarData);
			if (!ics) continue;
			changed.push({ url, events: parseCalendarObject(ics, url, textOf(props?.getetag)) });
		}
	}
	return { changed, deleted, syncToken: token, full };
}
