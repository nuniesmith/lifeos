import type { Viewer } from '../auth/authz';
import { toDateOrNull } from '../db/coerce';
import type { RemoteEvent } from '../calendar-sync/model';
import type { StoredEvent } from '../calendar-sync/recurrence';
import { atomically, type Queryable } from './base';

/**
 * Calendar connections, their calendars, the events read from them, and what
 * LifeOS pushed (migration 0041).
 *
 * Two kinds of caller. A person, through the settings page, sees and changes
 * only their own connections: every query carries `owner_user_id = viewer`.
 * The sync job acts for everyone, so it takes ids, not a viewer; it never
 * runs in a request. Events reach a page only through `visibleEvents`, which
 * applies the household/private rule in SQL: a calendar's events show to its
 * owner, and to the rest of the household when the calendar is shared.
 */

export type Provider = 'google' | 'caldav';

export interface CalendarSource {
	id: string;
	connectionId: string;
	externalId: string;
	name: string;
	color: string | null;
	timeZone: string | null;
	visibility: 'private' | 'household';
	importEnabled: boolean;
	isPushTarget: boolean;
	syncToken: string | null;
	lastSyncedAt: Date | null;
	lastError: string | null;
}

export interface CalendarConnection {
	id: string;
	householdId: string;
	ownerUserId: string;
	provider: Provider;
	account: string;
	serverUrl: string | null;
	lastSyncedAt: Date | null;
	lastError: string | null;
	sources: CalendarSource[];
}

interface SourceRow {
	id: string;
	connection_id: string;
	external_id: string;
	name: string;
	color: string | null;
	time_zone: string | null;
	visibility: 'private' | 'household';
	import_enabled: boolean;
	is_push_target: boolean;
	sync_token: string | null;
	last_synced_at: unknown;
	last_error: string | null;
}

const mapSource = (r: SourceRow): CalendarSource => ({
	id: r.id,
	connectionId: r.connection_id,
	externalId: r.external_id,
	name: r.name,
	color: r.color,
	timeZone: r.time_zone,
	visibility: r.visibility,
	importEnabled: r.import_enabled,
	isPushTarget: r.is_push_target,
	syncToken: r.sync_token,
	lastSyncedAt: toDateOrNull(r.last_synced_at),
	lastError: r.last_error
});

const sourceColumns = (sql: Queryable) => sql`
	s.id, s.connection_id, s.external_id, s.name, s.color, s.time_zone, s.visibility::text as visibility,
	s.import_enabled, s.is_push_target, s.sync_token, s.last_synced_at, s.last_error`;

interface ConnectionRow {
	id: string;
	household_id: string;
	owner_user_id: string;
	provider: Provider;
	account: string;
	server_url: string | null;
	last_synced_at: unknown;
	last_error: string | null;
}

async function withSources(sql: Queryable, rows: ConnectionRow[]): Promise<CalendarConnection[]> {
	if (rows.length === 0) return [];
	const sources = await sql<SourceRow[]>`
		select ${sourceColumns(sql)} from calendar_sources s
		where s.connection_id in ${sql(rows.map((r) => r.id))}
		order by s.name
	`;
	return rows.map((r) => ({
		id: r.id,
		householdId: r.household_id,
		ownerUserId: r.owner_user_id,
		provider: r.provider,
		account: r.account,
		serverUrl: r.server_url,
		lastSyncedAt: toDateOrNull(r.last_synced_at),
		lastError: r.last_error,
		sources: sources.filter((s) => s.connection_id === r.id).map(mapSource)
	}));
}

const connectionColumns = (sql: Queryable) => sql`
	c.id, c.household_id, c.owner_user_id, c.provider, c.account, c.server_url, c.last_synced_at, c.last_error`;

/** The viewer's own connections, each with its calendars. */
export async function listCalendarConnections(
	sql: Queryable,
	viewer: Viewer
): Promise<CalendarConnection[]> {
	const rows = await sql<ConnectionRow[]>`
		select ${connectionColumns(sql)} from calendar_connections c
		where c.owner_user_id = ${viewer.userId} and c.household_id = ${viewer.householdId}
		order by c.provider, c.account
	`;
	return withSources(sql, rows);
}

