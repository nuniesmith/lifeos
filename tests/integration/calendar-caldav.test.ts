import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMember } from '$lib/server/auth/admin';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { discoverCalendars, syncCalendar } from '$lib/server/calendar-sync/caldav';
import { externalDays } from '$lib/server/calendar-sync/days';
import { seal } from '$lib/server/calendar-sync/secret-box';
import { syncAll } from '$lib/server/calendar-sync/sync';
import {
	addCalendarSource,
	createCaldavConnection,
	listCalendarConnections
} from '$lib/server/repositories/calendar-sync';
import { one } from '$lib/server/db/scalar';

/**
 * CalDAV against a real CalDAV server: the same protocol as iCloud, so the
 * discovery, sync-collection and multiget code runs as it will against
 * Apple's. Needs CALDAV_TEST_URL, a server that accepts any login (here,
 * Radicale with auth none):
 *
 *   docker run -d -p 127.0.0.1:5232:5232 python:3.12-slim sh -c \
 *     "pip install radicale && python -m radicale --server-hosts 0.0.0.0:5232 \
 *      --auth-type none --rights-type owner_only --storage-filesystem-folder /tmp/r"
 *   CALDAV_TEST_URL=http://127.0.0.1:5232 npm run test:integration
 */

const base = process.env.CALDAV_TEST_URL;
const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });
const login = { username: 'kayla', password: randomBytes(8).toString('hex') };
const auth = {
	authorization: `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`
};

const event = (uid: string, summary: string, day: string, extra = '') =>
	[
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//lifeos test//EN',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20261001T000000Z',
		`DTSTART;VALUE=DATE:${day.replaceAll('-', '')}`,
		`SUMMARY:${summary}`,
		...(extra ? [extra] : []),
		'END:VEVENT',
		'END:VCALENDAR',
		''
	].join('\r\n');

async function dav(
	method: string,
	url: string,
	body?: string,
	headers: Record<string, string> = {}
) {
	const res = await fetch(url, { method, headers: { ...auth, ...headers }, body });
	if (res.status >= 400) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
	return res;
}

async function newCalendar(name: string): Promise<string> {
	const url = `${base}/${login.username}/${name}-${randomBytes(4).toString('hex')}/`;
	await dav(
		'MKCALENDAR',
		url,
		`<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>` +
			`<D:displayname>${name}</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>` +
			`</D:prop></D:set></C:mkcalendar>`,
		{ 'content-type': 'application/xml' }
	);
	return url;
}

const put = (url: string, ics: string) =>
	dav('PUT', url, ics, { 'content-type': 'text/calendar; charset=utf-8' });

describe.skipIf(!base)('CalDAV (against CALDAV_TEST_URL)', () => {
	let adminId: string;
	let householdId: string;
	let kaylaId: string;
	const kayla = () => ({ userId: kaylaId, householdId, role: 'member' as const });
	const today = async () =>
		one(await sql<{ d: string }[]>`select (now() at time zone 'America/Toronto')::date::text as d`)
			.d;

	beforeAll(async () => {
		// the principal exists once something has been created under it
		await newCalendar('warmup');
	});

	beforeEach(async () => {
		await sql`truncate households, users restart identity cascade`;
		await bootstrapIfEmpty(sql);
		adminId = one(await sql<{ id: string }[]>`select id from users limit 1`).id;
		householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
		const created = await createMember(sql, adminId, householdId, {
			username: 'kayla',
			displayName: 'Kayla',
			role: 'member'
		});
		if (!created.ok) throw new Error('member');
		kaylaId = one(await sql<{ id: string }[]>`select id from users where username = 'kayla'`).id;
	});

	afterAll(async () => {
		await sql`truncate households, users restart identity cascade`;
		await sql.end({ timeout: 5 });
	});

	it('discovers the account’s event calendars by name', async () => {
		const url = await newCalendar('Family');
		const calendars = await discoverCalendars({ serverUrl: base!, ...login });
		expect(calendars.find((c) => c.url === url)).toMatchObject({ name: 'Family' });
	});

	it('syncs everything first, then only what changed, deletions included', async () => {
		const cal = await newCalendar('Kayla');
		const day = await today();
		await put(`${cal}a.ics`, event('a@test', 'Dentist', day));
		await put(`${cal}b.ics`, event('b@test', 'Gym', day));
		await put(`${cal}c.ics`, event('c@test', 'Park', day));

		const first = await syncCalendar({ serverUrl: base!, ...login }, cal, null);
		expect(first.full).toBe(true);
		expect(first.changed.map((o) => o.events[0]!.summary).sort()).toEqual([
			'Dentist',
			'Gym',
			'Park'
		]);
		expect(first.syncToken).toBeTruthy();

		await put(`${cal}b.ics`, event('b@test', 'Gym (late)', day));
		await put(`${cal}d.ics`, event('d@test', 'Book club', day));
		await dav('DELETE', `${cal}c.ics`);

		const next = await syncCalendar({ serverUrl: base!, ...login }, cal, first.syncToken);
		expect(next.full).toBe(false);
		expect(next.changed.map((o) => o.events[0]!.summary).sort()).toEqual([
			'Book club',
			'Gym (late)'
		]);
		expect(next.deleted).toEqual([`${cal}c.ics`]);
		expect(next.syncToken).not.toBe(first.syncToken);
	});

	it('starts over when the server refuses the sync token', async () => {
		const cal = await newCalendar('Kayla');
		await put(`${cal}a.ics`, event('a@test', 'Dentist', await today()));
		const result = await syncCalendar({ serverUrl: base!, ...login }, cal, `${base}/no-such-token`);
		expect(result.full).toBe(true);
		expect(result.changed).toHaveLength(1);
	});

	it('runs through the whole job: a sealed password, stored events, the calendar page', async () => {
		const cal = await newCalendar('Kayla');
		const day = await today();
		await put(`${cal}a.ics`, event('a@test', 'Dentist', day));
		const key = randomBytes(32);
		const connectionId = await createCaldavConnection(sql, kayla(), {
			account: login.username,
			serverUrl: base!,
			secret: seal(login.password, key)
		});
		await addCalendarSource(sql, kayla(), connectionId, { externalId: cal, name: 'Kayla' });

		const deps = {
			google: null,
			secretKey: key,
			zone: 'America/Toronto',
			origin: null,
			currency: 'CAD'
		};
		expect(await syncAll(sql, deps)).toMatchObject({ sources: 1, failures: 0 });
		expect((await externalDays(sql, kayla(), day, day)).map((e) => e.title)).toEqual(['Dentist']);

		// with the wrong server key the password can't be opened: one clear error, no crash
		const wrong = { ...deps, secretKey: randomBytes(32) };
		expect((await syncAll(sql, wrong)).failures).toBe(1);
		const [connection] = await listCalendarConnections(sql, kayla());
		expect(connection!.lastError).toContain("can't read the stored password");
	});
});
