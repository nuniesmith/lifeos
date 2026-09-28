import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	archiveScoped,
	guarded,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toBool,
	toDay,
	toInt,
	toIntOrNull,
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
import {
	optionalInt,
	optionalText,
	patched,
	requiredDay,
	requiredInt,
	requiredText
} from './validate';

/**
 * Perspectives and the year in review (MODEL-002, feature pack 5).
 *
 * The self-ratings and the events worth remembering are stored; everything
 * else the source keeps on its Years and Months databases is derived here from
 * `daily_logs`, `habit_logs`, `goals` and `tasks`. See migration 0015 for why:
 * a stored "Total Days Logged" is a second copy of an answer, and it is wrong
 * the moment a day is edited.
 */

// ─── the wheel of life ─────────────────────────────────────────────────────

export interface LifeAssessment extends RecordBase {
	focus: string;
	areaId: string | null;
	areaName: string | null;
	rating: number;
	period: string | null;
	year: number | null;
	isPriority: boolean;
	notes: string | null;
}

interface AssessmentRow extends BaseRow {
	focus: string;
	area_id: string | null;
	area_name: string | null;
	rating: unknown;
	period: string | null;
	year: unknown;
	is_priority: unknown;
	notes: string | null;
}

const ASSESSMENTS = 'life_assessments';

const mapAssessment = (row: AssessmentRow): LifeAssessment => ({
	...mapBase(row),
	focus: toText(row.focus),
	areaId: row.area_id,
	areaName: toTextOrNull(row.area_name),
	rating: toInt(row.rating),
	period: toTextOrNull(row.period),
	year: toIntOrNull(row.year),
	isPriority: toBool(row.is_priority),
	notes: toTextOrNull(row.notes)
});

/**
 * Columns for `select ... from life_assessments a left join areas ar`, shared
 * by every read so the joined area name cannot drift between `list` and `get`.
 * Bare, unaliased columns for a write's `returning` come from
 * {@link bareAssessmentColumns} instead — a plain `update` has no `ar` to join.
 */
const assessmentSelect = (sql: Queryable): Fragment => sql`
	a.id, a.household_id, a.owner_user_id, a.visibility, a.notion_page_id,
	a.source_record_id, a.created_at, a.updated_at, a.created_by, a.updated_by, a.archived_at,
	a.focus, a.area_id, a.rating, a.period, a.year, a.is_priority, a.notes,
	ar.name as area_name`;

const bareAssessmentColumns = (sql: Queryable): Fragment => sql`
	id, household_id, owner_user_id, visibility, notion_page_id, source_record_id,
	created_at, updated_at, created_by, updated_by, archived_at,
	focus, area_id, rating, period, year, is_priority, notes`;

export interface AssessmentFilters extends PageOptions {
	year?: number;
	period?: string;
	includeArchived?: boolean;
}

/**
 * The wheel, most recent first.
 *
 * Owner-scoped through `readableScope`, which for these means private by
 * default: rating your own health a 3 is a judgement about yourself, and the
 * fact that the area is shared does not make the score shared.
 */
