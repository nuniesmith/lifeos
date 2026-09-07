import type { Viewer } from '../auth/authz';
import { toDate } from '../db/coerce';
import {
	isUuid,
	readableScope,
	toText,
	writableScope,
	type Queryable,
	type WriteResult
} from './base';

/**
 * The Archive (UI: Archive, and the Tasks Bin it replaces).
 *
 * Nothing in LifeOS is deleted: `archived_at` is set and the record leaves the
 * live views. This module is the other half of that promise — without a place
 * to see what has been archived and put it back, "recoverable" is a claim the
 * application never actually honours.
 *
 * The union is deliberately assembled from one description per table rather
 * than hand-written six times, because a missing scope predicate in any one
 * branch is invisible in a result list.
 */

export const ARCHIVE_KINDS = ['task', 'project', 'goal', 'area', 'habit', 'tag'] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

export interface ArchivedRecord {
	kind: ArchiveKind;
	id: string;
	title: string;
	archivedAt: Date;
	/** Where it will reappear once restored, for a link. */
	path: string | null;
}

interface Source {
	table: string;
	titleColumn: string;
	/** Null for tables with no detail page of their own. */
	path: string | null;
	/** Tags carry no owner or visibility, so they scope by household alone. */
	householdOnly?: boolean;
}

const SOURCES: Record<ArchiveKind, Source> = {
	task: { table: 'tasks', titleColumn: 'title', path: '/tasks/' },
	project: { table: 'projects', titleColumn: 'name', path: '/projects/' },
	goal: { table: 'goals', titleColumn: 'title', path: '/goals/' },
	area: { table: 'areas', titleColumn: 'name', path: '/areas/' },
	habit: { table: 'habits', titleColumn: 'name', path: '/habits/' },
	// Tags have neither owner nor visibility, so household isolation is the
	// whole rule for them — see `householdScope` in ./base.
	tag: { table: 'tags', titleColumn: 'name', path: null, householdOnly: true }
};

const scopeFor = (sql: Queryable, viewer: Viewer, source: Source, write: boolean) =>
	source.householdOnly
		? sql`t.household_id = ${viewer.householdId}::uuid`
		: write
			? writableScope(sql, viewer, 't')
			: readableScope(sql, viewer, 't');

export interface ArchiveOptions {
	kinds?: readonly ArchiveKind[];
	search?: string;
	limit?: number;
}

/** Everything archived, most recently archived first. */
export async function listArchived(
	sql: Queryable,
	viewer: Viewer,
	options: ArchiveOptions = {}
): Promise<ArchivedRecord[]> {
	const kinds = options.kinds?.length ? options.kinds : ARCHIVE_KINDS;
	const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);
	const search = options.search?.trim();

	const branches = kinds.map((kind) => {
		const source = SOURCES[kind];
		return sql`
			select ${kind}::text as kind, t.id, t.${sql(source.titleColumn)} as title,
			       t.archived_at,
			       ${source.path}::text as path_prefix
			from ${sql(source.table)} t
			where ${scopeFor(sql, viewer, source, false)}
			  and t.archived_at is not null
			  ${search ? sql`and t.${sql(source.titleColumn)} ilike ${'%' + search + '%'}` : sql``}
		`;
	});

	let union = branches[0]!;
	for (const branch of branches.slice(1)) union = sql`${union} union all ${branch}`;

	const rows = await sql<
		{
			kind: string;
			id: string;
			title: string;
			archived_at: unknown;
			path_prefix: string | null;
		}[]
	>`
		with archived as (${union})
		select * from archived
		order by archived_at desc, title asc
		limit ${limit}
	`;

	return rows.map((row) => ({
		kind: row.kind as ArchiveKind,
		id: row.id,
		title: toText(row.title),
		archivedAt: toDate(row.archived_at),
		path: row.path_prefix ? `${row.path_prefix}${row.id}` : null
	}));
}

/** How many are archived, per kind, for the filter chips. */
export async function archivedCounts(
	sql: Queryable,
	viewer: Viewer
): Promise<Record<ArchiveKind, number>> {
	const branches = ARCHIVE_KINDS.map((kind) => {
		const source = SOURCES[kind];
		return sql`
			select ${kind}::text as kind, count(*)::int as total
			from ${sql(source.table)} t
			where ${scopeFor(sql, viewer, source, false)} and t.archived_at is not null
		`;
	});

	let union = branches[0]!;
	for (const branch of branches.slice(1)) union = sql`${union} union all ${branch}`;

	const rows = await sql<{ kind: string; total: number }[]>`${union}`;
	const counts = Object.fromEntries(ARCHIVE_KINDS.map((k) => [k, 0])) as Record<
		ArchiveKind,
		number
	>;
	for (const row of rows) counts[row.kind as ArchiveKind] = Number(row.total);
	return counts;
}

/**
 * Puts an archived record back into the live views.
 *
 * The scope is in the UPDATE, so a record the viewer may not write cannot be
 * restored by a forged post either — being able to see something in the
 * archive is not the same as being allowed to bring it back.
 */
export async function restore(
	sql: Queryable,
	viewer: Viewer,
	kind: ArchiveKind,
	id: string
): Promise<WriteResult<{ id: string }>> {
	if (!isUuid(id)) return { ok: false, reason: 'not_found' };
	const source = SOURCES[kind];
	if (!source) return { ok: false, reason: 'invalid', message: 'unknown record type' };

	const rows = await sql<{ id: string }[]>`
		update ${sql(source.table)} t
		set archived_at = null, updated_at = now()
		where t.id = ${id}::uuid
		  and t.archived_at is not null
		  and ${scopeFor(sql, viewer, source, true)}
		returning t.id
	`;

	const row = rows[0];
	if (!row) return { ok: false, reason: 'not_found' };
	return { ok: true, record: { id: row.id } };
}
