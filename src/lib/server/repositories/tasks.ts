import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDateOrNull } from '../db/coerce';
import {
	InvalidInput,
	archivedAssignment,
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
	toDayOrNull,
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
import { weekWindow, type WeekStart } from './dates';
import {
	optionalBool,
	optionalDay,
	optionalId,
	optionalInt,
	optionalOneOf,
	optionalText,
	patched,
	requiredText
} from './validate';

/**
 * Tasks (MODEL-003).
 *
 * The derived views live here rather than in the route that renders them:
 * Home, the project page, reports and the export must all agree on what
 * "overdue" means, and they can only do that if there is one definition. The
 * source workspace stored "Past Deadline?" as a formula column; this asks the
 * question instead.
 */

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'dropped'] as const;
export const TASK_KINDS = ['task', 'milestone'] as const;
export const TASK_ENERGY = ['low', 'medium', 'high'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskEnergy = (typeof TASK_ENERGY)[number];

/** Statuses that still need doing. Matches the import's derived replacements. */
export const OPEN_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked'];

export interface TaskRecord extends RecordBase {
	title: string;
	notes: string | null;
	kind: TaskKind;
	status: TaskStatus;
	projectId: string | null;
	areaId: string | null;
	parentTaskId: string | null;
	doOn: string | null;
	deadlineOn: string | null;
	completedAt: Date | null;
	isImportant: boolean;
	isUrgent: boolean;
	energy: TaskEnergy | null;
	context: string | null;
	recurrenceRule: string | null;
	recurrenceEvery: number | null;
	nextDueOn: string | null;
	lastCompletedOn: string | null;
	isTemplate: boolean;
	sortOrder: number;
}

interface TaskRow extends BaseRow {
	title: string;
	notes: string | null;
	kind: string;
	status: string;
	project_id: string | null;
	area_id: string | null;
	parent_task_id: string | null;
	do_on: string | null;
	deadline_on: string | null;
	completed_at: unknown;
	is_important: unknown;
	is_urgent: unknown;
	energy: string | null;
	context: string | null;
	recurrence_rule: string | null;
	recurrence_every: unknown;
	next_due_on: string | null;
	last_completed_on: string | null;
	is_template: unknown;
	sort_order: unknown;
}

const TABLE = 'tasks';

/** `date` columns are selected as text; see the note in `base.ts`. */
const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	title, notes, kind, status, project_id, area_id, parent_task_id,
	do_on::text as do_on, deadline_on::text as deadline_on, completed_at,
	is_important, is_urgent, energy, context,
	recurrence_rule, recurrence_every,
	next_due_on::text as next_due_on, last_completed_on::text as last_completed_on,
	is_template, sort_order`;

function mapTask(row: TaskRow): TaskRecord {
	return {
		...mapBase(row),
		title: toText(row.title),
		notes: toTextOrNull(row.notes),
		kind: row.kind as TaskKind,
		status: row.status as TaskStatus,
		projectId: row.project_id,
		areaId: row.area_id,
		parentTaskId: row.parent_task_id,
		doOn: toDayOrNull(row.do_on),
		deadlineOn: toDayOrNull(row.deadline_on),
		completedAt: toDateOrNull(row.completed_at),
		isImportant: toBool(row.is_important),
		isUrgent: toBool(row.is_urgent),
		energy: row.energy as TaskEnergy | null,
		context: toTextOrNull(row.context),
		recurrenceRule: toTextOrNull(row.recurrence_rule),
		recurrenceEvery: toIntOrNull(row.recurrence_every),
		nextDueOn: toDayOrNull(row.next_due_on),
		lastCompletedOn: toDayOrNull(row.last_completed_on),
		isTemplate: toBool(row.is_template),
		sortOrder: toInt(row.sort_order)
	};
}

// ─── reads ─────────────────────────────────────────────────────────────────

export interface TaskFilters extends PageOptions {
	/** `'open'` is the common case: everything still to do. */
	status?: TaskStatus | TaskStatus[] | 'open';
	kind?: TaskKind;
	/** `null` selects tasks with no project; omit for any. */
	projectId?: string | null;
	areaId?: string | null;
	parentTaskId?: string | null;
	ownerUserId?: string | null;
	isImportant?: boolean;
	isUrgent?: boolean;
	tagId?: string;
	search?: string;
	dueFrom?: string;
	dueTo?: string;
	/** Include a task when either its do date or deadline falls in this window. */
	scheduledFrom?: string;
	scheduledTo?: string;
	includeArchived?: boolean;
	/** Templates are hidden by default; they are stencils, not work. */
	includeTemplates?: boolean;
	order?: 'due' | 'created' | 'title' | 'manual';
}

/** Escapes a user's search text so `%` and `_` are literals, not wildcards. */
const likePattern = (search: string): string =>
	`%${search.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

function taskConditions(sql: Queryable, viewer: Viewer, filters: TaskFilters): Fragment {
	const parts: Fragment[] = [
		readableScope(sql, viewer, TABLE),
		liveScope(sql, TABLE, filters.includeArchived)
	];

	if (!filters.includeTemplates) parts.push(sql`is_template = false`);

	if (filters.status === 'open') {
		parts.push(sql`status in ${sql([...OPEN_STATUSES])}`);
	} else if (Array.isArray(filters.status)) {
		if (filters.status.length === 0) return sql`false`;
		parts.push(sql`status in ${sql([...filters.status])}`);
	} else if (filters.status) {
		parts.push(sql`status = ${filters.status}`);
	}

	if (filters.kind) parts.push(sql`kind = ${filters.kind}`);

	if (filters.projectId !== undefined) {
		parts.push(
			filters.projectId === null
				? sql`project_id is null`
				: sql`project_id = ${filters.projectId}::uuid`
		);
	}
	if (filters.areaId !== undefined) {
		parts.push(
			filters.areaId === null ? sql`area_id is null` : sql`area_id = ${filters.areaId}::uuid`
		);
	}
	if (filters.parentTaskId !== undefined) {
		parts.push(
			filters.parentTaskId === null
				? sql`parent_task_id is null`
				: sql`parent_task_id = ${filters.parentTaskId}::uuid`
		);
	}
	if (filters.ownerUserId !== undefined) {
		parts.push(
			filters.ownerUserId === null
				? sql`owner_user_id is null`
				: sql`owner_user_id = ${filters.ownerUserId}::uuid`
		);
	}
	if (filters.isImportant !== undefined) {
		parts.push(sql`is_important = ${filters.isImportant}::boolean`);
	}
	if (filters.isUrgent !== undefined) parts.push(sql`is_urgent = ${filters.isUrgent}::boolean`);

	if (filters.tagId) {
		parts.push(sql`exists (
			select 1 from entity_tags et
			where et.tag_id = ${filters.tagId}::uuid
			  and et.entity_type = 'task' and et.entity_id = tasks.id
		)`);
	}

	if (filters.search?.trim()) {
		const pattern = likePattern(filters.search);
		parts.push(sql`(title ilike ${pattern} or notes ilike ${pattern})`);
	}

	// The task's due date is the earliest of its do date and its deadline;
	// `least` skips nulls, so a task with only one of the two still sorts.
	if (filters.dueFrom) parts.push(sql`least(do_on, deadline_on) >= ${filters.dueFrom}::date`);
	if (filters.dueTo) parts.push(sql`least(do_on, deadline_on) <= ${filters.dueTo}::date`);

	// A calendar renders both dates, so its range cannot use the task's single
	// effective due date. A task started last month with a deadline this month
	// still belongs on this month's deadline square.
	if (filters.scheduledFrom && filters.scheduledTo) {
		parts.push(sql`(
			(do_on between ${filters.scheduledFrom}::date and ${filters.scheduledTo}::date)
			or (deadline_on between ${filters.scheduledFrom}::date and ${filters.scheduledTo}::date)
		)`);
	} else if (filters.scheduledFrom) {
		parts.push(
			sql`(do_on >= ${filters.scheduledFrom}::date or deadline_on >= ${filters.scheduledFrom}::date)`
		);
	} else if (filters.scheduledTo) {
		parts.push(
			sql`(do_on <= ${filters.scheduledTo}::date or deadline_on <= ${filters.scheduledTo}::date)`
		);
	}

	return parts.reduce((all, part) => sql`${all} and ${part}`);
}

function taskOrder(sql: Queryable, order: TaskFilters['order']): Fragment {
	switch (order) {
		case 'title':
			return sql`title asc, created_at asc`;
		case 'created':
			return sql`created_at desc`;
		case 'manual':
			return sql`sort_order asc, created_at asc`;
		default:
			// Undated tasks last, rather than first as a nulls-default would put
			// them: a task with no date is not the most urgent thing on the list.
			return sql`least(do_on, deadline_on) asc nulls last, sort_order asc, created_at asc`;
	}
}

export async function listTasks(
	sql: Queryable,
	viewer: Viewer,
	filters: TaskFilters = {}
): Promise<TaskRecord[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<TaskRow[]>`
		select ${columns(sql)} from tasks
		where ${taskConditions(sql, viewer, filters)}
		order by ${taskOrder(sql, filters.order)}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapTask);
}

export async function countTasks(
	sql: Queryable,
	viewer: Viewer,
	filters: TaskFilters = {}
): Promise<number> {
	const rows = await sql<{ count: number }[]>`
		select count(*)::int as count from tasks
		where ${taskConditions(sql, viewer, filters)}
	`;
	return toInt(rows[0]?.count ?? 0);
}

export async function getTask(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<TaskRecord | null> {
	const row = await getScoped<TaskRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapTask(row) : null;
}

// ─── derived views ─────────────────────────────────────────────────────────

export interface AgendaOptions {
	/** Defaults to today in the household's timezone. */
	today: string;
	weekStartsOn?: WeekStart;
	/** `'me'` also includes unowned household tasks, which are everyone's. */
	assignee?: 'me' | 'anyone';
}

/**
 * The three buckets Home is built from, in one query.
 *
 * They are disjoint on purpose: `dueToday` is not repeated inside
 * `dueThisWeek`, and an overdue task appears only under `overdue` even though
 * its date falls inside the current week. Concatenating the three gives
 * "everything to look at this week" without deduplicating.
 */
export interface Agenda {
	today: string;
	week: { start: string; end: string };
	overdue: TaskRecord[];
	dueToday: TaskRecord[];
	dueThisWeek: TaskRecord[];
}

export async function agenda(
	sql: Queryable,
	viewer: Viewer,
	options: AgendaOptions
): Promise<Agenda> {
	const today = options.today;
	const week = weekWindow(today, options.weekStartsOn ?? 1);
	const assignee =
		(options.assignee ?? 'me') === 'me'
			? sql`(owner_user_id is null or owner_user_id = ${viewer.userId}::uuid)`
			: sql`true`;

	const rows = await sql<(TaskRow & { bucket: string })[]>`
		select ${columns(sql)},
		       case when least(do_on, deadline_on) < ${today}::date then 'overdue'
		            when least(do_on, deadline_on) = ${today}::date then 'today'
		            else 'week' end as bucket
		from tasks
		where ${readableScope(sql, viewer, TABLE)}
		  and archived_at is null
		  and is_template = false
		  and status in ${sql([...OPEN_STATUSES])}
		  and ${assignee}
		  and least(do_on, deadline_on) is not null
		  and least(do_on, deadline_on) <= ${week.end}::date
		order by least(do_on, deadline_on) asc, sort_order asc, created_at asc
	`;

	const agendaResult: Agenda = { today, week, overdue: [], dueToday: [], dueThisWeek: [] };
	for (const row of rows) {
		const task = mapTask(row);
		if (row.bucket === 'overdue') agendaResult.overdue.push(task);
		else if (row.bucket === 'today') agendaResult.dueToday.push(task);
		else agendaResult.dueThisWeek.push(task);
	}
	return agendaResult;
}

export interface OpenTaskCount {
	id: string;
	openCount: number;
	totalCount: number;
	overdueCount: number;
}

/**
 * Open task counts per project, including projects with none.
 *
 * Both sides are scoped: a task the viewer may not read is not counted, and a
 * project the viewer may not read does not appear. Counting first and
 * filtering afterwards would let a private task raise a visible number, which
 * discloses its existence.
 */
export function openTaskCountsByProject(
	sql: Queryable,
	viewer: Viewer,
	options: { today?: string } = {}
): Promise<OpenTaskCount[]> {
	return groupedOpenCounts(sql, viewer, 'projects', 'project_id', options.today);
}

/**
 * Open task counts per area, counting only tasks that point at the area
 * directly.
 *
 * Whether a task should also count towards the area of its project is a
 * question the source workspace answered with an unexported filter (DISC-004),
 * so the strict reading is used and named rather than guessed at.
 */
export function openTaskCountsByArea(
	sql: Queryable,
	viewer: Viewer,
	options: { today?: string } = {}
): Promise<OpenTaskCount[]> {
	return groupedOpenCounts(sql, viewer, 'areas', 'area_id', options.today);
}

async function groupedOpenCounts(
	sql: Queryable,
	viewer: Viewer,
	parentTable: 'projects' | 'areas',
	column: 'project_id' | 'area_id',
	today: string | undefined
): Promise<OpenTaskCount[]> {
	const rows = await sql<
		{ id: string; open_count: number; total_count: number; overdue_count: number }[]
	>`
		select p.id,
		       count(t.id) filter (where t.status in ${sql([...OPEN_STATUSES])})::int
		           as open_count,
		       count(t.id)::int as total_count,
		       count(t.id) filter (
		           where t.status in ${sql([...OPEN_STATUSES])}
		             and ${today ? sql`least(t.do_on, t.deadline_on) < ${today}::date` : sql`false`}
		       )::int as overdue_count
		from ${sql(parentTable)} p
		left join tasks t
		       on t.${sql(column)} = p.id
		      and t.archived_at is null
		      and t.is_template = false
		      and ${readableScope(sql, viewer, 't')}
		where ${readableScope(sql, viewer, 'p')} and p.archived_at is null
		group by p.id
	`;
	return rows.map((r) => ({
		id: r.id,
		openCount: toInt(r.open_count),
		totalCount: toInt(r.total_count),
		overdueCount: toInt(r.overdue_count)
	}));
}

// ─── writes ────────────────────────────────────────────────────────────────

export interface TaskInput extends OwnershipInput {
	title?: unknown;
	notes?: unknown;
	kind?: unknown;
	status?: unknown;
	projectId?: unknown;
	areaId?: unknown;
	parentTaskId?: unknown;
	doOn?: unknown;
	deadlineOn?: unknown;
	isImportant?: unknown;
	isUrgent?: unknown;
	energy?: unknown;
	context?: unknown;
	recurrenceRule?: unknown;
	recurrenceEvery?: unknown;
	nextDueOn?: unknown;
	lastCompletedOn?: unknown;
	isTemplate?: unknown;
	sortOrder?: unknown;
}

/**
 * Checks a link before it is written.
 *
 * Scoped by *readable*, not writable: attaching a task to the household
 * project your partner owns is ordinary, while pointing at a record in another
 * household — or at one you cannot see — is refused here rather than becoming
 * a foreign key violation, which would abort a caller's transaction.
 */
async function checkLink(
	sql: Queryable,
	viewer: Viewer,
	table: 'projects' | 'areas' | 'tasks',
	id: string | null,
	label: string
): Promise<void> {
	if (id === null) return;
	if (!isUuid(id)) throw new InvalidInput(`${label} is not a valid id`);
	const found = await getScoped<{ id: string }>(
		sql,
		table,
		id,
		readableScope(sql, viewer, table),
		sql`id`
	);
	if (!found) throw new InvalidInput(`${label} was not found`);
}

/**
 * Refuses a parent that would close a loop.
 *
 * The table's own constraint only stops a task being its own parent; a longer
 * cycle needs the whole chain, which is what this walks. Without it a cycle
 * makes every recursive read of the hierarchy hang.
 */
async function checkNoCycle(sql: Queryable, taskId: string, parentId: string): Promise<void> {
	if (taskId === parentId) throw new InvalidInput('a task cannot be its own parent');
	const rows = await sql<{ id: string }[]>`
		with recursive chain as (
			select id, parent_task_id from tasks where id = ${parentId}::uuid
			union all
			select t.id, t.parent_task_id
			from tasks t join chain c on t.id = c.parent_task_id
		)
		select id from chain where id = ${taskId}::uuid limit 1
	`;
	if (rows.length > 0) throw new InvalidInput('that parent would create a loop of tasks');
}

export function createTask(
	sql: Queryable,
	viewer: Viewer,
	input: TaskInput
): Promise<WriteResult<TaskRecord>> {
	return guarded<TaskRecord>(async () => {
		const title = requiredText(input.title, 'title', 500);
		const status = optionalOneOf(input.status, 'status', TASK_STATUSES) ?? 'todo';
		const kind = optionalOneOf(input.kind, 'kind', TASK_KINDS) ?? 'task';
		const projectId = optionalId(input.projectId, 'project');
		const areaId = optionalId(input.areaId, 'area');
		const parentTaskId = optionalId(input.parentTaskId, 'parent task');
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'household'
		});

		await checkLink(sql, viewer, 'projects', projectId, 'project');
		await checkLink(sql, viewer, 'areas', areaId, 'area');
		await checkLink(sql, viewer, 'tasks', parentTaskId, 'parent task');

		const rows = await sql<TaskRow[]>`
			insert into tasks (
				household_id, owner_user_id, visibility, title, notes, kind, status,
				project_id, area_id, parent_task_id, do_on, deadline_on, completed_at,
				is_important, is_urgent, energy, context, recurrence_rule, recurrence_every,
				next_due_on, last_completed_on, is_template, sort_order, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility},
				${title}, ${optionalText(input.notes, 'notes')}, ${kind}, ${status},
				${projectId}::uuid, ${areaId}::uuid, ${parentTaskId}::uuid,
				${optionalDay(input.doOn, 'do date')}::date,
				${optionalDay(input.deadlineOn, 'deadline')}::date,
				${status === 'done' ? sql`now()` : sql`null::timestamptz`},
				${optionalBool(input.isImportant, 'important') ?? false}::boolean,
				${optionalBool(input.isUrgent, 'urgent') ?? false}::boolean,
				${optionalOneOf(input.energy, 'energy', TASK_ENERGY)},
				${optionalText(input.context, 'context', 200)},
				${optionalText(input.recurrenceRule, 'recurrence rule', 500)},
				${optionalInt(input.recurrenceEvery, 'repeat every', { min: 1 })}::int,
				${optionalDay(input.nextDueOn, 'next due')}::date,
				${optionalDay(input.lastCompletedOn, 'last completed')}::date,
				${optionalBool(input.isTemplate, 'template') ?? false}::boolean,
				${optionalInt(input.sortOrder, 'sort order') ?? 0}::int,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapTask(row) };
	});
}

