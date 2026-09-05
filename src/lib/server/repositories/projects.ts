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
	toBool,
	toDayOrNull,
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
	optionalBool,
	optionalDay,
	optionalOneOf,
	optionalText,
	patched,
	requiredText
} from './validate';

/**
 * Projects (MODEL-003).
 *
 * "PROJECT HEALTH" and "Percent Completed" came out of the source as rendered
 * strings and were deliberately not imported. Progress comes from
 * `openTaskCountsByProject` in `tasks.ts` instead, which cannot go stale.
 */

export const PROJECT_STATUSES = ['planned', 'active', 'on_hold', 'done', 'dropped'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface ProjectRecord extends RecordBase {
	name: string;
	description: string | null;
	status: ProjectStatus;
	startOn: string | null;
	dueOn: string | null;
	completedOn: string | null;
	isTemplate: boolean;
}

interface ProjectRow extends BaseRow {
	name: string;
	description: string | null;
	status: string;
	start_on: string | null;
	due_on: string | null;
	completed_on: string | null;
	is_template: unknown;
}

const TABLE = 'projects';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, description, status,
	start_on::text as start_on, due_on::text as due_on, completed_on::text as completed_on,
	is_template`;

function mapProject(row: ProjectRow): ProjectRecord {
	return {
		...mapBase(row),
		name: toText(row.name),
		description: toTextOrNull(row.description),
		status: row.status as ProjectStatus,
		startOn: toDayOrNull(row.start_on),
		dueOn: toDayOrNull(row.due_on),
		completedOn: toDayOrNull(row.completed_on),
		isTemplate: toBool(row.is_template)
	};
}

export interface ProjectFilters extends PageOptions {
	status?: ProjectStatus | ProjectStatus[];
	/** Everything not finished or abandoned. */
	openOnly?: boolean;
	areaId?: string;
	goalId?: string;
	ownerUserId?: string | null;
	search?: string;
	includeArchived?: boolean;
	includeTemplates?: boolean;
	order?: 'due' | 'name' | 'created';
}

const OPEN_PROJECT_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'on_hold'];

function projectConditions(sql: Queryable, viewer: Viewer, filters: ProjectFilters): Fragment {
	const parts: Fragment[] = [
		readableScope(sql, viewer, TABLE),
		liveScope(sql, TABLE, filters.includeArchived)
	];
	if (!filters.includeTemplates) parts.push(sql`is_template = false`);
	if (filters.openOnly) parts.push(sql`status in ${sql([...OPEN_PROJECT_STATUSES])}`);
	if (Array.isArray(filters.status)) {
		if (filters.status.length === 0) return sql`false`;
		parts.push(sql`status in ${sql([...filters.status])}`);
	} else if (filters.status) {
		parts.push(sql`status = ${filters.status}`);
	}
	if (filters.areaId) {
		parts.push(sql`exists (
			select 1 from project_areas pa
			where pa.project_id = projects.id and pa.area_id = ${filters.areaId}::uuid
		)`);
	}
	if (filters.goalId) {
		parts.push(sql`exists (
			select 1 from project_goals pg
			where pg.project_id = projects.id and pg.goal_id = ${filters.goalId}::uuid
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
		parts.push(sql`name ilike ${`%${filters.search.trim()}%`}`);
	}
	return parts.reduce((all, part) => sql`${all} and ${part}`);
}

export async function listProjects(
	sql: Queryable,
	viewer: Viewer,
	filters: ProjectFilters = {}
): Promise<ProjectRecord[]> {
	const { limit, offset } = pageOf(filters);
	const order =
		filters.order === 'name'
			? sql`name asc`
			: filters.order === 'created'
				? sql`created_at desc`
				: sql`due_on asc nulls last, name asc`;
	const rows = await sql<ProjectRow[]>`
		select ${columns(sql)} from projects
		where ${projectConditions(sql, viewer, filters)}
		order by ${order}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapProject);
}

export async function getProject(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<ProjectRecord | null> {
	const row = await getScoped<ProjectRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapProject(row) : null;
}

export interface ProjectInput extends OwnershipInput {
	name?: unknown;
	description?: unknown;
	status?: unknown;
	startOn?: unknown;
	dueOn?: unknown;
	completedOn?: unknown;
	isTemplate?: unknown;
}

export function createProject(
	sql: Queryable,
	viewer: Viewer,
	input: ProjectInput
): Promise<WriteResult<ProjectRecord>> {
	return guarded<ProjectRecord>(async () => {
		const name = requiredText(input.name, 'name', 300);
		const status = optionalOneOf(input.status, 'status', PROJECT_STATUSES) ?? 'active';
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'household'
		});
		const rows = await sql<ProjectRow[]>`
			insert into projects (
				household_id, owner_user_id, visibility, name, description, status,
				start_on, due_on, completed_on, is_template, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${optionalText(input.description, 'description')}, ${status},
				${optionalDay(input.startOn, 'start date')}::date,
				${optionalDay(input.dueOn, 'due date')}::date,
				${optionalDay(input.completedOn, 'completed date')}::date,
				${optionalBool(input.isTemplate, 'template') ?? false}::boolean,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapProject(row) };
	});
}

export function updateProject(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: ProjectInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<ProjectRecord>> {
	return guarded<ProjectRecord>(async () => {
		const current = await getProject(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 300)),
			description: patched(patch, 'description', current.description, (v) =>
				optionalText(v, 'description')
			),
			status: patched(
				patch,
				'status',
				current.status,
				(v) => optionalOneOf(v, 'status', PROJECT_STATUSES) ?? current.status
			),
			startOn: patched(patch, 'startOn', current.startOn, (v) => optionalDay(v, 'start date')),
			dueOn: patched(patch, 'dueOn', current.dueOn, (v) => optionalDay(v, 'due date')),
			completedOn: patched(patch, 'completedOn', current.completedOn, (v) =>
				optionalDay(v, 'completed date')
			),
			isTemplate: patched(
				patch,
				'isTemplate',
				current.isTemplate,
				(v) => optionalBool(v, 'template') ?? false
			)
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<ProjectRow, ProjectRecord>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`
				name = ${next.name},
				description = ${next.description},
				status = ${next.status},
				start_on = ${next.startOn}::date,
				due_on = ${next.dueOn}::date,
				-- Finishing a project dates it; reopening one clears the date,
				-- so "done" and "completed_on" cannot drift apart.
				completed_on = case
					when ${next.status} = 'done'
						then coalesce(${next.completedOn}::date, projects.completed_on, current_date)
					else ${next.completedOn}::date end,
				is_template = ${next.isTemplate}::boolean,
				owner_user_id = ${ownership.ownerUserId}::uuid,
				visibility = ${ownership.visibility},
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapProject,
			mayWrite: writableBy(viewer)
		});
	});
}

export const setProjectArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<ProjectRecord>> =>
	archiveScoped<ProjectRow, ProjectRecord>({
		sql,
		table: TABLE,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: columns(sql),
		map: mapProject
	});

export const archiveProject = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setProjectArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveProject = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setProjectArchived(sql, viewer, id, false, expectedUpdatedAt);