export async function listAssessments(
	sql: Queryable,
	viewer: Viewer,
	filters: AssessmentFilters = {}
): Promise<LifeAssessment[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<AssessmentRow[]>`
		select ${assessmentSelect(sql)}
		from ${sql(ASSESSMENTS)} a
		left join areas ar on ar.id = a.area_id
		where ${readableScope(sql, viewer, 'a')}
		  and ${liveScope(sql, 'a', filters.includeArchived)}
		  ${filters.year ? sql`and a.year = ${filters.year}` : sql``}
		  ${filters.period ? sql`and a.period = ${filters.period}` : sql``}
		order by a.year desc nulls last, a.rating asc, a.focus asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapAssessment);
}

/** One rating by id, or null if it does not exist, is in another household,
 *  or is private to the other member — the caller cannot tell those apart. */
export async function getAssessment(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<LifeAssessment | null> {
	if (!isUuid(id)) return null;
	const rows = await sql<AssessmentRow[]>`
		select ${assessmentSelect(sql)}
		from ${sql(ASSESSMENTS)} a
		left join areas ar on ar.id = a.area_id
		where a.id = ${id}::uuid and ${readableScope(sql, viewer, 'a')}
		limit 1
	`;
	return rows[0] ? mapAssessment(rows[0]) : null;
}

/** The periods on record, newest first, for the page's selector. */
export async function assessmentPeriods(
	sql: Queryable,
	viewer: Viewer
): Promise<{ year: number | null; period: string | null; count: number }[]> {
	const rows = await sql<{ year: unknown; period: string | null; count: number }[]>`
		select year, period, count(*)::int as count
		from ${sql(ASSESSMENTS)} a
		where ${readableScope(sql, viewer, 'a')} and a.archived_at is null
		group by year, period
		order by year desc nulls last, period asc
	`;
	return rows.map((row) => ({
		year: toIntOrNull(row.year),
		period: toTextOrNull(row.period),
		count: toInt(row.count)
	}));
}

export interface AssessmentInput extends OwnershipInput {
	focus?: unknown;
	areaId?: unknown;
	rating?: unknown;
	period?: unknown;
	year?: unknown;
	isPriority?: unknown;
	notes?: unknown;
}

export function createAssessment(
	sql: Queryable,
	viewer: Viewer,
	input: AssessmentInput
): Promise<WriteResult<LifeAssessment>> {
	return guarded<LifeAssessment>(async () => {
		const focus = requiredText(input.focus, 'focus', 200);
		const rating = requiredInt(input.rating, 'rating', { min: 1, max: 10 });
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'private'
		});

		// The area is resolved against the household in SQL, so an id from
		// elsewhere lands as null rather than as a foreign reference.
		const rows = await sql<{ id: string }[]>`
			insert into ${sql(ASSESSMENTS)} (
				household_id, owner_user_id, visibility, focus, area_id, rating, period,
				year, is_priority, notes, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${focus},
				(select ar.id from areas ar
				 where ar.id = ${(input.areaId as string) || null}::uuid
				   and ${readableScope(sql, viewer, 'ar')}),
				${rating}::int, ${optionalText(input.period, 'period')},
				${toIntOrNull(input.year ?? null)}::int,
				${input.isPriority === true || input.isPriority === 'on'}::boolean,
				${optionalText(input.notes, 'notes')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning id
		`;
		const id = rows[0]?.id;
		if (!id) throw new Error('insert returned no row');

		const found = (await listAssessments(sql, viewer, { limit: 500 })).find((a) => a.id === id);
		if (!found) throw new Error('insert returned no readable row');
		return { ok: true, record: found };
	});
}

/**
 * Edits a rating in place.
 *
 * `expectedUpdatedAt` is optional only in the same sense health-measurements.ts's
 * `updateHealthMeasurement` is: the edit sheet always has a row on screen and
 * always sends it, so a stale tab silently overwriting a rating someone else
 * just gave the same focus is refused as a conflict (`base.ts`'s
 * `writeScoped`). Optional in the type, rather than required, because an
 * empty or missing value must become "skip the precondition" — `toDate('')`
 * throws a raw `TypeError` that `guarded` does not catch, so the caller
 * converts an absent field to `undefined` before this ever sees it.
 */
export function updateAssessment(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: AssessmentInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<LifeAssessment>> {
	return guarded<LifeAssessment>(async () => {
		const current = await getAssessment(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			focus: patched(patch, 'focus', current.focus, (v) => requiredText(v, 'focus', 200)),
			rating: patched(patch, 'rating', current.rating, (v) =>
				requiredInt(v, 'rating', { min: 1, max: 10 })
			),
			period: patched(patch, 'period', current.period, (v) => optionalText(v, 'period')),
			year: patched(patch, 'year', current.year, (v) =>
				optionalInt(v, 'year', { min: 1900, max: 2200 })
			),
			isPriority: patched(patch, 'isPriority', current.isPriority, (v) => v === true || v === 'on'),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};
		// Malformed shape is rejected here so a bad id cannot reach `::uuid` and
		// turn into a raw 500 (important-dates.ts's `personId` does the same);
		// whether it is actually readable is checked by the subquery below, in
		// the same statement that writes it. Leaving `areaId` out of the patch
		// keeps the existing link — the `case` is what tells that apart from
		// clearing it.
		const areaGiven = 'areaId' in patch;
		const rawAreaId =
			typeof patch.areaId === 'string' && isUuid(patch.areaId) ? patch.areaId : null;

		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		const result = await writeScoped<AssessmentRow, LifeAssessment>({
			sql,
			table: ASSESSMENTS,
			id,
			readScope: readableScope(sql, viewer, ASSESSMENTS),
			writeScope: writableScope(sql, viewer, ASSESSMENTS),
			expectedUpdatedAt,
			assignments: sql`
				focus = ${next.focus},
				rating = ${next.rating}::int,
				period = ${next.period},
				year = ${next.year}::int,
				is_priority = ${next.isPriority}::boolean,
				notes = ${next.notes},
				area_id = case when ${areaGiven}::boolean then
					(select ar.id from areas ar
					 where ar.id = ${rawAreaId}::uuid and ${readableScope(sql, viewer, 'ar')})
					else area_id end,
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				-- life_assessments carries no before-update trigger (only
				-- households/users/app_settings and the migration 0004 domain
				-- tables do -- checked against every migration), so unlike those,
				-- this column is not maintained for free and must be set here,
				-- the way health-measurements.ts's own update does.
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: bareAssessmentColumns(sql),
			map: mapAssessment,
			mayWrite: writableBy(viewer)
		});
		if (!result.ok) return result;
		// The bare columns above have no room for the joined area name — a plain
		// `update ... returning` has no `ar` to join against — so the accurate
		// record comes from a second, read-side fetch. `createAssessment` takes
		// the same detour through `listAssessments` for the same reason.
		const refreshed = await getAssessment(sql, viewer, result.record.id);
		return refreshed ? { ok: true, record: refreshed } : result;
	});
}

