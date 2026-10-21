import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMember } from '$lib/server/auth/admin';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { externalDays } from '$lib/server/calendar-sync/days';
import { GoogleClient, type GoogleEvent } from '$lib/server/calendar-sync/google';
import { syncAll, type SyncDeps } from '$lib/server/calendar-sync/sync';
import {
	addCalendarSource,
	ensureGoogleConnection,
	listCalendarConnections,
	setPushTarget,
	updateCalendarSource
} from '$lib/server/repositories/calendar-sync';
import { one } from '$lib/server/db/scalar';
import { placeInZone } from '$lib/server/zone';

/**
 * Google sync end to end, against a fake Calendar API that checks what the
 * real one would: a correctly signed service-account JWT, sync tokens that
 * expire (410), deletions in an incremental sync, and 404 for an event
 * deleted by hand. No credentials needed; this is what lets the code be
 * trusted before the real ones exist.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
// the fake's bearer token, made up per run like every credential here
const ACCESS = randomBytes(12).toString('hex');

interface FakeEvent extends GoogleEvent {
	version: number;
}

/** One fake Calendar API: calendars by id, each a list of events with versions. */
class FakeGoogle {
	server: Server | null = null;
	base = '';
	calendars = new Map<
		string,
		{ summary: string; timeZone: string; events: Map<string, FakeEvent> }
	>();
	version = 0;
	writes: string[] = [];
	expired = new Set<string>();
	tokenRequests = 0;

	async start() {
		this.server = createServer(
			(req, res) =>
				void this.handle(req).then(([status, body]) => {
					res.writeHead(status, { 'content-type': 'application/json' });
					res.end(body === undefined ? '' : JSON.stringify(body));
				})
		);
		await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
		this.base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
	}

	stop = () => new Promise<void>((r) => this.server?.close(() => r()));

	calendar(id: string, summary = id, timeZone = 'America/Toronto') {
		this.calendars.set(id, { summary, timeZone, events: new Map() });
	}

	put(calendarId: string, e: GoogleEvent) {
		this.calendars.get(calendarId)!.events.set(e.id, { ...e, version: ++this.version });
	}

	private async body(req: IncomingMessage): Promise<string> {
		let data = '';
		for await (const chunk of req) data += chunk;
		return data;
	}

	private authorized(req: IncomingMessage) {
		return req.headers.authorization === `Bearer ${ACCESS}`;
	}

	private async handle(req: IncomingMessage): Promise<[number, unknown]> {
		const url = new URL(req.url!, this.base);
		if (url.pathname === '/token') {
			this.tokenRequests++;
			const form = new URLSearchParams(await this.body(req));
			const [h, c, s] = (form.get('assertion') ?? '').split('.');
			const ok = createVerify('RSA-SHA256')
				.update(`${h}.${c}`)
				.verify(publicKey, Buffer.from(s ?? '', 'base64url'));
			const claims = ok ? JSON.parse(Buffer.from(c!, 'base64url').toString()) : {};
			if (
				!ok ||
				form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' ||
				claims.aud !== `${this.base}/token`
			) {
				return [400, { error: 'invalid_grant', error_description: 'bad assertion' }];
			}
			return [200, { access_token: ACCESS, expires_in: 3600 }];
		}
		if (!this.authorized(req)) return [401, { error: { message: 'no token' } }];
		const m = /^\/calendar\/v3\/calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/.exec(url.pathname);
		const cal = m ? this.calendars.get(decodeURIComponent(m[1]!)) : undefined;
		if (!m || !cal) return [404, { error: { message: 'Not Found' } }];
		const calendarId = decodeURIComponent(m[1]!);
		const eventId = m[2] ? decodeURIComponent(m[2]) : null;
		const isEvents = url.pathname.includes('/events');

		if (!isEvents) return [200, { summary: cal.summary, timeZone: cal.timeZone }];

		if (req.method === 'GET') {
			const token = url.searchParams.get('syncToken');
			if (token && this.expired.has(token))
				return [410, { error: { message: 'Sync token is no longer valid' } }];
			const since = token ? Number(token.replace('v', '')) : 0;
			const all = [...cal.events.values()]
				.filter((e) => e.version > since && (since > 0 || e.status !== 'cancelled'))
				.sort((a, b) => a.version - b.version);
			// two to a page, so paging is exercised
			const start = Number(url.searchParams.get('pageToken') ?? 0);
			const page = all.slice(start, start + 2).map((e) => {
				const copy: Partial<FakeEvent> = { ...e };
				delete copy.version;
				return copy;
			});
			return start + 2 < all.length
				? [200, { items: page, nextPageToken: String(start + 2) }]
				: [200, { items: page, nextSyncToken: `v${this.version}` }];
		}
		if (req.method === 'POST') {
			const body = JSON.parse(await this.body(req)) as GoogleEvent;
			const id = `ev${randomBytes(4).toString('hex')}`;
			this.put(calendarId, { ...body, id, status: 'confirmed' });
			this.writes.push(`insert ${body.summary}`);
			return [200, { ...body, id }];
		}
		const existing = eventId ? cal.events.get(eventId) : undefined;
		if (!existing || existing.status === 'cancelled')
			return [404, { error: { message: 'Not Found' } }];
		if (req.method === 'PUT') {
			const body = JSON.parse(await this.body(req)) as GoogleEvent;
			this.put(calendarId, { ...body, id: eventId!, status: 'confirmed' });
			this.writes.push(`update ${body.summary}`);
			return [200, { ...body, id: eventId }];
		}
		if (req.method === 'DELETE') {
			// Deleted events stay as cancelled, as Google's do for incremental sync.
			this.put(calendarId, { id: eventId!, status: 'cancelled' });
			this.writes.push(`delete ${existing.summary}`);
			return [204, undefined];
		}
		return [405, { error: { message: 'method' } }];
	}
}

