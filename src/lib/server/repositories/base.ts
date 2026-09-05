import type { Fragment, Sql, TransactionSql } from 'postgres';
import { canWrite, type OwnedRecord, type Viewer, type Visibility } from '../auth/authz';
import { toDate, toDateOrNull } from '../db/coerce';
import { formatDay, isDay } from './dates';

/**
 * Shared repository machinery (MODEL-003).
 *
 * Three rules hold everywhere in this directory, and each of them exists
 * because ignoring it has already cost this project a production failure or
 * would open a privacy hole:
 *
 *  1. **Nothing relies on driver type conversion.** Timestamps leave as
 *     `${iso}::timestamptz` or `now()` and come back through `toDate` /
 *     `toDateOrNull`. `date` columns are selected `::text` and travel as
 *     `YYYY-MM-DD` strings, because a `date` parsed into a JS Date is a
 *     timestamp in some timezone and "the day" then depends on where the
 *     process is running. Numerics arrive as strings and are coerced here.
 *  2. **Authorization is a WHERE clause, never a JS filter after the fetch.**
 *     Every read and every write carries the household/visibility predicate
 *     into the query, so a forgotten check cannot leak a row that was already
 *     on the wire. The pure rules in `auth/authz.ts` remain the definition;
 *     {@link readableScope} and {@link writableScope} are their SQL form, and
 *     the integration suite proves the two agree over every combination.
 *  3. **Everything accepts `Queryable`**, so a repository call composes inside
 *     a caller's transaction. `Sql` and `TransactionSql` are structurally
 *     different types in this driver even though the query interface matches.
 */

/** A pool or an open transaction; repositories must work inside both. */
export type Queryable = Sql | TransactionSql;

// ─── shared record shape ───────────────────────────────────────────────────

/**
 * The columns every user-owned domain table carries (plan §6). Structurally a
 * superset of {@link OwnedRecord}, so records can be handed straight to
 * `canRead` / `canWrite` without an adapter.
 */
export interface RecordBase extends OwnedRecord {
	id: string;
	householdId: string;
	ownerUserId: string | null;
	visibility: Visibility;
	notionPageId: string | null;
	sourceRecordId: string | null;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string | null;
	updatedBy: string | null;
	archivedAt: Date | null;
}

/** The raw shape of {@link RecordBase} as it comes back from the driver. */
export interface BaseRow {
	id: string;
	household_id: string;
	owner_user_id: string | null;
	visibility: unknown;
	notion_page_id: string | null;
	source_record_id: string | null;
	// Timestamps are typed unknown deliberately: the driver hands back a Date
	// or a string depending on the build, so every read goes through toDate.
	created_at: unknown;
	updated_at: unknown;
	created_by: string | null;
	updated_by: string | null;
	archived_at: unknown;
}

/** The base columns, for both `select` and `returning`. */
export const baseColumns = (sql: Queryable): Fragment => sql`
	id, household_id, owner_user_id, visibility, notion_page_id, source_record_id,
	created_at, updated_at, created_by, updated_by, archived_at`;

export const mapBase = (row: BaseRow): RecordBase => ({
	id: row.id,
	householdId: row.household_id,
	ownerUserId: row.owner_user_id,
	visibility: toVisibility(row.visibility),
	notionPageId: row.notion_page_id,
	sourceRecordId: row.source_record_id,
	createdAt: toDate(row.created_at),
	updatedAt: toDate(row.updated_at),
	createdBy: row.created_by,
	updatedBy: row.updated_by,
	archivedAt: toDateOrNull(row.archived_at)
});

// ─── results ───────────────────────────────────────────────────────────────

/**
 * Why a write did not happen.
 *
 * `not_found` covers "no such row" and "in another household" on purpose:
 * telling a caller that a record exists but belongs to someone else is itself
 * a disclosure, and the household boundary is the one that must not leak.
 */
export type WriteFailure = 'not_found' | 'forbidden' | 'conflict' | 'invalid';

export type WriteResult<T> =
	{ ok: true; record: T } | { ok: false; reason: WriteFailure; message?: string; current?: T };

/** Thrown by the validators and converted into an `invalid` result. */
export class InvalidInput extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidInput';
	}
}