/** "Delete": archived rows leave the wheel and the year in review, and are
 *  recoverable like everything else in LifeOS (`base.ts`'s `archivedAssignment`). */
export const setAssessmentArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<LifeAssessment>> =>
	archiveScoped<AssessmentRow, LifeAssessment>({
		sql,
		table: ASSESSMENTS,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: bareAssessmentColumns(sql),
		map: mapAssessment
	});

export const archiveAssessment = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setAssessmentArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveAssessment = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setAssessmentArchived(sql, viewer, id, false, expectedUpdatedAt);

// ─── significant events ────────────────────────────────────────────────────

export interface SignificantEvent extends RecordBase {
	title: string;
	onDate: string;
	areaId: string | null;
	areaName: string | null;
	isFavourite: boolean;
	notes: string | null;
}

interface EventRow extends BaseRow {
	title: string;
	on_date: string;
	area_id: string | null;
	area_name: string | null;
	is_favourite: unknown;
	notes: string | null;
}

const EVENTS = 'significant_events';

const mapEvent = (row: EventRow): SignificantEvent => ({
	...mapBase(row),
	title: toText(row.title),
	onDate: toDay(row.on_date),
	areaId: row.area_id,
	areaName: toTextOrNull(row.area_name),
	isFavourite: toBool(row.is_favourite),
	notes: toTextOrNull(row.notes)
});

/**
 * Columns for `select ... from significant_events e left join areas ar`,
 * shared by every read so the joined area name cannot drift between `list`
 * and `get`. Bare, unaliased columns for a write's `returning` come from
 * {@link bareEventColumns} instead — a plain `update` has no `ar` to join.
 */
