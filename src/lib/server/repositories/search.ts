import type { Viewer } from '../auth/authz';
import { householdScope, readableScope, type Queryable } from './base';
import { HEALTH_KINDS } from './health';

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
	'health_measurement',
	// The health records that have a name of their own. A lab *result* is a
	// number on a day and is found through its marker; a dose is not a record
	// anyone would type a word to find.
	'medication',
	'lab_marker',
	'medical_visit',
	// Finance, reading, routines and food, which each arrived after the list
	// above -- and a book, a food or a routine is looked for by name just as a
	// recipe is.
	'income_entry',
	'savings_contribution',
	'book',
	'author',
	'book_series',
	'routine',
	'food'
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
			       '/calendar' as path
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
	// shows it. Habits and recipes have detail routes of their own — a recipe's
	// method is only readable on its page — and the rest go to the list,
	// because that is where the record is actually shown.
	if (wanted('recipe')) {
		branches.push(sql`
			select 'recipe' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.notes,'')
			           || ' ' || coalesce(t.cuisine,'') || ' ' || coalesce(t.occasion,'')) as doc,
			       concat_ws(' ', t.cuisine, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/food/recipes/' || t.id as path
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

	if (wanted('income_entry')) {
		branches.push(sql`
			select 'income_entry' as kind, t.id, t.title,
			       to_tsvector('english', coalesce(t.title,'') || ' ' || coalesce(t.source,'')
			           || ' ' || coalesce(t.type,'') || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.source, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/finance' as path
			from income_entries t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('savings_contribution')) {
		branches.push(sql`
			select 'savings_contribution' as kind, t.id, t.title,
			       to_tsvector('english', coalesce(t.title,'') || ' ' || coalesce(t.notes,'')) as doc,
			       coalesce(t.notes, '') as body,
			       (t.archived_at is not null) as archived,
			       '/finance' as path
			from savings_contributions t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('book')) {
		// Found by its authors' names too: "the new Tana French" is how a book
		// is remembered at least as often as by its title.
		branches.push(sql`
			select 'book' as kind, t.id, t.title,
			       to_tsvector('english', coalesce(t.title,'') || ' ' || coalesce(t.subtitle,'')
			           || ' ' || coalesce((
			               select string_agg(a.name, ' ') from book_authors ba
			               join authors a on a.id = ba.author_id where ba.book_id = t.id
			           ), '')
			           || ' ' || coalesce(t.description,'') || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.subtitle, t.description, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/reading/books/' || t.id as path
			from books t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('author')) {
		// Household-wide reference data with no owner, like tags: the household
		// is the whole scope (see reading.ts).
		branches.push(sql`
			select 'author' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.notes,'')) as doc,
			       coalesce(t.notes, '') as body,
			       (t.archived_at is not null) as archived,
			       '/reading/authors/' || t.id as path
			from authors t
			where ${householdScope(sql, viewer, 't')}
		`);
	}

	if (wanted('book_series')) {
		branches.push(sql`
			select 'book_series' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.notes,'')) as doc,
			       coalesce(t.notes, '') as body,
			       (t.archived_at is not null) as archived,
			       '/reading/series/' || t.id as path
			from book_series t
			where ${householdScope(sql, viewer, 't')}
		`);
	}

	if (wanted('routine')) {
		// Its live steps' titles count as its words: "stretch" should find the
		// morning routine that has a Stretch step.
		branches.push(sql`
			select 'routine' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.notes,'')
			           || ' ' || coalesce((
			               select string_agg(s.title, ' ') from routine_steps s
			               where s.routine_id = t.id and s.archived_at is null
			           ), '')) as doc,
			       coalesce(t.notes, '') as body,
			       (t.archived_at is not null) as archived,
			       '/routines/' || t.id as path
			from routines t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('food')) {
		branches.push(sql`
			select 'food' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.brand,'')
			           || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.brand, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/food/library' as path
			from foods t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('health_term')) {
		// Only the kinds /health still lists. A retired kind (vitamin, now a
		// medication) can survive in the table, and a hit for it would link to a
		// page that no longer shows it.
		branches.push(sql`
			select 'health_term' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.kind, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/health/symptoms' as path
			from health_vocabulary t
			where ${readableScope(sql, viewer, 't')}
			  and t.kind in ${sql([...HEALTH_KINDS])}
		`);
	}

	// Medications, markers and visits scope like any shared record — their own
	// repositories read them through `readableScope` — rather than by author
	// like the journal: they default to household-shared (migrations 0018 and
	// 0020) because a partner helping to manage an illness needs them, and one
	// marked private is excluded by the same predicate as a private task.
	if (wanted('medication')) {
		branches.push(sql`
			select 'medication' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.brand,'')
			           || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.dose, t.unit, t.brand, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/health/medications' as path
			from medications t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('lab_marker')) {
		branches.push(sql`
			select 'lab_marker' as kind, t.id, t.name as title,
			       to_tsvector('english', coalesce(t.name,'') || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.units, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/health/labs/' || t.id as path
			from lab_markers t
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('medical_visit')) {
		// Titled with the day as well as the reason: "Follow up" is most visits'
		// reason, and a list of identical titles is no help. The day is the
		// household's, like everywhere else a visit is shown.
		branches.push(sql`
			select 'medical_visit' as kind, t.id,
			       t.reason || ' — ' || to_char(t.visit_at at time zone h.timezone, 'FMDD Mon YYYY') as title,
			       to_tsvector('english',
			           coalesce(t.reason,'') || ' ' || coalesce(t.visit_type,'') || ' ' ||
			           coalesce(t.provider,'') || ' ' || coalesce(t.location,'') || ' ' ||
			           coalesce(t.family_member,'') || ' ' || coalesce(t.notes,'')) as doc,
			       concat_ws(' ', t.provider, t.location, t.notes) as body,
			       (t.archived_at is not null) as archived,
			       '/health/visits/' || t.id as path
			from medical_visits t
			join households h on h.id = t.household_id
			where ${readableScope(sql, viewer, 't')}
		`);
	}

	if (wanted('daily_log')) {
		// Deliberately owner-scoped, not visibility-scoped. See the header.
		branches.push(sql`
			select 'daily_log' as kind, t.id, to_char(t.on_date, 'FMDay FMDD Mon YYYY') as title,
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
			       'Reading — ' || to_char(t.measured_at at time zone h.timezone, 'FMDay FMDD Mon YYYY') as title,
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
