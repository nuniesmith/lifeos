import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate } from '../db/coerce';
import {
	householdScope,
	isUuid,
	readableScope,
	toText,
	toTextOrNull,
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
 * than hand-written once per kind, because a missing scope predicate in any
 * one branch is invisible in a result list.
 *
 * Every table that carries `archived_at` is either described here or named in
 * {@link NOT_IN_THE_ARCHIVE} with the reason it is left out, and an
 * integration test reads the live schema to hold that true. That includes
 * tables nothing archives yet: a table with the column has already made the
 * promise, and the day a page grows an Archive button its rows are restorable
 * without anyone remembering to come back here. It also covers the rows the
 * importer brings in already archived in Notion (people, recipes, the
 * library, …), which no page of their own shows or can put back.
 */

export const ARCHIVE_KINDS = [
	'task',
	'project',
	'goal',
	'area',
	'habit',
	'tag',
	'daily_log',
	'important_date',
	'significant_event',
	'life_assessment',
	'medication',
	'medical_visit',
	'lab_marker',
	'lab_result',
	'health_measurement',
	'health_term',
	'recipe',
	'ingredient',
	'meal_plan',
	'prep_task',
	'library_item',
	'person',
	'wishlist_item',
	'media_item',
	'bill',
	'book',
	'author',
	'book_series',
	'genre',
	'income_entry',
	'routine',
	'savings_contribution'
] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

export interface ArchivedRecord {
	kind: ArchiveKind;
	id: string;
	title: string;
	archivedAt: Date;
	/** Where it will reappear once restored, for a link. */
	path: string | null;
}

/** SQL about one row of a source, which is always aliased `t`. */
type Expression = (sql: Queryable, viewer: Viewer) => Fragment;

/**
 * Who may see an archived row, and who may put it back.
 *
 * - `visibility` — the rule every table with owner and visibility columns
 *   uses for itself: `readableScope` to list, `writableScope` to restore.
 *   Restoring is a write, so seeing a household record in the archive does
 *   not make it the viewer's to bring back.
 * - `household` — for a table with no owner or visibility at all (tags), where
 *   household isolation is the whole rule; see `householdScope`.
 * - `owner` — only the person it belongs to, whatever its visibility.
 */
type Scope = 'visibility' | 'household' | 'owner';

interface Source {
	table: string;
	scope: Scope;
	/** What the row is called in the list, and what the archive's search matches. */
	title: Expression;
	/**
	 * Where it reappears once restored: its own page if it has one, otherwise
	 * the page that lists it. Omitted when there is neither; an expression that
	 * yields null means "no link for this row".
	 */
	path?: Expression;
	/**
	 * A join the title or path needs. It carries its own scope predicate: a
	 * title built from another table must not disclose a row the viewer could
	 * not read directly.
	 */
	join?: Expression;
}

const column =
	(name: string): Expression =>
	(sql) =>
		sql`t.${sql(name)}`;

/** A record with a page of its own, at `prefix` + id. */
const detailPage =
	(prefix: string): Expression =>
	(sql) =>
		sql`${prefix}::text || t.id::text`;

/** A record shown on a list page rather than one of its own. */
const listPage =
	(path: string): Expression =>
	(sql) =>
		sql`${path}::text`;

/** "4 Mar 2026" — the day, which is how a dated record is remembered. */
const day = (sql: Queryable, value: Fragment): Fragment => sql`to_char(${value}, 'FMDD Mon YYYY')`;

/**
 * A timestamp as the household's wall clock reads it. The server's zone is
 * nobody's, and a visit at 9pm is not on the next day because UTC says so.
 */
const householdClock = (sql: Queryable, value: Fragment): Fragment =>
	sql`(${value} at time zone (select h.timezone from households h where h.id = t.household_id))`;

const SOURCES: Record<ArchiveKind, Source> = {
	task: {
		table: 'tasks',
		scope: 'visibility',
		title: column('title'),
		path: detailPage('/tasks/')
	},
	project: {
		table: 'projects',
		scope: 'visibility',
		title: column('name'),
		path: detailPage('/projects/')
	},
	goal: {
		table: 'goals',
		scope: 'visibility',
		title: column('title'),
		path: detailPage('/goals/')
	},
	area: { table: 'areas', scope: 'visibility', title: column('name'), path: detailPage('/areas/') },
	habit: {
		table: 'habits',
		scope: 'visibility',
		title: column('name'),
		path: detailPage('/habits/')
	},
	// Tags have neither owner nor visibility, so household isolation is the
	// whole rule for them — see `householdScope` in ./base. They have no page
	// of their own, so no link either.
	tag: { table: 'tags', scope: 'household', title: column('name') },

	// Owner-scoped, as search is: a journal is nobody else's to browse, whatever
	// its row says about visibility. `/journal/<date>` also opens the *viewer's*
	// entry for that date, so a partner's day would link to the wrong page.
	daily_log: {
		table: 'daily_logs',
		scope: 'owner',
		title: (sql) => sql`to_char(t.on_date, 'FMDay FMDD Mon YYYY')`,
		path: (sql) => sql`'/journal/' || t.on_date::text`
	},
	important_date: {
		table: 'important_dates',
		scope: 'visibility',
		title: column('title'),
		path: listPage('/calendar')
	},
	significant_event: {
		table: 'significant_events',
		scope: 'visibility',
		title: column('title'),
		path: listPage('/yearly-review')
	},
	// A focus is rated again every period, so the period is what tells two
	// archived "Health" ratings apart.
	life_assessment: {
		table: 'life_assessments',
		scope: 'visibility',
		title: (sql) =>
			sql`t.focus || coalesce(' — ' || nullif(concat_ws(' ', t.period, t.year::text), ''), '')`,
		path: listPage('/perspectives')
	},

	medication: {
		table: 'medications',
		scope: 'visibility',
		title: column('name'),
		path: listPage('/health/medications')
	},
	// "Follow up" is most visits' reason; the day is what distinguishes them.
	medical_visit: {
		table: 'medical_visits',
		scope: 'visibility',
		title: (sql) => sql`t.reason || ' — ' || ${day(sql, householdClock(sql, sql`t.visit_at`))}`,
		path: detailPage('/health/visits/')
	},
	lab_marker: {
		table: 'lab_markers',
		scope: 'visibility',
		title: column('name'),
		path: detailPage('/health/labs/')
	},
	// A result is one point on its marker's chart, but the marker page's
	// "Remove" archives it and nothing there brings it back, so this is the
	// only way back for one removed by mistake. Named by its marker through a
	// *scoped* join: a household-visible result can hang off a marker its owner
	// keeps private, and that marker's name must not reach the other member
	// through the result. Such a result is still listed — it is readable in its
	// own right — just as "Lab result", with no link to a page it cannot open.
	lab_result: {
		table: 'lab_results',
		scope: 'visibility',
		join: (sql, viewer) =>
			sql`left join lab_markers m on m.id = t.marker_id and ${readableScope(sql, viewer, 'm')}`,
		title: (sql) =>
			sql`concat_ws(' ', coalesce(m.name, 'Lab result'), trim_scale(t.value)::text, m.units)
			    || ' — ' || ${day(sql, sql`t.result_date`)}`,
		path: (sql) => sql`'/health/labs/' || m.id::text`
	},
	// No title column (migration 0019 stores no derived summary), so the
	// reading is named by when it was taken, to the minute: two on one day are
	// ordinary.
	health_measurement: {
		table: 'health_measurements',
		scope: 'visibility',
		title: (sql) =>
			sql`'Reading — ' || to_char(${householdClock(sql, sql`t.measured_at`)}, 'FMDD Mon YYYY, HH24:MI')`,
		path: listPage('/health/measurements')
	},
	health_term: {
		table: 'health_vocabulary',
		scope: 'visibility',
		title: column('name'),
		path: listPage('/health')
	},

	recipe: {
		table: 'recipes',
		scope: 'visibility',
		title: column('name'),
		path: detailPage('/food/recipes/')
	},
	ingredient: {
		table: 'ingredients',
		scope: 'visibility',
		title: column('name'),
		path: listPage('/food')
	},
	// A day's menu usually has no name of its own; its date is its name.
	meal_plan: {
		table: 'meal_plans',
		scope: 'visibility',
		title: (sql) =>
			sql`coalesce(nullif(trim(t.name), ''), 'Meal plan') || ' — ' || ${day(sql, sql`t.on_date`)}`,
		path: listPage('/food')
	},
	prep_task: {
		table: 'prep_tasks',
		scope: 'visibility',
		title: column('name'),
		path: listPage('/food')
	},

	library_item: {
		table: 'library_items',
		scope: 'visibility',
		title: column('title'),
		path: detailPage('/library/')
	},
	person: {
		table: 'people',
		scope: 'visibility',
		title: column('name'),
		path: listPage('/people')
	},
	wishlist_item: {
		table: 'wishlist_items',
		scope: 'visibility',
		title: column('name'),
		path: listPage('/wishlist')
	},
	media_item: {
		table: 'media_items',
		scope: 'visibility',
		title: column('name'),
		path: listPage('/entertainment')
	},
	bill: { table: 'bills', scope: 'visibility', title: column('name'), path: listPage('/finance') },
	// Named with their day: "Paycheque" or "Transfer to savings" recurs every
	// few weeks, so a title alone cannot tell one archived entry from the next.
	income_entry: {
		table: 'income_entries',
		scope: 'visibility',
		title: (sql) => sql`t.title || ' — ' || ${day(sql, sql`t.received_on`)}`,
		path: listPage('/finance')
	},
	routine: {
		table: 'routines',
		scope: 'visibility',
		title: column('name'),
		path: detailPage('/routines/')
	},
	savings_contribution: {
		table: 'savings_contributions',
		scope: 'visibility',
		title: (sql) => sql`t.title || ' — ' || ${day(sql, sql`t.contributed_on`)}`,
		path: listPage('/finance')
	},

	// Reading Tracker (migration 0030). A book is a full owned record, like
	// everything above; authors, series and genres have neither owner nor
	// visibility of their own — household isolation is the whole rule for
	// them, the same as `tag` above. A genre has no page of its own, but
	// unlike a tag it does have a list that shows it (/reading/genres, where
	// rename and archive both happen inline), so it gets a link there rather
	// than none.
	book: {
		table: 'books',
		scope: 'visibility',
		title: column('title'),
		path: detailPage('/reading/books/')
	},
	author: {
		table: 'authors',
		scope: 'household',
		title: column('name'),
		path: detailPage('/reading/authors/')
	},
	book_series: {
		table: 'book_series',
		scope: 'household',
		title: column('name'),
		path: detailPage('/reading/series/')
	},
	genre: {
		table: 'genres',
		scope: 'household',
		title: column('name'),
		path: listPage('/reading/genres')
	}
};

/**
 * Tables that carry `archived_at` but are deliberately not in the archive,
 * each with the reason. The integration suite fails if a table with the column
 * appears in neither this list nor {@link SOURCES}, so leaving one out is a
 * decision someone wrote down rather than something nobody noticed.
 */
export const NOT_IN_THE_ARCHIVE: Readonly<Record<string, string>> = {
	attachments:
		'a stored file, not a record: it is reached only through the record that embeds it, has no ' +
		'owner or visibility of its own to scope a listing by, and archived files are on their own ' +
		'clock (`purge_after`) towards physical deletion once backups no longer need them',
	routine_steps:
		'like attachments, it has no household_id, owner or visibility of its own to scope a listing ' +
		'by, and it is reached only through the routine that holds it. `setStepArchived` is reversible ' +
		'at the repository layer the same way every other set*Archived is, but a standalone archive ' +
		'entry for one step -- with its own link to a page that would show a single step in isolation ' +
		'-- is not a page this application has; the routine around it is what the global Archive ' +
		'restores, and re-typing a short step is cheaper than a second recovery mechanism for it alone'
};

/** The table behind each kind, for the test that holds the list above true. */
export const ARCHIVE_TABLES = Object.fromEntries(
	ARCHIVE_KINDS.map((kind) => [kind, SOURCES[kind].table])
) as Readonly<Record<ArchiveKind, string>>;

function scopeFor(sql: Queryable, viewer: Viewer, source: Source, write: boolean): Fragment {
	switch (source.scope) {
		case 'household':
			return householdScope(sql, viewer, 't');
		case 'owner':
			return sql`t.household_id = ${viewer.householdId}::uuid
				and t.owner_user_id = ${viewer.userId}::uuid`;
		case 'visibility':
			return write ? writableScope(sql, viewer, 't') : readableScope(sql, viewer, 't');
	}
}

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
			select ${kind}::text as kind, t.id, (${source.title(sql, viewer)})::text as title,
			       t.archived_at,
			       (${source.path ? source.path(sql, viewer) : sql`null`})::text as path
			from ${sql(source.table)} t
			${source.join ? source.join(sql, viewer) : sql``}
			where ${scopeFor(sql, viewer, source, false)}
			  and t.archived_at is not null
		`;
	});

	let union = branches[0]!;
	for (const branch of branches.slice(1)) union = sql`${union} union all ${branch}`;

	// The search runs over the finished titles rather than inside each branch,
	// so a title assembled from several columns is matched exactly as shown.
	const rows = await sql<
		{
			kind: string;
			id: string;
			title: string;
			archived_at: unknown;
			path: string | null;
		}[]
	>`
		with archived as (${union})
		select * from archived
		${search ? sql`where title ilike ${'%' + search + '%'}` : sql``}
		order by archived_at desc, title asc
		limit ${limit}
	`;

	return rows.map((row) => ({
		kind: row.kind as ArchiveKind,
		id: row.id,
		title: toText(row.title),
		archivedAt: toDate(row.archived_at),
		path: toTextOrNull(row.path)
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
	// `kind` arrives from a form; a prototype key must not pass for a source.
	const source = Object.hasOwn(SOURCES, kind) ? SOURCES[kind] : undefined;
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