/** The viewer's Google connection (one per person: the server's service account), made if missing. */
export async function ensureGoogleConnection(
	sql: Queryable,
	viewer: Viewer,
	serviceAccountEmail: string
): Promise<string> {
	const [row] = await sql<{ id: string }[]>`
		insert into calendar_connections (household_id, owner_user_id, provider, account)
		values (${viewer.householdId}, ${viewer.userId}, 'google', ${serviceAccountEmail})
		on conflict (owner_user_id, provider, account) do update set updated_at = now()
		returning id
	`;
	return row!.id;
}

export async function createCaldavConnection(
	sql: Queryable,
	viewer: Viewer,
	input: { account: string; serverUrl: string; secret: Buffer }
): Promise<string> {
	const [row] = await sql<{ id: string }[]>`
		insert into calendar_connections (household_id, owner_user_id, provider, account, server_url, secret)
		values (${viewer.householdId}, ${viewer.userId}, 'caldav', ${input.account}, ${input.serverUrl}, ${input.secret})
		on conflict (owner_user_id, provider, account) do update
			set server_url = excluded.server_url, secret = excluded.secret, last_error = null, updated_at = now()
		returning id
	`;
	return row!.id;
}

/** Adds a calendar to one of the viewer's connections; false if the connection isn't theirs. */
export async function addCalendarSource(
	sql: Queryable,
	viewer: Viewer,
	connectionId: string,
	input: { externalId: string; name: string; color?: string | null; timeZone?: string | null }
): Promise<boolean> {
	const rows = await sql`
		insert into calendar_sources (connection_id, external_id, name, color, time_zone)
		select c.id, ${input.externalId}, ${input.name.trim().slice(0, 300) || 'Calendar'},
		       ${input.color ?? null}, ${input.timeZone ?? null}
		from calendar_connections c
		where c.id = ${connectionId} and c.owner_user_id = ${viewer.userId}
		on conflict (connection_id, external_id) do update
			set name = excluded.name, color = excluded.color, time_zone = excluded.time_zone
		returning 1
	`;
	return rows.length > 0;
}

export async function updateCalendarSource(
	sql: Queryable,
	viewer: Viewer,
	sourceId: string,
	input: { importEnabled?: boolean; visibility?: 'private' | 'household' }
): Promise<boolean> {
	const rows = await sql`
		update calendar_sources s set
			import_enabled = coalesce(${input.importEnabled ?? null}::boolean, s.import_enabled),
			visibility = coalesce(${input.visibility ?? null}::visibility_kind, s.visibility)
		from calendar_connections c
		where s.id = ${sourceId} and c.id = s.connection_id and c.owner_user_id = ${viewer.userId}
		returning 1
	`;
	return rows.length > 0;
}

/**
 * Makes one of the viewer's Google calendars the household's push target,
 * or clears it (sourceId null). One per household, so setting it clears any
 * other; the pushes recorded for the old target go with the flag, since its
 * events now belong to a calendar LifeOS no longer writes.
 */
export async function setPushTarget(
	sql: Queryable,
	viewer: Viewer,
	sourceId: string | null
): Promise<boolean> {
	return atomically(sql, async (tx) => {
		if (sourceId) {
			const [ok] = await tx<{ id: string }[]>`
				select s.id from calendar_sources s join calendar_connections c on c.id = s.connection_id
				where s.id = ${sourceId} and c.owner_user_id = ${viewer.userId} and c.provider = 'google'
			`;
			if (!ok) return false;
		}
		await tx`
			update calendar_sources s set is_push_target = false
			from calendar_connections c
			where c.id = s.connection_id and c.household_id = ${viewer.householdId}
			  and s.is_push_target and s.id is distinct from ${sourceId}
		`;
		if (sourceId)
			await tx`update calendar_sources set is_push_target = true where id = ${sourceId}`;
		return true;
	});
}

export async function deleteCalendarConnection(
	sql: Queryable,
	viewer: Viewer,
	connectionId: string
): Promise<boolean> {
	const rows = await sql`
		delete from calendar_connections where id = ${connectionId} and owner_user_id = ${viewer.userId}
		returning 1
	`;
	return rows.length > 0;
}

