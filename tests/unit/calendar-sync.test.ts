import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseCalendarObject } from '$lib/server/calendar-sync/ics';
import {
	GoogleClient,
	SyncTokenExpired,
	fromGoogleEvent,
	serviceAccountAssertion,
	type GoogleEvent,
	type ServiceAccount
} from '$lib/server/calendar-sync/google';
import { expandOccurrences, type StoredEvent } from '$lib/server/calendar-sync/recurrence';
import { open, parseSecretKey, seal, SecretKeyMissing } from '$lib/server/calendar-sync/secret-box';
import { dayInZone, isKnownZone, placeInZone, wallClockInZone } from '$lib/server/zone';

const TORONTO = 'America/Toronto';

describe('zone', () => {
	it('places a wall clock on either side of a DST change', () => {
		expect(placeInZone('2026-07-01T09:00', TORONTO).toISOString()).toBe('2026-07-01T13:00:00.000Z');
		expect(placeInZone('2026-12-01T09:00:00', TORONTO).toISOString()).toBe(
			'2026-12-01T14:00:00.000Z'
		);
	});

	it('reads the repeated hour at the end of DST both ways', () => {
		expect(wallClockInZone(new Date('2026-11-01T05:30:00Z'), TORONTO)).toBe('2026-11-01T01:30:00');
		expect(wallClockInZone(new Date('2026-11-01T06:30:00Z'), TORONTO)).toBe('2026-11-01T01:30:00');
	});

	it("knows the household's evening is still yesterday in UTC terms", () => {
		expect(dayInZone(new Date('2026-10-21T03:00:00Z'), TORONTO)).toBe('2026-10-20');
	});

	it('tells IANA zones from names Intl does not know', () => {
		expect(isKnownZone(TORONTO)).toBe(true);
		expect(isKnownZone('Eastern Standard Time')).toBe(false);
		expect(isKnownZone(null)).toBe(false);
	});
});

