import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	archiveScoped,
	baseColumns,
	getScoped,
	guarded,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toDayOrNull,
	toIntOrNull,
	toNumberOrNull,
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
	optionalDay,
	optionalFraction,
	optionalInt,
	optionalOneOf,
	optionalText,
	patched,
	requiredText
} from './validate';

/**
 * Goals (MODEL-003).
 *
 * `manualProgress` is the one stored progress number in the model, and it is
 * an override rather than a truth: real progress comes from the projects and
 * habits attached to the goal. It exists because some goals have nothing
 * countable underneath them yet.
 */

export const GOAL_STATUSES = [
	'someday',
	'planned',
	'active',
	'paused',
	'achieved',
	'dropped'
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalRecord extends RecordBase {
	title: string;
	description: string | null;
	status: GoalStatus;
	targetDate: string | null;
	achievedOn: string | null;
	manualProgress: number | null;
	/** Days between reviews; null means this goal is not on a review cycle. */
	reviewEveryDays: number | null;
	lastReviewedOn: string | null;
}

interface GoalRow extends BaseRow {
	title: string;
	description: string | null;
	status: string;
	target_date: string | null;
	achieved_on: string | null;
	manual_progress: unknown;
	review_every_days: unknown;
	last_reviewed_on: string | null;
}

const TABLE = 'goals';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	title, description, status,
	target_date::text as target_date, achieved_on::text as achieved_on, manual_progress,
	review_every_days, last_reviewed_on::text as last_reviewed_on`;

function mapGoal(row: GoalRow): GoalRecord {
	return {
		...mapBase(row),
		title: toText(row.title),
		description: toTextOrNull(row.description),
		status: row.status as GoalStatus,
		targetDate: toDayOrNull(row.target_date),
		achievedOn: toDayOrNull(row.achieved_on),
		// numeric arrives as a string so the driver cannot round it.
		manualProgress: toNumberOrNull(row.manual_progress),
		reviewEveryDays: toIntOrNull(row.review_every_days),
		lastReviewedOn: toDayOrNull(row.last_reviewed_on)
	};
}

export interface GoalFilters extends PageOptions {
	status?: GoalStatus | GoalStatus[];
	areaId?: string;
	ownerUserId?: string | null;
	search?: string;
	includeArchived?: boolean;
	order?: 'target' | 'title' | 'created';
}

function goalConditions(sql: Queryable, viewer: Viewer, filters: GoalFilters): Fragment {
	const parts: Fragment[] = [
		readableScope(sql, viewer, TABLE),
		liveScope(sql, TABLE, filters.includeArchived)
	];
	if (Array.isArray(filters.status)) {
		if (filters.status.length === 0) return sql`false`;
		parts.push(sql`status in ${sql([...filters.status])}`);
	} else if (filters.status) {
		parts.push(sql`status = ${filters.status}`);
	}
	if (filters.areaId) {
		parts.push(sql`exists (
			select 1 from goal_areas ga
			where ga.goal_id = goals.id and ga.area_id = ${filters.areaId}::uuid
		)`);
	}
	if (filters.ownerUserId !== undefined) {
		parts.push(
			filters.ownerUserId === null
				? sql`owner_user_id is null`
				: sql`owner_user_id = ${filters.ownerUserId}::uuid`
		);
	}
	if (filters.search?.trim()) {
		parts.push(sql`title ilike ${`%${filters.search.trim()}%`}`);
	}
	return parts.reduce((all, part) => sql`${all} and ${part}`);
}

export async function listGoals(
	sql: Queryable,
	viewer: Viewer,
	filters: GoalFilters = {}
): Promise<GoalRecord[]> {
	const { limit, offset } = pageOf(filters);
	const order =
		filters.order === 'title'
			? sql`title asc`
			: filters.order === 'created'
				? sql`created_at desc`
				: sql`target_date asc nulls last, title asc`;
	const rows = await sql<GoalRow[]>`
		select ${columns(sql)} from goals
		where ${goalConditions(sql, viewer, filters)}
		order by ${order}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapGoal);
}