const eventSelect = (sql: Queryable): Fragment => sql`
	e.id, e.household_id, e.owner_user_id, e.visibility, e.notion_page_id,
	e.source_record_id, e.created_at, e.updated_at, e.created_by, e.updated_by, e.archived_at,
	e.title, e.on_date::text as on_date, e.area_id, e.is_favourite, e.notes,
	ar.name as area_name`;

const bareEventColumns = (sql: Queryable): Fragment => sql`
	id, household_id, owner_user_id, visibility, notion_page_id, source_record_id,
	created_at, updated_at, created_by, updated_by, archived_at,
	title, on_date::text as on_date, area_id, is_favourite, notes`;

export async function listEvents(
	sql: Queryable,
	viewer: Viewer,
	filters: { from?: string; to?: string; includeArchived?: boolean } & PageOptions = {}
): Promise<SignificantEvent[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<EventRow[]>`
		select ${eventSelect(sql)}
		from ${sql(EVENTS)} e
		left join areas ar on ar.id = e.area_id
		where ${readableScope(sql, viewer, 'e')}
		  and ${liveScope(sql, 'e', filters.includeArchived)}
		  ${filters.from ? sql`and e.on_date >= ${filters.from}::date` : sql``}
		  ${filters.to ? sql`and e.on_date <= ${filters.to}::date` : sql``}
		order by e.on_date desc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapEvent);
}

/** One event by id, or null if it does not exist, is in another household, or
 *  is private to the other member — the caller cannot tell those apart. */
export async function getEvent(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<SignificantEvent | null> {
	if (!isUuid(id)) return null;
	const rows = await sql<EventRow[]>`
		select ${eventSelect(sql)}
		from ${sql(EVENTS)} e
		left join areas ar on ar.id = e.area_id
		where e.id = ${id}::uuid and ${readableScope(sql, viewer, 'e')}
		limit 1
	`;
	return rows[0] ? mapEvent(rows[0]) : null;
}

export interface EventInput extends OwnershipInput {
	title?: unknown;
	onDate?: unknown;
	areaId?: unknown;
	isFavourite?: unknown;
	notes?: unknown;
}

export function createEvent(
	sql: Queryable,
	viewer: Viewer,
	input: EventInput
): Promise<WriteResult<SignificantEvent>> {
	return guarded<SignificantEvent>(async () => {
		const title = requiredText(input.title, 'title', 300);
		const onDate = String(input.onDate ?? '').trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate)) {
			// An event is a thing that happened on a day; without one there is
			// nothing to place it against.
			return { ok: false, reason: 'invalid', message: 'a date is required' };
		}
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		const rows = await sql<{ id: string }[]>`
			insert into ${sql(EVENTS)} (
				household_id, owner_user_id, visibility, title, on_date, area_id,
				is_favourite, notes, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title},
				${onDate}::date,
				(select ar.id from areas ar
				 where ar.id = ${(input.areaId as string) || null}::uuid
				   and ${readableScope(sql, viewer, 'ar')}),
				${input.isFavourite === true || input.isFavourite === 'on'}::boolean,
				${optionalText(input.notes, 'notes')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning id
		`;
		const id = rows[0]?.id;
		if (!id) throw new Error('insert returned no row');
		const found = (await listEvents(sql, viewer, { limit: 500 })).find((e) => e.id === id);
		if (!found) throw new Error('insert returned no readable row');
		return { ok: true, record: found };
	});
}

/**
 * Edits an event in place.
 *
 * `expectedUpdatedAt` is optional only in the same sense health-measurements.ts's
 * `updateHealthMeasurement` is: the edit sheet always has a row on screen and
 * always sends it, so a stale tab silently overwriting a change someone else
 * just made is refused as a conflict (`base.ts`'s `writeScoped`). Optional in
 * the type, rather than required, because an empty or missing value must
 * become "skip the precondition" — `toDate('')` throws a raw `TypeError` that
 * `guarded` does not catch, so the caller converts an absent field to
 * `undefined` before this ever sees it.
 */
export function updateEvent(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: EventInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<SignificantEvent>> {
	return guarded<SignificantEvent>(async () => {
		const current = await getEvent(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			title: patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 300)),
			onDate: patched(patch, 'onDate', current.onDate, (v) => requiredDay(v, 'date')),
			isFavourite: patched(
				patch,
				'isFavourite',
				current.isFavourite,
				(v) => v === true || v === 'on'
			),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};
		// Malformed shape is rejected here so a bad id cannot reach `::uuid` and
		// turn into a raw 500 (important-dates.ts's `personId` does the same);
		// whether it is actually readable is checked by the subquery below, in
		// the same statement that writes it. Leaving `areaId` out of the patch
		// keeps the existing link — the `case` is what tells that apart from
		// clearing it.
		const areaGiven = 'areaId' in patch;
		const rawAreaId =
			typeof patch.areaId === 'string' && isUuid(patch.areaId) ? patch.areaId : null;

		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		const result = await writeScoped<EventRow, SignificantEvent>({
			sql,
			table: EVENTS,
			id,
			readScope: readableScope(sql, viewer, EVENTS),
			writeScope: writableScope(sql, viewer, EVENTS),
			expectedUpdatedAt,
			assignments: sql`
				title = ${next.title},
				on_date = ${next.onDate}::date,
				is_favourite = ${next.isFavourite}::boolean,
				notes = ${next.notes},
				area_id = case when ${areaGiven}::boolean then
					(select ar.id from areas ar
					 where ar.id = ${rawAreaId}::uuid and ${readableScope(sql, viewer, 'ar')})
					else area_id end,
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				-- significant_events carries no before-update trigger (only
				-- households/users/app_settings and the migration 0004 domain
				-- tables do -- checked against every migration), so unlike those,
				-- this column is not maintained for free and must be set here,
				-- the way health-measurements.ts's own update does.
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: bareEventColumns(sql),
			map: mapEvent,
			mayWrite: writableBy(viewer)
		});
		if (!result.ok) return result;
		// The bare columns above have no room for the joined area name — a plain
		// `update ... returning` has no `ar` to join against — so the accurate
		// record comes from a second, read-side fetch. `createEvent` takes the
		// same detour through `listEvents` for the same reason.
		const refreshed = await getEvent(sql, viewer, result.record.id);
		return refreshed ? { ok: true, record: refreshed } : result;
	});
}