/**
 * Runs a repository write, turning a validation failure into a result rather
 * than an exception. Callers get one discriminated union to handle instead of
 * a union plus a try/catch, so a forgotten catch cannot become a 500.
 */
export async function guarded<T>(fn: () => Promise<WriteResult<T>>): Promise<WriteResult<T>> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof InvalidInput) return { ok: false, reason: 'invalid', message: err.message };
		// A unique violation is the database refusing a duplicate the caller
		// asked for — one daily log per person per day, one tag name per
		// household. That is invalid input, not a server fault, and it must not
		// surface as a 500 or abort an enclosing transaction silently.
		if (isUniqueViolation(err)) {
			return { ok: false, reason: 'invalid', message: 'that record already exists' };
		}
		throw err;
	}
}

/** PostgreSQL's `unique_violation`. */
export function isUniqueViolation(err: unknown): boolean {
	return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

// ─── authorization as SQL ──────────────────────────────────────────────────

/**
 * The SQL form of {@link import('../auth/authz').canRead}: household isolation
 * first, then visibility. `private` excludes the other household member
 * including an admin, so no role check appears here — deliberately.
 */
export function readableScope(sql: Queryable, viewer: Viewer, alias: string): Fragment {
	return sql`${sql(alias)}.household_id = ${viewer.householdId}::uuid
		and (${sql(alias)}.visibility = 'household'
		     or ${sql(alias)}.owner_user_id = ${viewer.userId}::uuid)`;
}

/**
 * The SQL form of {@link import('../auth/authz').canWrite}: readable, and
 * either unowned (household-wide) or the viewer's own.
 */
export function writableScope(sql: Queryable, viewer: Viewer, alias: string): Fragment {
	return sql`${readableScope(sql, viewer, alias)}
		and (${sql(alias)}.owner_user_id is null
		     or ${sql(alias)}.owner_user_id = ${viewer.userId}::uuid)`;
}

/**
 * Household scoping with no owner dimension, for tables like `tags` that have
 * no owner or visibility columns. Household isolation still applies.
 */
export function householdScope(sql: Queryable, viewer: Viewer, alias: string): Fragment {
	return sql`${sql(alias)}.household_id = ${viewer.householdId}::uuid`;
}

/** `archived_at is null` unless archived rows were asked for. */
export function liveScope(sql: Queryable, alias: string, includeArchived = false): Fragment {
	return includeArchived ? sql`true` : sql`${sql(alias)}.archived_at is null`;
}

// ─── coercion of read values ───────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string is a UUID. Repositories check before interpolating an id:
 * PostgreSQL raises on a malformed uuid literal, which would turn a mistyped
 * URL into a 500 instead of a "not found".
 */
export const isUuid = (value: unknown): value is string =>
	typeof value === 'string' && UUID.test(value);

export function toText(value: unknown): string {
	if (typeof value === 'string') return value;
	throw new TypeError(`expected text, received ${typeof value}`);
}

export function toTextOrNull(value: unknown): string | null {
	return value === null || value === undefined ? null : toText(value);
}

export function toBool(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 't' || value === 'true') return true;
	if (value === 'f' || value === 'false') return false;
	throw new TypeError(`expected a boolean, received ${typeof value}`);
}

export function toIntOrNull(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const n = typeof value === 'number' ? value : Number(String(value));
	if (!Number.isFinite(n)) throw new TypeError(`expected an integer, received ${String(value)}`);
	return Math.trunc(n);
}

export function toInt(value: unknown): number {
	const n = toIntOrNull(value);
	if (n === null) throw new TypeError('expected an integer, received null');
	return n;
}

/** `numeric` arrives as a string so no precision is lost in transit. */
export function toNumberOrNull(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const n = typeof value === 'number' ? value : Number(String(value));
	if (!Number.isFinite(n)) throw new TypeError(`expected a number, received ${String(value)}`);
	return n;
}

/**
 * Coerces a `date` column to a `YYYY-MM-DD` string.
 *
 * Selected `::text` it already is one. A Date only arrives if a query forgot
 * the cast; this driver parses `date` as UTC midnight, so reading the UTC
 * components back out is the one conversion that cannot shift the day.
 */
