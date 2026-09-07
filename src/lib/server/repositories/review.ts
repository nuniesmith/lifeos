import type { Viewer } from '../auth/authz';
import {
	isUuid,
	readableScope,
	toDay,
	toDayOrNull,
	toInt,
	toText,
	writableScope,
	type Queryable,
	type WriteResult
} from './base';

/**
 * For Review (UI: the review page).
 *
 * Areas, goals and projects each carry a cadence — `review_every_days` — and
 * the date they were last looked at. The source workspace derives "Review
 * overdue · Aug 30" and "Next review · Nov 13" from exactly that pair, so the
 * same two columns answer both questions here.
 *
 * A record that has a cadence but has never been reviewed is due today rather
 * than never: the cadence is the statement that it should be looked at, and
 * having never done so is the strongest case for doing it now.
 */

export const REVIEW_KINDS = ['area', 'goal', 'project'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export interface ReviewItem {
	kind: ReviewKind;
	id: string;
	title: string;
	path: string;
	reviewEveryDays: number;
	lastReviewedOn: string | null;
	/** When this next falls due, in the household's own calendar. */
	dueOn: string;
	/** Positive when overdue, negative when still ahead, 0 when due today. */
	overdueDays: number;
}

/** The table each kind lives in, and how to link to it. */
const SOURCES: Record<ReviewKind, { table: string; titleColumn: string; path: string }> = {
	area: { table: 'areas', titleColumn: 'name', path: '/areas/' },
	goal: { table: 'goals', titleColumn: 'title', path: '/goals/' },
	project: { table: 'projects', titleColumn: 'name', path: '/projects/' }
};

export interface ReviewOptions {
	/** Include records whose next review has not arrived yet. */
	includeUpcoming?: boolean;
	kinds?: readonly ReviewKind[];
	limit?: number;
}

/**
 * Everything on a review cycle, soonest-due first.
 *
 * `today` is the household's own calendar day (see `householdToday`), not the
 * server's: whether a review is overdue is a question about a wall clock.
 */
export async function reviewQueue(
	sql: Queryable,
	viewer: Viewer,
	today: string,
	options: ReviewOptions = {}
): Promise<ReviewItem[]> {
	const kinds = options.kinds?.length ? options.kinds : REVIEW_KINDS;
	const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);

	const branches = kinds.map((kind) => {
		const { table, titleColumn, path } = SOURCES[kind];
		return sql`
			select ${kind}::text as kind, t.id, t.${sql(titleColumn)} as title,
			       ${path}::text || t.id::text as path,
			       t.review_every_days,
			       t.last_reviewed_on::text as last_reviewed_on,
			       (case
			            when t.last_reviewed_on is null then ${today}::date
			            else t.last_reviewed_on + t.review_every_days
			        end)::text as due_on
			from ${sql(table)} t
			where ${readableScope(sql, viewer, 't')}
			  and t.archived_at is null
			  and t.review_every_days is not null
		`;
	});

	let union = branches[0]!;
	for (const branch of branches.slice(1)) union = sql`${union} union all ${branch}`;

	const rows = await sql<
		{
			kind: string;
			id: string;
			title: string;
			path: string;
			review_every_days: number;
			last_reviewed_on: string | null;
			due_on: string;
			overdue_days: number;
		}[]
	>`
		with queue as (${union})
		select q.*, (${today}::date - q.due_on::date) as overdue_days
		from queue q
		where ${options.includeUpcoming ? sql`true` : sql`q.due_on::date <= ${today}::date`}
		order by q.due_on asc, q.title asc
		limit ${limit}
	`;

	return rows.map((row) => ({
		kind: row.kind as ReviewKind,
		id: row.id,
		title: toText(row.title),
		path: toText(row.path),
		reviewEveryDays: toInt(row.review_every_days),
		lastReviewedOn: toDayOrNull(row.last_reviewed_on),
		dueOn: toDay(row.due_on),
		overdueDays: toInt(row.overdue_days)
	}));
}

/**
 * Records the fact that something was reviewed, which is what moves it out of
 * the queue and sets the next date.
 *
 * The scope is in the UPDATE, so a record the viewer may not write is not
 * merely hidden from the list — it cannot be marked from a forged post either.
 */
export async function markReviewed(
	sql: Queryable,
	viewer: Viewer,
	kind: ReviewKind,
	id: string,
	on: string
): Promise<WriteResult<{ id: string; lastReviewedOn: string }>> {
	if (!isUuid(id)) return { ok: false, reason: 'not_found' };
	const source = SOURCES[kind];
	if (!source) return { ok: false, reason: 'invalid', message: 'unknown review kind' };

	const rows = await sql<{ id: string; last_reviewed_on: string }[]>`
		update ${sql(source.table)} t
		set last_reviewed_on = ${on}::date,
		    updated_at = now(),
		    updated_by = ${viewer.userId}::uuid
		where t.id = ${id}::uuid and ${writableScope(sql, viewer, 't')}
		returning t.id, t.last_reviewed_on::text as last_reviewed_on
	`;

	const row = rows[0];
	if (!row) return { ok: false, reason: 'not_found' };
	return { ok: true, record: { id: row.id, lastReviewedOn: toDay(row.last_reviewed_on) } };
}

export interface UnsupportedGoal {
	id: string;
	title: string;
	status: string;
}

/**
 * Goals with nothing attached to them.
 *
 * The source workspace shows this as "⚠ Needs setup · No projects, tasks, or
 * habits linked" on the goal card, and it is the most useful thing on a review
 * page: a goal with no project and no habit is a wish, and the review is
 * exactly the moment to notice.
 *
 * Tasks are not consulted because a task links to a project or an area here,
 * never straight to a goal — so a goal's support is its projects and habits.
 */
export async function goalsNeedingSetup(
	sql: Queryable,
	viewer: Viewer,
	limit = 50
): Promise<UnsupportedGoal[]> {
	const rows = await sql<{ id: string; title: string; status: string }[]>`
		select g.id, g.title, g.status
		from goals g
		where ${readableScope(sql, viewer, 'g')}
		  and g.archived_at is null
		  and g.status not in ('achieved', 'dropped')
		  and not exists (select 1 from project_goals pg where pg.goal_id = g.id)
		  and not exists (select 1 from goal_habits gh where gh.goal_id = g.id)
		order by g.title asc
		limit ${limit}
	`;
	return rows.map((row) => ({ id: row.id, title: toText(row.title), status: toText(row.status) }));
}