/** "Delete": archived rows leave the list and the year in review's `events`
 *  count, and are recoverable like everything else in LifeOS (`base.ts`'s
 *  `archivedAssignment`). */
export const setEventArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<SignificantEvent>> =>
	archiveScoped<EventRow, SignificantEvent>({
		sql,
		table: EVENTS,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: bareEventColumns(sql),
		map: mapEvent
	});

export const archiveEvent = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setEventArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveEvent = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setEventArchived(sql, viewer, id, false, expectedUpdatedAt);

// ─── the year, computed ────────────────────────────────────────────────────

export interface YearInReview {
	year: number;
	daysLogged: number;
	habitsLogged: number;
	habitConsistency: number | null;
	goalsAchieved: number;
	tasksCompleted: number;
	projectsCompleted: number;
	events: number;
	/** The mood logged on the most days, and how many. */
	dominantMood: { name: string; days: number } | null;
}

/**
 * A year summarised from what is already recorded.
 *
 * Every figure here is a query rather than a stored rollup. The source keeps
 * these as formula columns on a Years row, which means the number is only as
 * fresh as the last time Notion recalculated it; computing them makes "total
 * days logged" true by construction.
 *
 * The personal figures — days logged, habits, mood — are the viewer's own.
 * Goals, tasks and projects are household work and are counted as such.
 */
