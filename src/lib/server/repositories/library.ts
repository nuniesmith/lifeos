import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate, toDateOrNull } from '../db/coerce';
import {
	InvalidInput,
	baseColumns,
	getScoped,
	guarded,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toBool,
	toInt,
	toText,
	toTextOrNull,
	writableBy,
	writableScope,
	writeScoped,
	type BaseRow,
	type OwnershipInput,
	type PageOptions,
	type Queryable,
	type RecordBase,
	type WriteResult
} from './base';
import { optionalText, patched, requiredText } from './validate';

/**
 * The Library (MODEL-002, feature pack 3).
 *
 * One table behind three pages — Library, Reading and the Knowledge Hub. They
 * are three questions about the same 42 things, not three collections, so the
 * difference between them lives in a filter here rather than in the schema.
 * See migration 0013.
 */

export const ENTRY_TYPES = ['book', 'note', 'reference'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const LIBRARY_STATUSES = ['inbox', 'reading_list', 'live', 'archived_read'] as const;
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

export interface LibraryItem extends RecordBase {
	title: string;
	fullTitle: string | null;
	author: string | null;
	url: string | null;
	summary: string | null;
	notes: string | null;
	entryType: EntryType;
	format: string | null;
	status: LibraryStatus;
	highlightCount: number;
	lastInteractionAt: Date | null;
	isFavourite: boolean;
}

interface LibraryRow extends BaseRow {
	title: string;
	full_title: string | null;
	author: string | null;
	url: string | null;
	summary: string | null;
	notes: string | null;
	entry_type: string;
	format: string | null;
	status: string;
	highlight_count: unknown;
	last_interaction_at: unknown;
	is_favourite: unknown;
}

const TABLE = 'library_items';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	title, full_title, author, url, summary, notes, entry_type, format, status,
	highlight_count, last_interaction_at, is_favourite`;

const mapItem = (row: LibraryRow): LibraryItem => ({
	...mapBase(row),
	title: toText(row.title),
	fullTitle: toTextOrNull(row.full_title),
	author: toTextOrNull(row.author),
	url: toTextOrNull(row.url),
	summary: toTextOrNull(row.summary),
	notes: toTextOrNull(row.notes),
	entryType: row.entry_type as EntryType,
	format: toTextOrNull(row.format),
	status: row.status as LibraryStatus,
	highlightCount: toInt(row.highlight_count),
	lastInteractionAt: toDateOrNull(row.last_interaction_at),
	isFavourite: toBool(row.is_favourite)
});

export interface LibraryFilters extends PageOptions {
	status?: LibraryStatus | readonly LibraryStatus[];
	entryType?: EntryType | readonly EntryType[];
	format?: string;
	search?: string;
	favouritesOnly?: boolean;
	withHighlights?: boolean;
	includeArchived?: boolean;
	order?: 'title' | 'author' | 'recent' | 'stale';
}

const asArray = <T>(value: T | readonly T[] | undefined): T[] | null =>
	value === undefined ? null : Array.isArray(value) ? [...value] : [value as T];

export async function listLibrary(
	sql: Queryable,
	viewer: Viewer,
	filters: LibraryFilters = {}
): Promise<LibraryItem[]> {
	const { limit, offset } = pageOf(filters);
	const statuses = asArray(filters.status);
	const types = asArray(filters.entryType);

	const rows = await sql<LibraryRow[]>`
		select ${columns(sql)} from ${sql(TABLE)}
		where ${readableScope(sql, viewer, TABLE)}
		  and ${liveScope(sql, TABLE, filters.includeArchived)}
		  ${statuses ? sql`and status in ${sql(statuses)}` : sql``}
		  ${types ? sql`and entry_type in ${sql(types)}` : sql``}
		  ${filters.format ? sql`and format = ${filters.format}` : sql``}
		  ${filters.favouritesOnly ? sql`and is_favourite` : sql``}
		  ${filters.withHighlights ? sql`and highlight_count > 0` : sql``}
		  ${
				filters.search
					? sql`and (title ilike ${'%' + filters.search.trim() + '%'}
					        or author ilike ${'%' + filters.search.trim() + '%'})`
					: sql``
			}
		order by ${
			filters.order === 'author'
				? sql`author asc nulls last, title asc`
				: filters.order === 'recent'
					? sql`last_interaction_at desc nulls last, title asc`
					: filters.order === 'stale'
						? // Never touched sorts first: it is the most rediscoverable
							// thing in the library, not the least.
							sql`last_interaction_at asc nulls first, title asc`
						: sql`title asc`
		}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapItem);
}

export async function getLibraryItem(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<LibraryItem | null> {
	const row = await getScoped<LibraryRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapItem(row) : null;
}

export interface LibraryInput extends OwnershipInput {
	title?: unknown;
	fullTitle?: unknown;
	author?: unknown;
	url?: unknown;
	summary?: unknown;
	notes?: unknown;
	entryType?: unknown;
	format?: unknown;
	status?: unknown;
	isFavourite?: unknown;
}

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	label: string,
	fallback: T
): T {
	if (value === undefined || value === null || value === '') return fallback;
	const v = String(value)
		.trim()
		.toLowerCase()
		.replace(/[\s/]+/g, '_');
	if (!allowed.includes(v as T)) {
		throw new InvalidInput(`${label} must be one of ${allowed.join(', ')}`);
	}
	return v as T;
}