const google = new FakeGoogle();
let deps: SyncDeps;
let adminId: string;
let householdId: string;
let kaylaId: string;
const kayla = () => ({ userId: kaylaId, householdId, role: 'member' as const });
const admin = () => ({ userId: adminId, householdId, role: 'admin' as const });

async function reset() {
	await sql`truncate households, users restart identity cascade`;
}

beforeAll(async () => {
	await google.start();
	deps = {
		google: new GoogleClient({
			account: {
				clientEmail: 'lifeos@test.iam.gserviceaccount.com',
				privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
				tokenUri: `${google.base}/token`
			},
			apiBase: `${google.base}/calendar/v3`
		}),
		secretKey: randomBytes(32),
		zone: 'America/Toronto',
		origin: 'https://lifeos.test',
		currency: 'CAD'
	};
});

beforeEach(async () => {
	await reset();
	google.calendars.clear();
	google.writes = [];
	google.expired.clear();
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
	await google.stop();
	await reset();
	await sql.end({ timeout: 5 });
});

async function connect(
	calendarId: string,
	opts: { target?: boolean; visibility?: 'private' | 'household' } = {}
) {
	const connectionId = await ensureGoogleConnection(sql, kayla(), deps.google!.serviceAccountEmail);
	await addCalendarSource(sql, kayla(), connectionId, {
		externalId: calendarId,
		name: calendarId,
		timeZone: 'America/Toronto'
	});
	const [s] = await sql<
		{ id: string }[]
	>`select id from calendar_sources where external_id = ${calendarId}`;
	if (opts.target) await setPushTarget(sql, kayla(), s!.id);
	if (opts.visibility)
		await updateCalendarSource(sql, kayla(), s!.id, {
			visibility: opts.visibility,
			importEnabled: true
		});
	return s!.id;
}

const today = async () =>
	one(await sql<{ d: string }[]>`select (now() at time zone 'America/Toronto')::date::text as d`).d;

const inDays = async (n: number) =>
	one(
		await sql<
			{ d: string }[]
		>`select ((now() at time zone 'America/Toronto')::date + ${n}::int)::text as d`
	).d;