export async function yearInReview(
	sql: Queryable,
	viewer: Viewer,
	year: number
): Promise<YearInReview> {
	const from = `${year}-01-01`;
	const to = `${year}-12-31`;

	const [totals, mood] = await Promise.all([
		sql<
			{
				days_logged: number;
				habits_logged: number;
				habit_opportunities: number;
				goals_achieved: number;
				tasks_completed: number;
				projects_completed: number;
				events: number;
			}[]
		>`
			select
				(select count(*)::int from daily_logs l
				 where l.household_id = ${viewer.householdId}::uuid
				   and l.owner_user_id = ${viewer.userId}::uuid
				   and l.archived_at is null
				   and l.on_date between ${from}::date and ${to}::date) as days_logged,
				(select count(*)::int from habit_logs hl
				 join habits h on h.id = hl.habit_id
				 where h.household_id = ${viewer.householdId}::uuid
				   and hl.user_id = ${viewer.userId}::uuid
				   and hl.on_date between ${from}::date and ${to}::date) as habits_logged,
				(select count(*)::int from habits h
				 where h.household_id = ${viewer.householdId}::uuid
				   and h.archived_at is null) as habit_opportunities,
				(select count(*)::int from goals g
				 where ${readableScope(sql, viewer, 'g')} and g.status = 'achieved'
				   and g.achieved_on between ${from}::date and ${to}::date) as goals_achieved,
				(select count(*)::int from tasks t
				 where ${readableScope(sql, viewer, 't')} and t.status = 'done'
				   and t.completed_at >= ${from}::date
				   and t.completed_at < (${to}::date + 1)) as tasks_completed,
				(select count(*)::int from projects p
				 where ${readableScope(sql, viewer, 'p')}
				   and p.completed_on between ${from}::date and ${to}::date) as projects_completed,
				(select count(*)::int from ${sql(EVENTS)} e
				 where ${readableScope(sql, viewer, 'e')} and e.archived_at is null
				   and e.on_date between ${from}::date and ${to}::date) as events
		`,
		sql<{ name: string; days: number }[]>`
			select v.name, count(distinct l.on_date)::int as days
			from daily_log_health dh
			join health_vocabulary v on v.id = dh.vocabulary_id
			join daily_logs l on l.id = dh.daily_log_id
			where v.kind = 'mood'
			  and l.household_id = ${viewer.householdId}::uuid
			  and l.owner_user_id = ${viewer.userId}::uuid
			  and l.on_date between ${from}::date and ${to}::date
			group by v.name
			order by days desc, v.name asc
			limit 1
		`
	]);

	const row = totals[0];
	const daysLogged = toInt(row?.days_logged ?? 0);
	const habitsLogged = toInt(row?.habits_logged ?? 0);
	const opportunities = toInt(row?.habit_opportunities ?? 0) * daysLogged;

	return {
		year,
		daysLogged,
		habitsLogged,
		// Only meaningful once there is something to divide by; a year with no
		// habits and no days logged has no consistency, rather than 0%.
		habitConsistency:
			opportunities > 0 ? Math.round((habitsLogged / opportunities) * 1000) / 10 : null,
		goalsAchieved: toInt(row?.goals_achieved ?? 0),
		tasksCompleted: toInt(row?.tasks_completed ?? 0),
		projectsCompleted: toInt(row?.projects_completed ?? 0),
		events: toInt(row?.events ?? 0),
		dominantMood: mood[0] ? { name: toText(mood[0].name), days: toInt(mood[0].days) } : null
	};
}

/** The years there is anything to review, newest first. */
export async function yearsOnRecord(sql: Queryable, viewer: Viewer): Promise<number[]> {
	const rows = await sql<{ year: unknown }[]>`
		select distinct extract(year from on_date)::int as year
		from daily_logs
		where household_id = ${viewer.householdId}::uuid
		  and owner_user_id = ${viewer.userId}::uuid
		union
		select distinct extract(year from e.on_date)::int as year
		from ${sql(EVENTS)} e
		where ${readableScope(sql, viewer, 'e')}
		order by year desc
	`;
	return rows.map((r) => toInt(r.year)).filter((y) => Number.isFinite(y));
}
