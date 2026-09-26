import type { Viewer } from '../auth/authz';
import { readableScope, type Queryable } from './base';

/**
 * Household-scoped full-text search (UI-010).
 *
 * Every branch of the union carries the same two filters as the rest of the
 * repository layer: the household is absolute, and a `private` record is
 * visible only to its owner. Search is the easiest place in an application to
 * leak, because it reaches across every table at once and a single missing
 * predicate is invisible in the results — you cannot tell from a result list
 * what was silently included.
 *
 * Daily logs are stricter still. They are filtered to the viewer's own rows
 * rather than by visibility, so a journal entry a person somehow marked
 * `household` is still not surfaced to their partner by a search they did not
 * expect to reach it.
 */

export const SEARCH_KINDS = [
	'task',
	'project',
	'goal',
	'area',
	'important_date',
	'daily_log',
	'library_item',
	// The feature packs. Without these, searching a recipe, a person, a film or
	// a symptom by name returns nothing at all — which in a workspace where
	// those are most of the records makes search look broken rather than empty.
	'recipe',
	'ingredient',
	'person',
	'media_item',
	'habit',
	'wishlist_item',
	'bill',
	'health_term',
	'health_measurement'
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchHit {
	kind: SearchKind;
	id: string;
	title: string;
	/** A short excerpt with the match highlighted by «» markers. */
	excerpt: string | null;
	rank: number;
	archived: boolean;
	/** Where the record lives, for a link. */
	path: string;
}

export interface SearchOptions {
	limit?: number;
	kinds?: readonly SearchKind[];
}

/**
 * Turns what a person typed into a tsquery.
 *
 * `websearch_to_tsquery` is used rather than `plainto_tsquery` because it
 * understands quoted phrases and `-exclusions`, which is what someone typing
 * into a search box already expects. It also never raises on malformed input —
 * `plainto_tsquery` will, and a search box that errors on an unbalanced quote
 * is worse than one that returns nothing.
 */
const MAX_QUERY_LENGTH = 200;

export function isSearchable(term: string): boolean {
	return term.trim().length >= 2;
}

export async function search(
	sql: Queryable,
	viewer: Viewer,
	term: string,
	options: SearchOptions = {}
): Promise<SearchHit[]> {
	const query = term.trim().slice(0, MAX_QUERY_LENGTH);
	if (!isSearchable(query)) return [];

	const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
	const kinds = options.kinds?.length ? options.kinds : SEARCH_KINDS;
	const wanted = (kind: SearchKind) => kinds.includes(kind);

	// Each branch is only built when its kind is wanted, so an unselected kind
	// is not merely filtered out of the results — its rows are never read.
	const branches: ReturnType<Queryable>[] = [];

	if (wanted('task')) {
		branches.push(sql`
			select 'task' as kind, t.id, t.title,
			       to_tsvector('english', coalesce(t.title,'') || ' ' || coalesce(t.notes,'')) as doc,
			       coalesce(t.notes, '') as body,
			       (t.archived_at is not null) as archived,
			       '/tasks/' || t.id as path
			from tasks t
			where ${readableScope(sql, viewer, 't')} and not t.is_template
		`);
	}

	if (wanted('project')) {
		branches.push(sql`
			select 'project' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.description,'')) as doc,
			       coalesce(t.description, '') as body,
			       (t.archived_at is not null) as archived,
			       '/projects/' || t.id as path
			from projects t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('goal')) {
		branches.push(sql`
			select 'goal' as kind, t.id, t.title,
			       to_tsvector('english', coalesce(t.title,'') || ' ' || coalesce(t.description,'')) as doc,
			       coalesce(t.description, '') as body,
			       (t.archived_at is not null) as archived,
			       '/goals/' || t.id as path
			from goals t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('area')) {
		branches.push(sql`
			select 'area' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.description,'')) as doc,
			       coalesce(t.description, '') as body,
			       (t.archived_at is not null) as archived,
			       '/areas/' || t.id as path
			from areas t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('important_date')) {
		branches.push(sql`
			select 'important_date' as kind, t.id, t.title,
			       to_tsvector('english', coalesce(t.title,'') || ' ' || coalesce(t.notes,'')) as doc,
			       coalesce(t.notes, '') as body,
			       (t.archived_at is not null) as archived,
			       '/areas' as path
			from important_dates t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('library_item')) {
		branches.push(sql`
			select 'library_item' as kind, t.id, t.title,
			       to_tsvector('english', coalesce(t.title,'') || ' ' || coalesce(t.author,'')
			           || ' ' || coalesce(t.summary,'')) as doc,
			       concat_ws(' ', t.author, t.summary) as body,
			       (t.archived_at is not null) as archived,
			       '/library/' || t.id as path
			from library_items t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	// Each of these carries a name and some prose, and lands on the page that
	// lists its kind. Only habits have a detail route of their own; the rest go
	// to the list, because that is where the record is actually shown.
	if (wanted('recipe')) {
		branches.push(sql`
			select 'recipe' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.notes,'')
			           || ' ' || coalesce(t.cuisine,'') || ' ' || coalesce(t.occasion,'')) as doc,
			       concat_ws(' ', t.cuisine, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/food' as path
			from recipes t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('ingredient')) {
		branches.push(sql`
			select 'ingredient' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.aisle,'')
			           || ' ' || coalesce(t.category,'') || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.aisle, t.category) as body,
			       (t.archived_at is not null) as archived,
			       '/food' as path
			from ingredients t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('person')) {
		branches.push(sql`
			select 'person' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.kind,'')
			           || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.kind, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/people' as path
			from people t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('media_item')) {
		branches.push(sql`
			select 'media_item' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.genre,'')
			           || ' ' || coalesce(t.why_saved,'')) as doc,
			       concat_ws(' ', t.media_type, t.genre, t.why_saved) as body,
			       (t.archived_at is not null) as archived,
			       '/entertainment' as path
			from media_items t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('habit')) {
		branches.push(sql`
			select 'habit' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.description,'')) as doc,
			       t.description as body,
			       (t.archived_at is not null) as archived,
			       '/habits/' || t.id as path
			from habits t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('wishlist_item')) {
		branches.push(sql`
			select 'wishlist_item' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.purpose,'')
			           || ' ' || coalesce(t.occasion,'') || ' ' || coalesce(t.shop_source,'')) as doc,
			       concat_ws(' ', t.purpose, t.occasion) as body,
			       (t.archived_at is not null) as archived,
			       '/wishlist' as path
			from wishlist_items t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('bill')) {
		branches.push(sql`
			select 'bill' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.category,'')
			           || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.category, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/finance' as path
			from bills t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('health_term')) {
		branches.push(sql`
			select 'health_term' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.kind, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/health/symptoms' as path
			from health_vocabulary t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('daily_log')) {
		// Deliberately owner-scoped, not visibility-scoped. See the header.
		branches.push(sql`
			select 'daily_log' as kind, t.id, to_char(t.on_date, 'FMDay D Mon YYYY') as title,
			       to_tsvector('english',
			           coalesce(t.note,'') || ' ' || coalesce(t.gratitude,'') || ' ' ||
			           coalesce(t.highlight,'') || ' ' || coalesce(t.mood,'')) as doc,
			       concat_ws(' ', t.note, t.gratitude, t.highlight) as body,
			       (t.archived_at is not null) as archived,
			       '/journal/' || to_char(t.on_date, 'YYYY-MM-DD') as path
			from daily_logs t
			where t.household_id = ${viewer.householdId}::uuid
			  and t.owner_user_id = ${viewer.userId}::uuid
		`);
	}

	if (wanted('health_measurement')) {
		// Owner-scoped like daily_log, for the same reason: a reading is a fact
		// about one person's body. There is no title column (migration 0019
		// deliberately stores no derived summary), so the day stands in, exactly
		// as it does for daily_log above.
		branches.push(sql`
			select 'health_measurement' as kind, t.id,
			       'Reading — ' || to_char(t.measured_at at time zone h.timezone, 'FMDay D Mon YYYY') as title,
			       to_tsvector('english',
			           coalesce(t.bp_context,'') || ' ' || coalesce(t.glucose_context,'') || ' ' ||
			           coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.bp_context, t.glucose_context, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/health/measurements' as path
			from health_measurements t
			join households h on h.id = t.household_id
			where t.household_id = ${viewer.householdId}::uuid
			  and t.owner_user_id = ${viewer.userId}::uuid
		`);
	}

	if (branches.length === 0) return [];

	let union = branches[0]!;
	for (const branch of branches.slice(1)) union = sql`${union} union all ${branch}`;

	const rows = await sql<
		{
			kind: string;
			id: string;
			title: string;
			excerpt: string | null;
			rank: number;
			archived: boolean;
			path: string;
		}[]
	>`
		with q as (select websearch_to_tsquery('english', ${query}) as tsq),
		     candidates as (${union})
		select c.kind, c.id, c.title, c.archived, c.path,
		       ts_rank(c.doc, q.tsq) as rank,
		       nullif(
		           ts_headline('english', c.body, q.tsq,
		               'StartSel=«, StopSel=», MaxWords=24, MinWords=8, ShortWord=2, MaxFragments=1'),
		           ''
		       ) as excerpt
		from candidates c, q
		where c.doc @@ q.tsq
		-- Live records first: an archived match is usually context, not the
		-- thing being looked for.
		order by c.archived asc, rank desc, c.title asc
		limit ${limit}
	`;

	return rows.map((r) => ({
		kind: r.kind as SearchKind,
		id: r.id,
		title: r.title,
		excerpt: r.excerpt,
		rank: Number(r.rank),
		archived: Boolean(r.archived),
		path: r.path
	}));
}