describe('reading Google calendars', () => {
	it('signs in with a valid assertion, pages through events, and shows them to their owner only', async () => {
		google.calendar('kayla@gmail.com');
		const day = await today();
		google.put('kayla@gmail.com', {
			id: 'a',
			summary: 'Dentist',
			start: { dateTime: `${day}T14:00:00-04:00` },
			end: { dateTime: `${day}T15:00:00-04:00` }
		});
		google.put('kayla@gmail.com', {
			id: 'b',
			summary: 'Park day',
			start: { date: day },
			end: { date: await inDays(1) }
		});
		google.put('kayla@gmail.com', {
			id: 'c',
			summary: 'Book club',
			start: { dateTime: `${day}T19:00:00-04:00`, timeZone: 'America/Toronto' },
			end: { dateTime: `${day}T20:00:00-04:00`, timeZone: 'America/Toronto' },
			recurrence: ['RRULE:FREQ=WEEKLY']
		});
		await connect('kayla@gmail.com');

		const report = await syncAll(sql, deps);
		expect(report).toMatchObject({ sources: 1, failures: 0 });
		expect(google.tokenRequests).toBeGreaterThan(0);

		const mine = await externalDays(sql, kayla(), day, day);
		expect(mine.map((e) => e.title).sort()).toEqual(['Book club', 'Dentist', 'Park day']);
		// private by default: the other member sees none of it
		expect(await externalDays(sql, admin(), day, day)).toEqual([]);
	});

	it('shows a household calendar to the whole household, and a hidden one to nobody', async () => {
		google.calendar('family@group.calendar.google.com');
		const day = await today();
		google.put('family@group.calendar.google.com', {
			id: 'f',
			summary: 'Recital',
			start: { date: day },
			end: { date: await inDays(1) }
		});
		const sourceId = await connect('family@group.calendar.google.com', { visibility: 'household' });
		await syncAll(sql, deps);
		expect((await externalDays(sql, admin(), day, day)).map((e) => e.title)).toEqual(['Recital']);

		await updateCalendarSource(sql, kayla(), sourceId, {
			importEnabled: false,
			visibility: 'household'
		});
		expect(await externalDays(sql, kayla(), day, day)).toEqual([]);
	});

	it('applies an incremental sync: a deleted event goes, an edited one changes', async () => {
		google.calendar('kayla@gmail.com');
		const day = await today();
		google.put('kayla@gmail.com', {
			id: 'a',
			summary: 'Dentist',
			start: { date: day },
			end: { date: await inDays(1) }
		});
		google.put('kayla@gmail.com', {
			id: 'b',
			summary: 'Gym',
			start: { date: day },
			end: { date: await inDays(1) }
		});
		await connect('kayla@gmail.com');
		await syncAll(sql, deps);

		google.put('kayla@gmail.com', { id: 'a', status: 'cancelled' });
		google.put('kayla@gmail.com', {
			id: 'b',
			summary: 'Gym (late)',
			start: { date: day },
			end: { date: await inDays(1) }
		});
		await syncAll(sql, deps);
		expect((await externalDays(sql, kayla(), day, day)).map((e) => e.title)).toEqual([
			'Gym (late)'
		]);
	});

	it('starts over when Google says the sync token has expired', async () => {
		google.calendar('kayla@gmail.com');
		const day = await today();
		google.put('kayla@gmail.com', {
			id: 'a',
			summary: 'Dentist',
			start: { date: day },
			end: { date: await inDays(1) }
		});
		const sourceId = await connect('kayla@gmail.com');
		await syncAll(sql, deps);
		const { sync_token } = one(
			await sql<
				{ sync_token: string }[]
			>`select sync_token from calendar_sources where id = ${sourceId}`
		);
		google.expired.add(sync_token);
		// a stale row the full sync must clear
		await sql`insert into calendar_events (source_id, external_id, uid, summary, all_day, start_local, end_local) values (${sourceId}, 'ghost', 'ghost', 'Ghost', true, ${day}, ${await inDays(1)})`;

		const report = await syncAll(sql, deps);
		expect(report.failures).toBe(0);
		expect((await externalDays(sql, kayla(), day, day)).map((e) => e.title)).toEqual(['Dentist']);
	});

	it('records a failure on the calendar and carries on with the rest', async () => {
		google.calendar('kayla@gmail.com');
		await connect('kayla@gmail.com');
		await connect('not-shared@gmail.com');
		const report = await syncAll(sql, deps);
		expect(report).toMatchObject({ sources: 2, failures: 1 });
		const [connection] = await listCalendarConnections(sql, kayla());
		const failed = connection!.sources.find((s) => s.externalId === 'not-shared@gmail.com');
		expect(failed?.lastError).toContain('Not Found');
		expect(
			connection!.sources.find((s) => s.externalId === 'kayla@gmail.com')?.lastError
		).toBeNull();
	});
});