export function createLibraryItem(
	sql: Queryable,
	viewer: Viewer,
	input: LibraryInput
): Promise<WriteResult<LibraryItem>> {
	return guarded<LibraryItem>(async () => {
		const title = requiredText(input.title, 'title', 500);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		const rows = await sql<LibraryRow[]>`
			insert into ${sql(TABLE)} (
				household_id, owner_user_id, visibility, title, full_title, author, url,
				summary, notes, entry_type, format, status, is_favourite,
				created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title},
				${optionalText(input.fullTitle, 'full title')},
				${optionalText(input.author, 'author')}, ${optionalText(input.url, 'url')},
				${optionalText(input.summary, 'summary')}, ${optionalText(input.notes, 'notes')},
				${oneOf(input.entryType, ENTRY_TYPES, 'entry type', 'reference')},
				${optionalText(input.format, 'format')},
				${oneOf(input.status, LIBRARY_STATUSES, 'status', 'inbox')},
				${input.isFavourite === true || input.isFavourite === 'on'}::boolean,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapItem(row) };
	});
}

export function updateLibraryItem(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: LibraryInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<LibraryItem>> {
	return guarded<LibraryItem>(async () => {
		const current = await getLibraryItem(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			title: patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 500)),
			author: patched(patch, 'author', current.author, (v) => optionalText(v, 'author')),
			url: patched(patch, 'url', current.url, (v) => optionalText(v, 'url')),
			summary: patched(patch, 'summary', current.summary, (v) => optionalText(v, 'summary')),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes')),
			status: patched(patch, 'status', current.status, (v) =>
				oneOf(v, LIBRARY_STATUSES, 'status', current.status)
			),
			entryType: patched(patch, 'entryType', current.entryType, (v) =>
				oneOf(v, ENTRY_TYPES, 'entry type', current.entryType)
			),
			isFavourite: patched(
				patch,
				'isFavourite',
				current.isFavourite,
				(v) => v === true || v === 'on'
			)
		};

		return writeScoped<LibraryRow, LibraryItem>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				title = ${next.title}, author = ${next.author}, url = ${next.url},
				summary = ${next.summary}, notes = ${next.notes},
				status = ${next.status}, entry_type = ${next.entryType},
				is_favourite = ${next.isFavourite}::boolean,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapItem,
			mayWrite: writableBy(viewer)
		});
	});
}

/**
 * Records that an entry was opened.
 *
 * This is what keeps "rediscover" meaningful: without it the stale list is
 * ordered by when something was imported rather than when it was last useful.
 */
export async function touchLibraryItem(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<WriteResult<{ id: string; lastInteractionAt: Date }>> {
	const rows = await sql<{ id: string; last_interaction_at: unknown }[]>`
		update ${sql(TABLE)} t
		set last_interaction_at = now()
		where t.id = ${id}::uuid and ${writableScope(sql, viewer, 't')}
		returning t.id, t.last_interaction_at
	`;
	const row = rows[0];
	if (!row) return { ok: false, reason: 'not_found' };
	return { ok: true, record: { id: row.id, lastInteractionAt: toDate(row.last_interaction_at) } };
}

export interface LibrarySummary {
	total: number;
	byStatus: Record<LibraryStatus, number>;
	byType: Record<EntryType, number>;
	formats: string[];
	highlights: number;
}

/** Everything the three pages need for their headers, in one round trip. */
export async function librarySummary(sql: Queryable, viewer: Viewer): Promise<LibrarySummary> {
	const [statusRows, typeRows, formatRows, totals] = await Promise.all([
		sql<{ status: string; total: number }[]>`
			select status, count(*)::int as total from ${sql(TABLE)}
			where ${readableScope(sql, viewer, TABLE)} and archived_at is null
			group by status
		`,
		sql<{ entry_type: string; total: number }[]>`
			select entry_type, count(*)::int as total from ${sql(TABLE)}
			where ${readableScope(sql, viewer, TABLE)} and archived_at is null
			group by entry_type
		`,
		sql<{ format: string }[]>`
			select distinct format from ${sql(TABLE)}
			where ${readableScope(sql, viewer, TABLE)} and archived_at is null and format is not null
			order by format asc
		`,
		sql<{ total: number; highlights: number }[]>`
			select count(*)::int as total, coalesce(sum(highlight_count), 0)::int as highlights
			from ${sql(TABLE)}
			where ${readableScope(sql, viewer, TABLE)} and archived_at is null
		`
	]);

	const byStatus = Object.fromEntries(LIBRARY_STATUSES.map((s) => [s, 0])) as Record<
		LibraryStatus,
		number
	>;
	for (const row of statusRows) byStatus[row.status as LibraryStatus] = Number(row.total);

	const byType = Object.fromEntries(ENTRY_TYPES.map((t) => [t, 0])) as Record<EntryType, number>;
	for (const row of typeRows) byType[row.entry_type as EntryType] = Number(row.total);

	return {
		total: toInt(totals[0]?.total ?? 0),
		byStatus,
		byType,
		formats: formatRows.map((r) => toText(r.format)),
		highlights: toInt(totals[0]?.highlights ?? 0)
	};
}