export async function getGoal(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<GoalRecord | null> {
	const row = await getScoped<GoalRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapGoal(row) : null;
}

export interface GoalInput extends OwnershipInput {
	title?: unknown;
	description?: unknown;
	status?: unknown;
	targetDate?: unknown;
	achievedOn?: unknown;
	manualProgress?: unknown;
	reviewEveryDays?: unknown;
	lastReviewedOn?: unknown;
}

export function createGoal(
	sql: Queryable,
	viewer: Viewer,
	input: GoalInput
): Promise<WriteResult<GoalRecord>> {
	return guarded<GoalRecord>(async () => {
		const title = requiredText(input.title, 'title', 300);
		const status = optionalOneOf(input.status, 'status', GOAL_STATUSES) ?? 'active';
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'household'
		});
		const rows = await sql<GoalRow[]>`
			insert into goals (
				household_id, owner_user_id, visibility, title, description, status,
				target_date, achieved_on, manual_progress, review_every_days,
				last_reviewed_on, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title},
				${optionalText(input.description, 'description')}, ${status},
				${optionalDay(input.targetDate, 'target date')}::date,
				${optionalDay(input.achievedOn, 'achieved on')}::date,
				${optionalFraction(input.manualProgress, 'progress')}::numeric,
				${optionalInt(input.reviewEveryDays, 'review every', { min: 1 })}::int,
				${optionalDay(input.lastReviewedOn, 'last reviewed')}::date,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapGoal(row) };
	});
}

export function updateGoal(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: GoalInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<GoalRecord>> {
	return guarded<GoalRecord>(async () => {
		const current = await getGoal(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			title: patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 300)),
			description: patched(patch, 'description', current.description, (v) =>
				optionalText(v, 'description')
			),
			status: patched(
				patch,
				'status',
				current.status,
				(v) => optionalOneOf(v, 'status', GOAL_STATUSES) ?? current.status
			),
			targetDate: patched(patch, 'targetDate', current.targetDate, (v) =>
				optionalDay(v, 'target date')
			),
			achievedOn: patched(patch, 'achievedOn', current.achievedOn, (v) =>
				optionalDay(v, 'achieved on')
			),
			manualProgress: patched(patch, 'manualProgress', current.manualProgress, (v) =>
				optionalFraction(v, 'progress')
			),
			reviewEveryDays: patched(patch, 'reviewEveryDays', current.reviewEveryDays, (v) =>
				optionalInt(v, 'review every', { min: 1 })
			),
			lastReviewedOn: patched(patch, 'lastReviewedOn', current.lastReviewedOn, (v) =>
				optionalDay(v, 'last reviewed')
			)
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<GoalRow, GoalRecord>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`
				title = ${next.title},
				description = ${next.description},
				status = ${next.status},
				target_date = ${next.targetDate}::date,
				achieved_on = case
					when ${next.status} = 'achieved'
						then coalesce(${next.achievedOn}::date, goals.achieved_on, current_date)
					else ${next.achievedOn}::date end,
				manual_progress = ${next.manualProgress}::numeric,
				review_every_days = ${next.reviewEveryDays}::int,
				last_reviewed_on = ${next.lastReviewedOn}::date,
				owner_user_id = ${ownership.ownerUserId}::uuid,
				visibility = ${ownership.visibility},
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapGoal,
			mayWrite: writableBy(viewer)
		});
	});
}

export const setGoalArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<GoalRecord>> =>
	archiveScoped<GoalRow, GoalRecord>({
		sql,
		table: TABLE,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: columns(sql),
		map: mapGoal
	});

export const archiveGoal = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setGoalArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveGoal = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setGoalArchived(sql, viewer, id, false, expectedUpdatedAt);