describe('secret box', () => {
	const key = randomBytes(32);

	it('opens what it sealed, and seals the same text differently each time', () => {
		const a = seal('app-specific', key);
		expect(open(a, key)).toBe('app-specific');
		expect(seal('app-specific', key).equals(a)).toBe(false);
	});

	it('refuses the wrong key and any changed byte', () => {
		const box = seal('app-specific', key);
		expect(() => open(box, randomBytes(32))).toThrow();
		const tampered = Buffer.from(box);
		tampered[tampered.length - 1]! ^= 1;
		expect(() => open(tampered, key)).toThrow();
	});

	it('needs a key of exactly 32 bytes, and none is a clear error', () => {
		expect(parseSecretKey('')).toBeNull();
		expect(parseSecretKey(undefined)).toBeNull();
		expect(() => parseSecretKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
		expect(() => seal('x', null)).toThrow(SecretKeyMissing);
	});
});

const TORONTO_VTIMEZONE = `BEGIN:VTIMEZONE
TZID:America/Toronto
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

const ics = (body: string, extra = '') =>
	`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${extra}${body}\r\nEND:VCALENDAR\r\n`.replace(
		/\r?\n/g,
		'\r\n'
	);

const STANDUP = ics(
	`BEGIN:VEVENT
UID:standup@test
DTSTAMP:20261001T000000Z
DTSTART;TZID=America/Toronto:20261026T090000
DTEND;TZID=America/Toronto:20261026T093000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6
EXDATE;TZID=America/Toronto:20261028T090000
EXDATE:20261111T140000Z
SUMMARY:Stand-up
END:VEVENT
BEGIN:VEVENT
UID:standup@test
DTSTAMP:20261001T000000Z
RECURRENCE-ID;TZID=America/Toronto:20261102T090000
DTSTART;TZID=America/Toronto:20261102T110000
DTEND;TZID=America/Toronto:20261102T113000
SUMMARY:Stand-up (moved)
END:VEVENT`,
	TORONTO_VTIMEZONE + '\n'
);

describe('iCalendar objects', () => {
	it('reads a series, its EXDATEs in either form, and a moved instance, all in the series zone', () => {
		const [series, moved] = parseCalendarObject(STANDUP, 'https://dav/standup.ics', '"e1"');
		expect(series).toMatchObject({
			externalId: 'https://dav/standup.ics',
			recurrenceId: '',
			uid: 'standup@test',
			etag: '"e1"',
			allDay: false,
			start: '2026-10-26T09:00:00',
			end: '2026-10-26T09:30:00',
			timeZone: TORONTO,
			rrule: 'FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE',
			// the UTC one is 09:00 in Toronto once DST has ended
			exdates: ['2026-10-28T09:00:00', '2026-11-11T09:00:00']
		});
		expect(moved).toMatchObject({
			recurrenceId: '2026-11-02T09:00:00',
			start: '2026-11-02T11:00:00'
		});
	});

	it('keeps all-day events as days, the end exclusive', () => {
		const [e] = parseCalendarObject(
			ics(
				`BEGIN:VEVENT\nUID:x\nDTSTART;VALUE=DATE:20261225\nRRULE:FREQ=YEARLY\nSUMMARY:Christmas\nEND:VEVENT`
			),
			'u',
			null
		);
		expect(e).toMatchObject({
			allDay: true,
			start: '2026-12-25',
			end: '2026-12-26',
			timeZone: null
		});
	});

	it('keeps UTC times as UTC and floating times as floating', () => {
		const [utc] = parseCalendarObject(
			ics(
				`BEGIN:VEVENT\nUID:a\nDTSTART:20261020T130000Z\nDTEND:20261020T140000Z\nSUMMARY:x\nEND:VEVENT`
			),
			'u',
			null
		);
		const [floating] = parseCalendarObject(
			ics(`BEGIN:VEVENT\nUID:b\nDTSTART:20261020T090000\nSUMMARY:x\nEND:VEVENT`),
			'u',
			null
		);
		expect(utc).toMatchObject({
			timeZone: 'UTC',
			start: '2026-10-20T13:00:00',
			end: '2026-10-20T14:00:00'
		});
		expect(floating).toMatchObject({ timeZone: null, start: '2026-10-20T09:00:00' });
	});

	it('places a zone Intl does not know through the object’s own VTIMEZONE', () => {
		const [e] = parseCalendarObject(
			ics(
				`BEGIN:VEVENT\nUID:w\nDTSTART;TZID=Eastern Standard Time:20261026T090000\nSUMMARY:x\nEND:VEVENT`,
				TORONTO_VTIMEZONE.replace('TZID:America/Toronto', 'TZID:Eastern Standard Time') + '\n'
			),
			'u',
			null
		);
		expect(e).toMatchObject({ timeZone: 'UTC', start: '2026-10-26T13:00:00' });
	});

	it('reads cancellation, and skips what it cannot read without failing the rest', () => {
		const events = parseCalendarObject(
			ics(
				`BEGIN:VEVENT\nUID:c\nDTSTART:20261020T090000Z\nSTATUS:CANCELLED\nSUMMARY:x\nEND:VEVENT\nBEGIN:VEVENT\nUID:no-start\nSUMMARY:y\nEND:VEVENT`
			),
			'u',
			null
		);
		expect(events).toHaveLength(1);
		expect(events[0]!.status).toBe('cancelled');
		expect(parseCalendarObject('not a calendar', 'u', null)).toEqual([]);
	});
});

const meta = new Map([['src', { name: 'Kayla', color: '#336699' }]]);
const stored = (events: ReturnType<typeof parseCalendarObject>): StoredEvent[] =>
	events.map((e, i) => ({ ...e, id: `e${i}`, sourceId: 'src' }));
const window = (fromDay: string, toDay: string) => ({ fromDay, toDay, zone: TORONTO });

describe('expanding occurrences', () => {
	it('follows a weekly series across the DST change, minus EXDATEs, with the moved instance', () => {
		const out = expandOccurrences(
			stored(parseCalendarObject(STANDUP, 'u', null)),
			window('2026-10-25', '2026-11-30'),
			meta
		);
		expect(out.map((o) => o.start)).toEqual([
			'2026-10-26T13:00:00.000Z', // 09:00 EDT
			'2026-11-02T16:00:00.000Z', // moved to 11:00 EST
			'2026-11-04T14:00:00.000Z', // 09:00 EST: still 9 am after the change
			'2026-11-09T14:00:00.000Z'
			// 10-28 and 11-11 are excluded; COUNT=6 ends the series at 11-11
		]);
		expect(out[0]).toMatchObject({
			summary: 'Stand-up',
			sourceName: 'Kayla',
			color: '#336699',
			allDay: false
		});
		expect(out[0]!.end).toBe('2026-10-26T13:30:00.000Z');
	});

	it('drops an occurrence a cancelled instance replaces', () => {
		const events = parseCalendarObject(STANDUP, 'u', null);
		events[1]!.status = 'cancelled';
		const out = expandOccurrences(stored(events), window('2026-11-02', '2026-11-02'), meta);
		expect(out).toEqual([]);
	});

	it('repeats an all-day yearly event years on', () => {
		const events = parseCalendarObject(
			ics(
				`BEGIN:VEVENT\nUID:x\nDTSTART;VALUE=DATE:20261225\nRRULE:FREQ=YEARLY\nSUMMARY:Christmas\nEND:VEVENT`
			),
			'u',
			null
		);
		const out = expandOccurrences(stored(events), window('2030-12-01', '2030-12-31'), meta);
		expect(out).toMatchObject([{ allDay: true, start: '2030-12-25', end: '2030-12-26' }]);
	});

	it('reaches this month from a daily series begun in 2010', () => {
		const events = parseCalendarObject(
			ics(
				`BEGIN:VEVENT\nUID:d\nDTSTART;TZID=America/Toronto:20100104T070000\nRRULE:FREQ=DAILY\nSUMMARY:Pills\nEND:VEVENT`,
				TORONTO_VTIMEZONE + '\n'
			),
			'u',
			null
		);
		const out = expandOccurrences(stored(events), window('2026-10-20', '2026-10-22'), meta);
		expect(out.map((o) => o.start)).toEqual([
			'2026-10-20T11:00:00.000Z',
			'2026-10-21T11:00:00.000Z',
			'2026-10-22T11:00:00.000Z'
		]);
	});

	it('leaves out an event ending exactly as the window opens', () => {
		const events = parseCalendarObject(
			ics(
				`BEGIN:VEVENT\nUID:e\nDTSTART;TZID=America/Toronto:20261019T230000\nDTEND;TZID=America/Toronto:20261020T000000\nSUMMARY:x\nEND:VEVENT`,
				TORONTO_VTIMEZONE + '\n'
			),
			'u',
			null
		);
		expect(expandOccurrences(stored(events), window('2026-10-20', '2026-10-20'), meta)).toEqual([]);
	});

	it('reads a floating time in the household zone, and adds RDATEs', () => {
		const events = parseCalendarObject(
			ics(
				`BEGIN:VEVENT\nUID:f\nDTSTART:20261020T090000\nRRULE:FREQ=MONTHLY;COUNT=1\nRDATE:20261023T090000\nSUMMARY:x\nEND:VEVENT`
			),
			'u',
			null
		);
		const out = expandOccurrences(stored(events), window('2026-10-01', '2026-10-31'), meta);
		expect(out.map((o) => o.start)).toEqual([
			'2026-10-20T13:00:00.000Z',
			'2026-10-23T13:00:00.000Z'
		]);
	});
});

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account: ServiceAccount = {
	clientEmail: 'lifeos@project.iam.gserviceaccount.com',
	privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
	tokenUri: 'https://token.test/token'
};

describe('Google', () => {
	it("signs the service account's assertion with RS256, valid for an hour", () => {
		const jwt = serviceAccountAssertion(account, Date.UTC(2026, 9, 20));
		const [header, claims, signature] = jwt.split('.');
		const verified = createVerify('RSA-SHA256')
			.update(`${header}.${claims}`)
			.verify(publicKey, Buffer.from(signature!, 'base64url'));
		expect(verified).toBe(true);
		expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
			alg: 'RS256',
			typ: 'JWT'
		});
		const c = JSON.parse(Buffer.from(claims!, 'base64url').toString());
		expect(c).toMatchObject({
			iss: account.clientEmail,
			scope: 'https://www.googleapis.com/auth/calendar',
			aud: account.tokenUri
		});
		expect(c.exp - c.iat).toBe(3600);
	});

	it('maps a one-off with only an offset to UTC, and a series to its own zone', () => {
		expect(
			fromGoogleEvent(
				{
					id: 'a',
					start: { dateTime: '2026-10-20T09:00:00-04:00' },
					end: { dateTime: '2026-10-20T10:00:00-04:00' }
				},
				TORONTO
			)
		).toMatchObject({
			timeZone: 'UTC',
			start: '2026-10-20T13:00:00',
			end: '2026-10-20T14:00:00',
			uid: 'a'
		});

		const series = fromGoogleEvent(
			{
				id: 's',
				iCalUID: 's@google.com',
				start: { dateTime: '2026-10-26T09:00:00-04:00', timeZone: TORONTO },
				end: { dateTime: '2026-10-26T09:30:00-04:00', timeZone: TORONTO },
				recurrence: [
					'RRULE:FREQ=WEEKLY;BYDAY=MO',
					'EXDATE;TZID=America/Toronto:20261102T090000',
					'EXDATE:20261109T140000Z'
				]
			},
			null
		);
		expect(series).toMatchObject({
			uid: 's',
			timeZone: TORONTO,
			start: '2026-10-26T09:00:00',
			rrule: 'FREQ=WEEKLY;BYDAY=MO',
			exdates: ['2026-11-02T09:00:00', '2026-11-09T09:00:00']
		});
	});

	it('keeps a cancelled instance (even the bare one an incremental sync sends), and deletes a cancelled series', () => {
		const bare: GoogleEvent = {
			id: 's_20261102T140000Z',
			status: 'cancelled',
			recurringEventId: 's',
			originalStartTime: { dateTime: '2026-11-02T09:00:00-05:00', timeZone: TORONTO }
		};
		expect(fromGoogleEvent(bare, TORONTO)).toMatchObject({
			uid: 's',
			status: 'cancelled',
			recurrenceId: '2026-11-02T09:00:00'
		});
		expect(fromGoogleEvent({ id: 's', status: 'cancelled' }, TORONTO)).toBeNull();
	});

	it("reads LifeOS's own key back from a pushed event", () => {
		expect(
			fromGoogleEvent(
				{
					id: 'p',
					start: { date: '2026-10-20' },
					end: { date: '2026-10-21' },
					extendedProperties: { private: { lifeosKey: 'task:1:do' } }
				},
				null
			)
		).toMatchObject({ allDay: true, lifeosKey: 'task:1:do' });
	});

	it('signs in once, pages through events, and turns 410 into SyncTokenExpired', async () => {
		const calls: string[] = [];
		const fake: typeof fetch = async (input) => {
			const url = String(input);
			calls.push(url);
			const json = (status: number, body: unknown) =>
				new Response(JSON.stringify(body), {
					status,
					headers: { 'content-type': 'application/json' }
				});
			if (url === account.tokenUri)
				return json(200, { access_token: randomBytes(8).toString('hex'), expires_in: 3600 });
			if (url.includes('syncToken=old'))
				return json(410, { error: { message: 'Sync token is no longer valid' } });
			if (url.includes('pageToken=2'))
				return json(200, { items: [{ id: 'b' }], nextSyncToken: 'next' });
			return json(200, { items: [{ id: 'a' }], nextPageToken: '2' });
		};
		const client = new GoogleClient({
			account,
			apiBase: 'https://api.test/calendar/v3',
			fetch: fake
		});
		const result = await client.listEvents('kayla@example.com', null);
		expect(result.events.map((e) => e.id)).toEqual(['a', 'b']);
		expect(result.nextSyncToken).toBe('next');
		await expect(client.listEvents('kayla@example.com', 'old')).rejects.toBeInstanceOf(
			SyncTokenExpired
		);
		expect(calls.filter((c) => c === account.tokenUri)).toHaveLength(1);
		expect(calls[1]).toContain('/calendars/kayla%40example.com/events?');
		expect(calls[1]).toContain('showDeleted=true');
	});
});