// ─── for the sync job ────────────────────────────────────────────────────────

export interface ConnectionForSync extends CalendarConnection {
	secret: Buffer | null;
}

export async function connectionsForSync(sql: Queryable): Promise<ConnectionForSync[]> {
	const rows = await sql<(ConnectionRow & { secret: Buffer | null })[]>`
		select ${connectionColumns(sql)}, c.secret from calendar_connections c order by c.created_at
	`;
	const withSrc = await withSources(sql, rows);
	return withSrc.map((c, i) => ({ ...c, secret: rows[i]!.secret }));
}

export async function recordConnectionResult(
	sql: Queryable,
	connectionId: string,
	error: string | null
): Promise<void> {
	await sql`
		update calendar_connections
		set last_error = ${error}, last_synced_at = case when ${error}::text is null then now() else last_synced_at end
		where id = ${connectionId}
	`;
}

export async function recordSourceResult(
	sql: Queryable,
	sourceId: string,
	result: { syncToken?: string | null; error: string | null }
): Promise<void> {
	await sql`
		update calendar_sources set
			sync_token = case when ${result.syncToken === undefined} then sync_token else ${result.syncToken ?? null} end,
			last_error = ${result.error},
			last_synced_at = case when ${result.error}::text is null then now() else last_synced_at end
		where id = ${sourceId}
	`;
}

const eventValues = (sourceId: string, e: RemoteEvent) => ({
	source_id: sourceId,
	external_id: e.externalId,
	recurrence_id: e.recurrenceId,
	uid: e.uid,
	etag: e.etag,
	status: e.status,
	summary: e.summary.slice(0, 2000),
	location: e.location?.slice(0, 2000) ?? null,
	all_day: e.allDay,
	start_local: e.start,
	end_local: e.end,
	time_zone: e.timeZone,
	rrule: e.rrule,
	exdates: e.exdates,
	rdates: e.rdates,
	lifeos_key: e.lifeosKey,
	remote_updated_at: e.remoteUpdatedAt
});

export async function upsertEvents(
	sql: Queryable,
	sourceId: string,
	events: RemoteEvent[]
): Promise<void> {
	for (const e of events) {
		const v = eventValues(sourceId, e);
		await sql`
			insert into calendar_events ${sql(v)}
			on conflict (source_id, external_id, recurrence_id) do update set
				uid = excluded.uid, etag = excluded.etag, status = excluded.status, summary = excluded.summary,
				location = excluded.location, all_day = excluded.all_day, start_local = excluded.start_local,
				end_local = excluded.end_local, time_zone = excluded.time_zone, rrule = excluded.rrule,
				exdates = excluded.exdates, rdates = excluded.rdates, lifeos_key = excluded.lifeos_key,
				remote_updated_at = excluded.remote_updated_at, synced_at = now()
		`;
	}
}

/** Replaces everything stored under one object URL (a CalDAV series and its instances). */
export async function replaceObject(
	sql: Queryable,
	sourceId: string,
	url: string,
	events: RemoteEvent[]
): Promise<void> {
	await atomically(sql, async (tx) => {
		await tx`delete from calendar_events where source_id = ${sourceId} and external_id = ${url}`;
		await upsertEvents(tx, sourceId, events);
	});
}

/** Deletes events by id, and for Google a series' instances with it (their ids are "<series>_<time>"). */
export async function deleteEvents(
	sql: Queryable,
	sourceId: string,
	externalIds: string[]
): Promise<void> {
	for (const id of externalIds) {
		await sql`
			delete from calendar_events
			where source_id = ${sourceId}
			  and (external_id = ${id} or starts_with(external_id, ${`${id}_`}))
		`;
	}
}

export async function wipeSource(sql: Queryable, sourceId: string): Promise<void> {
	await sql`delete from calendar_events where source_id = ${sourceId}`;
}

export interface PushRecord {
	lifeosKey: string;
	externalId: string;
	contentHash: string;
}