export function toDayOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return formatDay(value);
	const text = String(value);
	// A timestamp-shaped string still carries the day in its first ten chars.
	const head = text.slice(0, 10);
	if (isDay(head)) return head;
	throw new TypeError(`expected a calendar date, received ${text}`);
}

export function toDay(value: unknown): string {
	const day = toDayOrNull(value);
	if (day === null) throw new TypeError('expected a calendar date, received null');
	return day;
}

export function toVisibility(value: unknown): Visibility {
	if (value === 'household' || value === 'private') return value;
	throw new TypeError(`unknown visibility ${String(value)}`);
}

// ─── pagination ────────────────────────────────────────────────────────────

export interface PageOptions {
	limit?: number;
	offset?: number;
}

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;

/** Clamps paging so no caller can ask for the whole table by accident. */
export function pageOf(options: PageOptions = {}): { limit: number; offset: number } {
	const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)));
	const offset = Math.max(0, Math.trunc(options.offset ?? 0));
	return { limit, offset };
}

// ─── generic scoped operations ─────────────────────────────────────────────

/**
 * Reads one row by id under a scope predicate.
 *
 * Returns null for a malformed id, a row in another household, and a row the
 * viewer may not see — the caller cannot tell those apart, which is the point.
 */
export async function getScoped<Row extends object>(
	sql: Queryable,
	table: string,
	id: string,
	scope: Fragment,
	columns: Fragment
): Promise<Row | null> {
	if (!isUuid(id)) return null;
	const rows = await sql<Row[]>`
		select ${columns} from ${sql(table)}
		where id = ${id}::uuid and ${scope}
		limit 1
	`;
	return rows[0] ?? null;
}

/**
 * Optimistic concurrency precondition.
 *
 * Compared at millisecond resolution because that is all a JS Date holds:
 * PostgreSQL stores `updated_at` to the microsecond, so an exact `=` against
 * a value that has been through the driver and back never matches. Truncating
 * both sides makes the comparison symmetric. Two writes inside the same
 * millisecond would not be detected, which for a two-person household is not
 * a real event; a lost update across a page load, which this does catch, is.
 */
function versionPrecondition(
	sql: Queryable,
	table: string,
	expectedUpdatedAt: Date | string | undefined
): Fragment {
	if (expectedUpdatedAt === undefined) return sql`true`;
	const iso = toDate(expectedUpdatedAt).toISOString();
	return sql`date_trunc('milliseconds', ${sql(table)}.updated_at)
		= date_trunc('milliseconds', ${iso}::timestamptz)`;
}

export interface ScopedWrite<Row extends object, T> {
	sql: Queryable;
	table: string;
	id: string;
	/** What the viewer may see; decides `not_found` versus `forbidden`. */
	readScope: Fragment;
	/** What the viewer may change; carried into the UPDATE itself. */
	writeScope: Fragment;
	/** Omitted means no precondition, for callers that have not read the row. */
	expectedUpdatedAt?: Date | string;
	assignments: Fragment;
	columns: Fragment;
	map: (row: Row) => T;
	/** Re-checked in JS only to explain a refusal, never to authorise one. */
	mayWrite: (record: T) => boolean;
}

/**
 * Runs a scoped, version-checked UPDATE and explains a miss.
 *
 * The authorization and the version check are both in the statement, so the
 * write either happened under the rules or did not happen at all. Only when
 * nothing was written does a second read run, to say *why* — which is
 * presentation, not enforcement.
 */
export async function writeScoped<Row extends object, T>(
	spec: ScopedWrite<Row, T>
): Promise<WriteResult<T>> {
	const { sql, table, id } = spec;
	if (!isUuid(id)) return { ok: false, reason: 'not_found' };

	const rows = await sql<Row[]>`
		update ${sql(table)} set ${spec.assignments}
		where ${sql(table)}.id = ${id}::uuid
		  and ${spec.writeScope}
		  and ${versionPrecondition(sql, table, spec.expectedUpdatedAt)}
		returning ${spec.columns}
	`;

	const updated = rows[0];
	if (updated) return { ok: true, record: spec.map(updated) };

	const existing = await getScoped<Row>(sql, table, id, spec.readScope, spec.columns);
	if (!existing) return { ok: false, reason: 'not_found' };

	const current = spec.map(existing);
	if (!spec.mayWrite(current)) return { ok: false, reason: 'forbidden', current };
	return { ok: false, reason: 'conflict', current };
}