describe('pushing LifeOS items', () => {
	async function seed() {
		const soon = await inDays(3);
		const [task] = await sql<{ id: string }[]>`
			insert into tasks (household_id, owner_user_id, visibility, title, do_on, deadline_on)
			values (${householdId}, ${kaylaId}, 'household', 'Renew passport', ${soon}::date, ${await inDays(10)}::date)
			returning id`;
		await sql`insert into tasks (household_id, owner_user_id, visibility, title, do_on)
		          values (${householdId}, ${adminId}, 'private', 'Admin secret task', ${soon}::date)`;
		await sql`insert into tasks (household_id, owner_user_id, visibility, title, do_on, status)
		          values (${householdId}, ${kaylaId}, 'household', 'Already done', ${soon}::date, 'done')`;
		await sql`insert into medical_visits (household_id, owner_user_id, visibility, reason, provider, visit_at)
		          values (${householdId}, ${kaylaId}, 'private', 'Checkup', 'Dr. Example', (${`${soon} 10:30`}::text::timestamp at time zone 'America/Toronto'))`;
		await sql`insert into bills (household_id, owner_user_id, visibility, name, amount, next_due_on)
		          values (${householdId}, ${kaylaId}, 'household', 'Hydro', 120.50, ${soon}::date)`;
		await sql`insert into important_dates (household_id, owner_user_id, visibility, title, on_date, recurrence)
		          values (${householdId}, ${kaylaId}, 'household', 'Anniversary', '2015-06-20', 'yearly')`;
		return task!.id;
	}

	it("writes the household's items and the owner's own, never another member's private ones", async () => {
		google.calendar('lifeos@group.calendar.google.com');
		await seed();
		await connect('lifeos@group.calendar.google.com', { target: true });
		const report = await syncAll(sql, deps);
		expect(report.failures).toBe(0);
		expect(google.writes.sort()).toEqual([
			'insert Anniversary',
			'insert Bill due: Hydro (120.50 CAD)',
			'insert Due: Renew passport',
			'insert Renew passport',
			'insert Visit: Checkup (Dr. Example)'
		]);
		const events = [...google.calendars.get('lifeos@group.calendar.google.com')!.events.values()];
		const visit = events.find((e) => e.summary?.startsWith('Visit'));
		const soon = await inDays(3);
		expect(visit?.start).toEqual({
			dateTime: placeInZone(`${soon}T10:30`, 'America/Toronto').toISOString(),
			timeZone: 'America/Toronto'
		});
		expect(events.find((e) => e.summary === 'Anniversary')?.recurrence).toEqual([
			'RRULE:FREQ=YEARLY'
		]);
		expect(visit?.extendedProperties?.private?.lifeosKey).toMatch(/^visit:/);
	});

	it('sends nothing the second time, then only what changed', async () => {
		google.calendar('lifeos@group.calendar.google.com');
		const taskId = await seed();
		await connect('lifeos@group.calendar.google.com', { target: true });
		await syncAll(sql, deps);
		google.writes = [];

		expect((await syncAll(sql, deps)).pushed).toEqual({ created: 0, updated: 0, deleted: 0 });
		expect(google.writes).toEqual([]);

		await sql`update tasks set title = 'Renew passports' where id = ${taskId}`;
		await sql`update bills set status = 'cancelled' where name = 'Hydro'`;
		await syncAll(sql, deps);
		expect(google.writes.sort()).toEqual([
			'delete Bill due: Hydro (120.50 CAD)',
			'update Due: Renew passports',
			'update Renew passports'
		]);
	});

	it('puts back an event deleted by hand in Google', async () => {
		google.calendar('lifeos@group.calendar.google.com');
		const taskId = await seed();
		await connect('lifeos@group.calendar.google.com', { target: true });
		await syncAll(sql, deps);
		const cal = google.calendars.get('lifeos@group.calendar.google.com')!;
		const due = [...cal.events.values()].find((e) => e.summary === 'Due: Renew passport')!;
		google.put('lifeos@group.calendar.google.com', { id: due.id, status: 'cancelled' });
		await sql`update tasks set deadline_on = deadline_on + 1 where id = ${taskId}`;
		google.writes = [];

		await syncAll(sql, deps);
		expect(google.writes).toEqual(['insert Due: Renew passport']);
	});

	it("doesn't show LifeOS's own pushed events back on its calendar", async () => {
		google.calendar('lifeos@group.calendar.google.com');
		await seed();
		await connect('lifeos@group.calendar.google.com', { target: true });
		await syncAll(sql, deps);
		await syncAll(sql, deps); // the second pass reads the pushed events back
		const { n } = one(
			await sql<
				{ n: number }[]
			>`select count(*)::int as n from calendar_events where lifeos_key is not null`
		);
		expect(n).toBeGreaterThan(0);
		expect(await externalDays(sql, kayla(), await today(), await inDays(30))).toEqual([]);
	});
});