export async function pushesOf(sql: Queryable, sourceId: string): Promise<Map<string, PushRecord>> {
	const rows = await sql<{ lifeos_key: string; external_id: string; content_hash: string }[]>`
		select lifeos_key, external_id, content_hash from calendar_pushes where source_id = ${sourceId}
	`;
	return new Map(
		rows.map((r) => [
			r.lifeos_key,
			{ lifeosKey: r.lifeos_key, externalId: r.external_id, contentHash: r.content_hash }
		])
	);
}

export async function recordPush(
	sql: Queryable,
	sourceId: string,
	push: PushRecord
): Promise<void> {
	await sql`
		insert into calendar_pushes (source_id, lifeos_key, external_id, content_hash)
		values (${sourceId}, ${push.lifeosKey}, ${push.externalId}, ${push.contentHash})
		on conflict (source_id, lifeos_key) do update
			set external_id = excluded.external_id, content_hash = excluded.content_hash, pushed_at = now()
	`;
}

export async function forgetPush(
	sql: Queryable,
	sourceId: string,
	lifeosKey: string
): Promise<void> {
	await sql`delete from calendar_pushes where source_id = ${sourceId} and lifeos_key = ${lifeosKey}`;
}

// ─── for pages ──────────────────────────────────────────────────────────────

interface EventRow {
	id: string;
	source_id: string;
	external_id: string;
	recurrence_id: string;
	uid: string;
	etag: string | null;
	status: RemoteEvent['status'];
	summary: string;
	location: string | null;
	all_day: boolean;
	start_local: string;
	end_local: string;
	time_zone: string | null;
	rrule: string | null;
	exdates: string[];
	rdates: string[];
	lifeos_key: string | null;
	remote_updated_at: unknown;
	source_name: string;
	color: string | null;
}

/**
 * The events a viewer may see that can fall in [fromDay, toDay]: every
 * series (any can recur into the window) and the one-offs and instances
 * near it. Stored times are wall clocks in zones up to 14 hours from the
 * household's, so the date filter leaves a day's margin each side and
 * recurrence.ts decides exactly. LifeOS's own pushed events are left out:
 * the calendar page shows those items itself.
 */
export async function visibleEvents(
	sql: Queryable,
	viewer: Viewer,
	fromDay: string,
	toDay: string
): Promise<{
	events: StoredEvent[];
	sources: Map<string, { name: string; color: string | null }>;
}> {
	const rows = await sql<EventRow[]>`
		select e.id, e.source_id, e.external_id, e.recurrence_id, e.uid, e.etag, e.status, e.summary,
		       e.location, e.all_day, e.start_local, e.end_local, e.time_zone, e.rrule, e.exdates, e.rdates,
		       e.lifeos_key, e.remote_updated_at, s.name as source_name, s.color
		from calendar_events e
		join calendar_sources s on s.id = e.source_id
		join calendar_connections c on c.id = s.connection_id
		where c.household_id = ${viewer.householdId}
		  and (s.visibility = 'household' or c.owner_user_id = ${viewer.userId})
		  and s.import_enabled
		  and e.lifeos_key is null
		  and (e.rrule is not null
		       or (left(e.start_local, 10) <= ${addDays(toDay, 1)} and left(e.end_local, 10) >= ${addDays(fromDay, -1)}))
	`;
	const sources = new Map<string, { name: string; color: string | null }>();
	const events = rows.map((r): StoredEvent => {
		sources.set(r.source_id, { name: r.source_name, color: r.color });
		return {
			id: r.id,
			sourceId: r.source_id,
			externalId: r.external_id,
			recurrenceId: r.recurrence_id,
			uid: r.uid,
			etag: r.etag,
			status: r.status,
			summary: r.summary,
			location: r.location,
			allDay: r.all_day,
			start: r.start_local,
			end: r.end_local,
			timeZone: r.time_zone,
			rrule: r.rrule,
			exdates: r.exdates,
			rdates: r.rdates,
			lifeosKey: r.lifeos_key,
			remoteUpdatedAt: toDateOrNull(r.remote_updated_at)?.toISOString() ?? null
		};
	});
	return { events, sources };
}

function addDays(day: string, n: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}