/**
 * The archive/unarchive assignment. Deletion is recoverable everywhere in
 * LifeOS (plan §8): rows move to a Trash view, they do not leave the table.
 */
export const archivedAssignment = (sql: Queryable, archived: boolean): Fragment =>
	sql`archived_at = case when ${archived}::boolean then now() else null end`;

/**
 * Archive or restore an owner-scoped record.
 *
 * `expectedUpdatedAt` is optional here alone: archiving is usually triggered
 * from a list where the row's version is not to hand, and re-archiving an
 * already-archived record is harmless. Pass it when the caller has it.
 */
export function archiveScoped<Row extends object, T extends OwnedRecord>(spec: {
	sql: Queryable;
	table: string;
	viewer: Viewer;
	id: string;
	archived: boolean;
	expectedUpdatedAt?: Date | string;
	columns: Fragment;
	map: (row: Row) => T;
}): Promise<WriteResult<T>> {
	const { sql, viewer } = spec;
	return writeScoped<Row, T>({
		sql,
		table: spec.table,
		id: spec.id,
		readScope: readableScope(sql, viewer, spec.table),
		writeScope: writableScope(sql, viewer, spec.table),
		expectedUpdatedAt: spec.expectedUpdatedAt,
		assignments: sql`${archivedAssignment(sql, spec.archived)},
			updated_by = ${viewer.userId}::uuid`,
		columns: spec.columns,
		map: spec.map,
		mayWrite: writableBy(viewer)
	});
}

/** `canWrite` bound to a viewer, for {@link ScopedWrite.mayWrite}. */
export const writableBy =
	(viewer: Viewer) =>
	(record: OwnedRecord): boolean =>
		canWrite(record, viewer);

// ─── ownership on create ───────────────────────────────────────────────────

export interface OwnershipInput {
	ownerUserId?: string | null;
	visibility?: Visibility;
}

/**
 * Resolves who owns a record, refusing two combinations outright.
 *
 * Assigning ownership to *somebody else* is refused because `canWrite` would
 * then deny the person doing it: creating — or handing over — something you
 * may not subsequently edit is a trap, not a feature.
 *
 * A `private` record with no owner is refused because it would be readable by
 * nobody at all: `canRead` matches private records on owner identity, and null
 * matches no one. It is a silent write-only hole, so it fails loudly.
 *
 * Only an ownership the caller *asked* for is checked. An update that does not
 * mention the owner keeps whatever is there, including another member's — that
 * is not an attempt to reassign it, and the write is still refused by the
 * scope in SQL, which reports it as forbidden rather than as bad input.
 */
export function resolveOwnership(
	viewer: Viewer,
	input: OwnershipInput,
	defaults: { ownerUserId: string | null; visibility: Visibility }
): { ownerUserId: string | null; visibility: Visibility } {
	const requested = input.ownerUserId;
	const ownerUserId = requested === undefined ? defaults.ownerUserId : requested;
	const visibility = input.visibility ?? defaults.visibility;

	if (requested !== undefined && requested !== null && requested !== viewer.userId) {
		throw new InvalidInput('a record may only be owned by nobody or by the person saving it');
	}
	if (visibility === 'private' && ownerUserId === null) {
		throw new InvalidInput('a private record needs an owner, or nobody could read it');
	}
	return { ownerUserId, visibility };
}

// ─── household calendar ────────────────────────────────────────────────────

/**
 * Today in the household's own timezone.
 *
 * "Due today" is a question about a wall clock, not about UTC. The household
 * carries its timezone, so the answer is computed there rather than wherever
 * the server happens to be.
 */
export async function householdToday(sql: Queryable, householdId: string): Promise<string> {
	const rows = await sql<{ today: string }[]>`
		select (now() at time zone timezone)::date::text as today
		from households where id = ${householdId}::uuid
	`;
	const row = rows[0];
	if (!row) throw new Error('household not found');
	return toDay(row.today);
}
