import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate, toDateOrNull } from '../db/coerce';
import {
	InvalidInput,
	archiveScoped,
	baseColumns,
	getScoped,
	guarded,
	isUuid,
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
 * See migration 0013. Entries can also link to one another (migration 0023,
 * PACK1-001) — see the "links" section at the end of this file.
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
			// Not set at creation only: the household's own shelving word for a
			// thing ("Podcast", "Website") is exactly the sort of label someone
			// notices is wrong, or wants to rename, well after saving the entry.
			format: patched(patch, 'format', current.format, (v) => optionalText(v, 'format')),
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
				format = ${next.format},
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
 * "Delete": archived rows leave every list on this pack and are recoverable
 * the same way as everywhere else in LifeOS — see base.ts's
 * `archivedAssignment`, and `/archive` for where a household puts one back.
 */
export const setLibraryItemArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<LibraryItem>> =>
	archiveScoped<LibraryRow, LibraryItem>({
		sql,
		table: TABLE,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: columns(sql),
		map: mapItem
	});

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

// ─── links (migration 0023, PACK1-001) ─────────────────────────────────────
//
// One entry pointing at another — "the sequel to", "the talk this book is
// based on". Modelled on `task_dependencies` in tasks.ts: a same-table
// relation, stored as one row per edge. Unlike a dependency it has no
// direction, so there is one list rather than a blockedBy/blocking pair, and
// the row is inserted with its two ids in whichever order `library_links`'
// own check constraint requires — the caller never has to know or care which
// end is "a" and which is "b".

export interface LibraryLink {
	/** The *other* entry's id — never the one the caller already has. */
	itemId: string;
	title: string;
	entryType: EntryType;
	archived: boolean;
}

const mapLink = (row: {
	item_id: string;
	title: string;
	entry_type: string;
	archived: boolean;
}): LibraryLink => ({
	itemId: row.item_id,
	title: toText(row.title),
	entryType: row.entry_type as EntryType,
	archived: Boolean(row.archived)
});

/**
 * Every entry linked to `itemId`, from either side of the stored edge.
 *
 * Each side of the union is scoped by `readableScope` on the *other* entry, so
 * a link to something the viewer may not read simply does not appear — the
 * same rule `tagsForEntity` applies, rather than a link disclosing a title
 * through the join. The anchor entry's own readability is the caller's job:
 * every caller here already holds it from a prior `getLibraryItem`, the same
 * order `listTaskDependencies` is used in `tasks/[id]`.
 */
export async function listLibraryLinks(
	sql: Queryable,
	viewer: Viewer,
	itemId: string
): Promise<LibraryLink[]> {
	if (!isUuid(itemId)) return [];

	const rows = await sql<
		{ item_id: string; title: string; entry_type: string; archived: boolean }[]
	>`
		select t.id as item_id, t.title, t.entry_type, (t.archived_at is not null) as archived
		from library_links l
		join library_items t on t.id = l.item_b_id
		where l.item_a_id = ${itemId}::uuid and ${readableScope(sql, viewer, 't')}
		union all
		select t.id as item_id, t.title, t.entry_type, (t.archived_at is not null) as archived
		from library_links l
		join library_items t on t.id = l.item_a_id
		where l.item_b_id = ${itemId}::uuid and ${readableScope(sql, viewer, 't')}
		order by title asc
	`;
	return rows.map(mapLink);
}

/**
 * Links `fromId` to `toId`. Idempotent: linking the same pair twice leaves one
 * edge, because the second insert only ever collides with the first.
 *
 * `fromId` must be writable — the entry whose page this was added from, and
 * the one whose displayed links are changing by this call — while `toId` need
 * only be readable, the same asymmetry `addTaskDependency` uses for a
 * dependency's two ends. Because the edge is undirected and shown on both
 * pages alike, that asymmetry only decides *who may start the link*, not
 * which end ends up counted as "the other one" afterwards.
 */
export function addLibraryLink(
	sql: Queryable,
	viewer: Viewer,
	fromId: string,
	toId: string
): Promise<WriteResult<LibraryLink>> {
	return guarded<LibraryLink>(async () => {
		if (!isUuid(fromId) || !isUuid(toId)) throw new InvalidInput('choose an entry to link to');
		if (fromId === toId) throw new InvalidInput('an entry cannot link to itself');

		const from = await getScoped<{ id: string }>(
			sql,
			TABLE,
			fromId,
			writableScope(sql, viewer, TABLE),
			sql`id`
		);
		if (!from) return { ok: false, reason: 'not_found' };

		const to = await getScoped<{
			id: string;
			title: string;
			entry_type: string;
			archived_at: unknown;
		}>(
			sql,
			TABLE,
			toId,
			readableScope(sql, viewer, TABLE),
			sql`id, title, entry_type, archived_at`
		);
		if (!to) return { ok: false, reason: 'not_found' };

		await sql`
			insert into library_links (item_a_id, item_b_id, created_by)
			values (least(${fromId}::uuid, ${toId}::uuid), greatest(${fromId}::uuid, ${toId}::uuid),
			        ${viewer.userId}::uuid)
			on conflict (item_a_id, item_b_id) do nothing
		`;

		return {
			ok: true,
			record: {
				itemId: to.id,
				title: toText(to.title),
				entryType: to.entry_type as EntryType,
				archived: to.archived_at !== null
			}
		};
	});
}

/**
 * Removes the edge between `fromId` and `toId`. Not linked is success, not a
 * failure — the same convention `detachTag` uses, and for the same reason: the
 * caller asked for an absence, and an absence is what it now has.
 *
 * Only `fromId` needs to be writable, mirroring `removeTaskDependency`: the
 * edge is symmetric, so which end happens to be passed first is a fact about
 * which page the remove button was clicked on, not about who owns the link.
 */
export async function removeLibraryLink(
	sql: Queryable,
	viewer: Viewer,
	fromId: string,
	toId: string
): Promise<boolean> {
	if (!isUuid(fromId) || !isUuid(toId)) return false;
	const rows = await sql<{ item_a_id: string }[]>`
		delete from library_links l
		using library_items t
		where t.id = ${fromId}::uuid
		  and ${writableScope(sql, viewer, 't')}
		  and l.item_a_id = least(${fromId}::uuid, ${toId}::uuid)
		  and l.item_b_id = greatest(${fromId}::uuid, ${toId}::uuid)
		returning l.item_a_id
	`;
	return rows.length > 0;
}