export function updateTask(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: TaskInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<TaskRecord>> {
	return guarded<TaskRecord>(async () => {
		const current = await getTask(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			title: patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 500)),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes')),
			kind: patched(
				patch,
				'kind',
				current.kind,
				(v) => optionalOneOf(v, 'kind', TASK_KINDS) ?? current.kind
			),
			status: patched(
				patch,
				'status',
				current.status,
				(v) => optionalOneOf(v, 'status', TASK_STATUSES) ?? current.status
			),
			projectId: patched(patch, 'projectId', current.projectId, (v) => optionalId(v, 'project')),
			areaId: patched(patch, 'areaId', current.areaId, (v) => optionalId(v, 'area')),
			parentTaskId: patched(patch, 'parentTaskId', current.parentTaskId, (v) =>
				optionalId(v, 'parent task')
			),
			doOn: patched(patch, 'doOn', current.doOn, (v) => optionalDay(v, 'do date')),
			deadlineOn: patched(patch, 'deadlineOn', current.deadlineOn, (v) =>
				optionalDay(v, 'deadline')
			),
			isImportant: patched(
				patch,
				'isImportant',
				current.isImportant,
				(v) => optionalBool(v, 'important') ?? false
			),
			isUrgent: patched(
				patch,
				'isUrgent',
				current.isUrgent,
				(v) => optionalBool(v, 'urgent') ?? false
			),
			energy: patched(patch, 'energy', current.energy, (v) =>
				optionalOneOf(v, 'energy', TASK_ENERGY)
			),
			context: patched(patch, 'context', current.context, (v) => optionalText(v, 'context', 200)),
			recurrenceRule: patched(patch, 'recurrenceRule', current.recurrenceRule, (v) =>
				optionalText(v, 'recurrence rule', 500)
			),
			recurrenceEvery: patched(patch, 'recurrenceEvery', current.recurrenceEvery, (v) =>
				optionalInt(v, 'repeat every', { min: 1 })
			),
			nextDueOn: patched(patch, 'nextDueOn', current.nextDueOn, (v) => optionalDay(v, 'next due')),
			lastCompletedOn: patched(patch, 'lastCompletedOn', current.lastCompletedOn, (v) =>
				optionalDay(v, 'last completed')
			),
			isTemplate: patched(
				patch,
				'isTemplate',
				current.isTemplate,
				(v) => optionalBool(v, 'template') ?? false
			),
			sortOrder: patched(
				patch,
				'sortOrder',
				current.sortOrder,
				(v) => optionalInt(v, 'sort order') ?? 0
			)
		};

		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		if (next.projectId !== current.projectId) {
			await checkLink(sql, viewer, 'projects', next.projectId, 'project');
		}
		if (next.areaId !== current.areaId) {
			await checkLink(sql, viewer, 'areas', next.areaId, 'area');
		}
		if (next.parentTaskId !== current.parentTaskId && next.parentTaskId !== null) {
			await checkLink(sql, viewer, 'tasks', next.parentTaskId, 'parent task');
			await checkNoCycle(sql, id, next.parentTaskId);
		}

		return writeScoped<TaskRow, TaskRecord>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`
				title = ${next.title},
				notes = ${next.notes},
				kind = ${next.kind},
				status = ${next.status},
				project_id = ${next.projectId}::uuid,
				area_id = ${next.areaId}::uuid,
				parent_task_id = ${next.parentTaskId}::uuid,
				do_on = ${next.doOn}::date,
				deadline_on = ${next.deadlineOn}::date,
				-- Completion time is maintained by the write path, not stored by
				-- the caller: reopening a task must clear it, and a task that is
				-- already done keeps the moment it was first finished.
				completed_at = case
					when ${next.status} = 'done' then coalesce(tasks.completed_at, now())
					else null end,
				is_important = ${next.isImportant}::boolean,
				is_urgent = ${next.isUrgent}::boolean,
				energy = ${next.energy},
				context = ${next.context},
				recurrence_rule = ${next.recurrenceRule},
				recurrence_every = ${next.recurrenceEvery}::int,
				next_due_on = ${next.nextDueOn}::date,
				last_completed_on = ${next.lastCompletedOn}::date,
				is_template = ${next.isTemplate}::boolean,
				sort_order = ${next.sortOrder}::int,
				owner_user_id = ${ownership.ownerUserId}::uuid,
				visibility = ${ownership.visibility},
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapTask,
			mayWrite: writableBy(viewer)
		});
	});
}

export function setTaskArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<TaskRecord>> {
	return writeScoped<TaskRow, TaskRecord>({
		sql,
		table: TABLE,
		id,
		readScope: readableScope(sql, viewer, TABLE),
		writeScope: writableScope(sql, viewer, TABLE),
		expectedUpdatedAt,
		assignments: sql`${archivedAssignment(sql, archived)}, updated_by = ${viewer.userId}::uuid`,
		columns: columns(sql),
		map: mapTask,
		mayWrite: writableBy(viewer)
	});
}

export const archiveTask = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setTaskArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveTask = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setTaskArchived(sql, viewer, id, false, expectedUpdatedAt);

// ─── dependencies ──────────────────────────────────────────────────────────

export interface TaskDependency {
	/** The task that is waiting. */
	blockedTaskId: string;
	/** The task it is waiting on. */
	blockingTaskId: string;
	title: string;
	status: TaskStatus;
	archived: boolean;
}

/**
 * What a task is waiting on, and what is waiting on it.
 *
 * Both directions come from the one `task_dependencies` row: the source stored
 * "Blocked by" and "Blocking" as two Notion relations, but they describe a
 * single edge and storing both would let them disagree.
 *
 * Each side is scoped, so a dependency on a task the viewer cannot read simply
 * does not appear — rather than leaking its title through a join.
 */
export async function listTaskDependencies(
	sql: Queryable,
	viewer: Viewer,
	taskId: string
): Promise<{ blockedBy: TaskDependency[]; blocking: TaskDependency[] }> {
	if (!isUuid(taskId)) return { blockedBy: [], blocking: [] };

	const rows = await sql<
		{
			direction: 'blocked_by' | 'blocking';
			blocked_task_id: string;
			blocking_task_id: string;
			title: string;
			status: string;
			archived: boolean;
		}[]
	>`
		select 'blocked_by' as direction, d.blocked_task_id, d.blocking_task_id,
		       t.title, t.status, (t.archived_at is not null) as archived
		from task_dependencies d
		join tasks t on t.id = d.blocking_task_id
		where d.blocked_task_id = ${taskId}::uuid and ${readableScope(sql, viewer, 't')}
		union all
		select 'blocking' as direction, d.blocked_task_id, d.blocking_task_id,
		       t.title, t.status, (t.archived_at is not null) as archived
		from task_dependencies d
		join tasks t on t.id = d.blocked_task_id
		where d.blocking_task_id = ${taskId}::uuid and ${readableScope(sql, viewer, 't')}
		order by title
	`;

	const map = (r: (typeof rows)[number]): TaskDependency => ({
		blockedTaskId: r.blocked_task_id,
		blockingTaskId: r.blocking_task_id,
		title: r.title,
		status: r.status as TaskStatus,
		archived: Boolean(r.archived)
	});

	return {
		blockedBy: rows.filter((r) => r.direction === 'blocked_by').map(map),
		blocking: rows.filter((r) => r.direction === 'blocking').map(map)
	};
}

/**
 * Records that `blockedTaskId` is waiting on `blockingTaskId`.
 *
 * Refuses a cycle. Without that check a pair of tasks can end up waiting on
 * each other and neither is ever actionable — the graph looks fine row by row
 * and is unresolvable as a whole, which is precisely the sort of thing nobody
 * notices until they are staring at an empty Today.
 */
export function addTaskDependency(
	sql: Queryable,
	viewer: Viewer,
	blockedTaskId: string,
	blockingTaskId: string
): Promise<WriteResult<TaskDependency>> {
	return guarded<TaskDependency>(async () => {
		if (!isUuid(blockedTaskId) || !isUuid(blockingTaskId)) {
			throw new InvalidInput('task id is not valid');
		}
		if (blockedTaskId === blockingTaskId) {
			throw new InvalidInput('a task cannot depend on itself');
		}

		// The waiting task must be writable; the one waited on need only be
		// readable, the same asymmetry as attaching a task to a project.
		const blocked = await getScoped<{ id: string }>(
			sql,
			TABLE,
			blockedTaskId,
			writableScope(sql, viewer, TABLE),
			sql`id`
		);
		if (!blocked) return { ok: false, reason: 'not_found' };

		const blocking = await getScoped<{ id: string; title: string; status: string }>(
			sql,
			TABLE,
			blockingTaskId,
			readableScope(sql, viewer, TABLE),
			sql`id, title, status`
		);
		if (!blocking) return { ok: false, reason: 'not_found' };

		// Walk the existing edges: if the task we would wait on already waits
		// on us, transitively, adding this edge closes a loop.
		const cycle = await sql<{ found: boolean }[]>`
			with recursive downstream as (
				select blocking_task_id as id from task_dependencies
				where blocked_task_id = ${blockingTaskId}::uuid
				union
				select d.blocking_task_id from task_dependencies d
				join downstream x on d.blocked_task_id = x.id
			)
			select true as found from downstream where id = ${blockedTaskId}::uuid limit 1
		`;
		if (cycle.length > 0) {
			throw new InvalidInput('that would make the two tasks wait on each other');
		}

		await sql`
			insert into task_dependencies (blocked_task_id, blocking_task_id)
			values (${blockedTaskId}::uuid, ${blockingTaskId}::uuid)
			on conflict do nothing
		`;

		return {
			ok: true,
			record: {
				blockedTaskId,
				blockingTaskId,
				title: blocking.title,
				status: blocking.status as TaskStatus,
				archived: false
			}
		};
	});
}

/** Removes the edge. Returns false when there was nothing to remove. */
export async function removeTaskDependency(
	sql: Queryable,
	viewer: Viewer,
	blockedTaskId: string,
	blockingTaskId: string
): Promise<boolean> {
	if (!isUuid(blockedTaskId) || !isUuid(blockingTaskId)) return false;
	const rows = await sql<{ blocked_task_id: string }[]>`
		delete from task_dependencies d
		using tasks t
		where t.id = d.blocked_task_id
		  and d.blocked_task_id = ${blockedTaskId}::uuid
		  and d.blocking_task_id = ${blockingTaskId}::uuid
		  and ${writableScope(sql, viewer, 't')}
		returning d.blocked_task_id
	`;
	return rows.length > 0;
}
