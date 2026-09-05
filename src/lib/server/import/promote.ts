import type { Sql, TransactionSql } from 'postgres';

/**
 * Promotion always runs inside the import's transaction, so it must accept a
 * TransactionSql as well as a pool. They are structurally different types in
 * this driver even though the query interface is identical.
 */
type Queryable = Sql | TransactionSql;
import { parseSourceBoolean, parseSourceDate } from './csv.ts';

/**
 * Promotion of staged rows into domain tables (IMP-007, IMP-010).
 *
 * Runs after staging, in the same transaction as the caller. Two passes again:
 * every row becomes a domain record first, then relations become foreign keys
 * once every target exists.
 *
 * Idempotent by `notion_page_id`: rerunning updates the same record rather than
 * creating a second one. Rows without a page id are inserted once and skipped
 * on later runs, since there is no key to match them on — reported rather than
 * silently duplicated.
 *
 * Derived source columns are deliberately not carried over. "Percent
 * Completed", "PROJECT HEALTH", "Task Percent Progress" and similar are
 * recomputed from the real data; importing them would freeze a stale number
 * into a column that looks authoritative.
 */

export interface PromoteOptions {
	importRunId: string;
	householdId: string;
	ownerUserId: string | null;
	createdBy: string | null;
}

export interface PromoteSummary {
	counts: Record<string, number>;
	relations: Record<string, number>;
	skippedWithoutPageId: number;
}

interface StagedRow {
	id: string;
	notion_page_id: string | null;
	database_name: string;
	title: string | null;
	raw: Record<string, string>;
}

const text = (row: StagedRow, column: string): string | null => {
	const v = row.raw[column];
	return v && v.trim() ? v.trim() : null;
};

const date = (row: StagedRow, column: string): string | null =>
	parseSourceDate(row.raw[column] ?? '')?.date ?? null;

const bool = (row: StagedRow, column: string): boolean =>
	parseSourceBoolean(row.raw[column] ?? '') === true;

const int = (row: StagedRow, column: string): number | null => {
	const n = Number.parseInt(row.raw[column] ?? '', 10);
	return Number.isFinite(n) ? n : null;
};

/** Notion status values vary per database; each mapper supplies its own table. */
function mapStatus(value: string | null, table: Record<string, string>, fallback: string): string {
	if (!value) return fallback;
	return table[value.trim().toLowerCase()] ?? fallback;
}

const TASK_STATUS: Record<string, string> = {
	'to do': 'todo',
	'not started': 'todo',
	'in progress': 'in_progress',
	doing: 'in_progress',
	blocked: 'blocked',
	'on hold': 'blocked',
	done: 'done',
	complete: 'done',
	completed: 'done',
	dropped: 'dropped',
	cancelled: 'dropped'
};

const PROJECT_STATUS: Record<string, string> = {
	planned: 'planned',
	'not started': 'planned',
	active: 'active',
	live: 'active',
	'in progress': 'active',
	paused: 'on_hold',
	'on hold': 'on_hold',
	done: 'done',
	complete: 'done',
	completed: 'done',
	dropped: 'dropped'
};

const GOAL_STATUS: Record<string, string> = {
	active: 'active',
	'in progress': 'active',
	achieved: 'achieved',
	complete: 'achieved',
	completed: 'achieved',
	paused: 'paused',
	'on hold': 'paused',
	dropped: 'dropped'
};

export async function promote(sql: Queryable, options: PromoteOptions): Promise<PromoteSummary> {
	const rows = await sql<StagedRow[]>`
		select id, notion_page_id, database_name, title, raw
		from source_records
		where import_run_id = ${options.importRunId}
		order by database_name, ordinal
	`;

	const counts: Record<string, number> = {};
	const relations: Record<string, number> = {};
	let skippedWithoutPageId = 0;

	// notion_page_id -> { table, id }, so pass two can turn a relation into a
	// foreign key without caring which database it pointed at.
	const target = new Map<string, { table: string; id: string }>();

	const byDatabase = new Map<string, StagedRow[]>();
	for (const row of rows) {
		const list = byDatabase.get(row.database_name) ?? [];
		list.push(row);
		byDatabase.set(row.database_name, list);
	}

	const bump = (table: string) => {
		counts[table] = (counts[table] ?? 0) + 1;
	};

	// ─── pass one: rows become records ─────────────────────────────────────
	for (const [database, staged] of byDatabase) {
		const mapper = MAPPERS[database];
		if (!mapper) continue; // feature-pack databases arrive in a later phase

		for (const row of staged) {
			if (!row.notion_page_id) {
				skippedWithoutPageId++;
				continue;
			}
			// Archived rows keep their content but arrive archived, so nothing
			// from the source is lost and nothing stale shows up in a live view.
			const id = await mapper(sql, row, options);
			if (!id) continue;
			target.set(row.notion_page_id, { table: mapper.table, id });
			bump(mapper.table);
		}
	}

	// ─── pass two: relations become foreign keys ───────────────────────────
	const links = await sql<{ from_page: string | null; property: string; to_page: string }[]>`
		select r.notion_page_id as from_page, l.property, l.to_notion_page_id as to_page
		from source_links l
		join source_records r on r.id = l.from_record_id
		where l.import_run_id = ${options.importRunId}
		  and r.notion_page_id is not null
		order by l.position
	`;

	const bumpRelation = (name: string) => {
		relations[name] = (relations[name] ?? 0) + 1;
	};

	for (const link of links) {
		if (!link.from_page) continue;
		const from = target.get(link.from_page);
		const to = target.get(link.to_page);
		if (!from || !to) continue;

		const applied = await applyRelation(sql, from, to, link.property);
		if (applied) bumpRelation(applied);
	}

	return { counts, relations, skippedWithoutPageId };
}

/**
 * Turns one staged relation into a foreign key or join row.
 *
 * Only pairs that the MVP schema models are applied; anything else is left in
 * `source_links`, where a later feature pack can pick it up. Returning the
 * relation name makes the report show what was actually connected rather than
 * how many links were seen.
 */
async function applyRelation(
	sql: Queryable,
	from: { table: string; id: string },
	to: { table: string; id: string },
	property: string
): Promise<string | null> {
	const pair = `${from.table}->${to.table}`;

	switch (pair) {
		case 'tasks->projects':
			await sql`update tasks set project_id = ${to.id} where id = ${from.id}`;
			return 'task.project';

		case 'tasks->areas':
			await sql`update tasks set area_id = ${to.id} where id = ${from.id}`;
			return 'task.area';

		case 'tasks->tasks': {
			// "Parent Task" and "Sub-Task" describe the same edge from opposite
			// ends; storing both would invert half the hierarchy.
			const p = property.toLowerCase();
			if (p.includes('parent')) {
				await sql`update tasks set parent_task_id = ${to.id} where id = ${from.id}`;
				return 'task.parent';
			}
			if (p.includes('sub')) {
				await sql`update tasks set parent_task_id = ${from.id} where id = ${to.id}`;
				return 'task.parent';
			}
			if (p.includes('blocked by')) {
				await sql`
					insert into task_dependencies (blocked_task_id, blocking_task_id)
					values (${from.id}, ${to.id}) on conflict do nothing
				`;
				return 'task.dependency';
			}
			if (p.includes('blocking')) {
				await sql`
					insert into task_dependencies (blocked_task_id, blocking_task_id)
					values (${to.id}, ${from.id}) on conflict do nothing
				`;
				return 'task.dependency';
			}
			return null;
		}

		case 'projects->areas':
			await sql`
				insert into project_areas (project_id, area_id)
				values (${from.id}, ${to.id}) on conflict do nothing
			`;
			return 'project.area';

		case 'projects->goals':
			await sql`
				insert into project_goals (project_id, goal_id)
				values (${from.id}, ${to.id}) on conflict do nothing
			`;
			return 'project.goal';

		case 'goals->areas':
			await sql`
				insert into goal_areas (goal_id, area_id)
				values (${from.id}, ${to.id}) on conflict do nothing
			`;
			return 'goal.area';

		case 'goals->habits':
			await sql`
				insert into goal_habits (goal_id, habit_id)
				values (${from.id}, ${to.id}) on conflict do nothing
			`;
			return 'goal.habit';

		case 'habits->areas':
			await sql`update habits set area_id = ${to.id} where id = ${from.id}`;
			return 'habit.area';

		default:
			return null;
	}
}

// ─── per-database mappers ──────────────────────────────────────────────────

type MapFn = (sql: Queryable, row: StagedRow, options: PromoteOptions) => Promise<string | null>;

type Mapper = MapFn & { table: string };

/** Tags a mapping function with the table it writes to. */
function mapper(table: string, fn: MapFn): Mapper {
	return Object.assign(fn, { table });
}

const upsertAreas = mapper('areas', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into areas (household_id, owner_user_id, name, review_every_days,
		                   last_reviewed_on, notion_page_id, source_record_id,
		                   created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${int(row, 'Review Every')}, ${date(row, 'Last Reviewed')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name,
			review_every_days = excluded.review_every_days,
			last_reviewed_on = excluded.last_reviewed_on,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertGoals = mapper('goals', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into goals (household_id, owner_user_id, title, description, status,
		                   target_date, achieved_on, notion_page_id, source_record_id,
		                   created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${text(row, 'Short Summary')},
		        ${mapStatus(text(row, 'Status'), GOAL_STATUS, 'active')},
		        ${date(row, 'Deadline')}, ${date(row, 'Achieved on')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			title = excluded.title,
			description = excluded.description,
			status = excluded.status,
			target_date = excluded.target_date,
			achieved_on = excluded.achieved_on,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertProjects = mapper('projects', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into projects (household_id, owner_user_id, name, description, status,
		                      due_on, notion_page_id, source_record_id, created_by,
		                      is_template, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${text(row, 'Notes')},
		        ${mapStatus(text(row, 'Status'), PROJECT_STATUS, 'active')},
		        ${date(row, 'Review Due')}, ${row.notion_page_id}, ${row.id},
		        ${o.createdBy},
		        ${/template/i.test(row.title ?? '')},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name,
			description = excluded.description,
			status = excluded.status,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertTasks = mapper('tasks', async (sql, row, o) => {
	const energyRaw = (text(row, 'Energy Requirement') ?? '').toLowerCase();
	const energy = ['low', 'medium', 'high'].find((e) => energyRaw.includes(e)) ?? null;

	const [r] = await sql<{ id: string }[]>`
		insert into tasks (household_id, owner_user_id, title, kind, status, do_on,
		                   deadline_on, is_important, is_urgent, energy, context,
		                   recurrence_rule, recurrence_every, next_due_on,
		                   last_completed_on, is_template, notion_page_id,
		                   source_record_id, created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${/milestone/i.test(text(row, 'Type') ?? '') ? 'milestone' : 'task'},
		        ${mapStatus(text(row, 'Status'), TASK_STATUS, 'todo')},
		        ${date(row, 'Do Date')}, ${date(row, 'Deadline')},
		        ${bool(row, 'Important')}, ${bool(row, 'Urgent')},
		        ${energy}, ${text(row, 'Context')},
		        ${text(row, 'Recurrence')}, ${int(row, 'Repeat Every')},
		        ${date(row, 'Next Due')}, ${date(row, 'Last Completed')},
		        ${/template/i.test(row.title ?? '')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			title = excluded.title,
			kind = excluded.kind,
			status = excluded.status,
			do_on = excluded.do_on,
			deadline_on = excluded.deadline_on,
			is_important = excluded.is_important,
			is_urgent = excluded.is_urgent,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertTags = mapper('tags', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into tags (household_id, name, notion_page_id, source_record_id, archived_at)
		values (${o.householdId}, ${row.title ?? 'Untitled'}, ${row.notion_page_id},
		        ${row.id},
		        ${bool(row, 'Archive?') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertImportantDates = mapper('important_dates', async (sql, row, o) => {
	const on = date(row, 'Date');
	// A date entry with no date is not usable; it stays staged instead.
	if (!on) return null;

	const repeats = (text(row, 'Repeats') ?? '').toLowerCase();
	const recurrence = repeats.includes('year')
		? 'yearly'
		: repeats.includes('month')
			? 'monthly'
			: repeats && repeats !== 'no'
				? 'custom'
				: 'none';

	const [r] = await sql<{ id: string }[]>`
		insert into important_dates (household_id, owner_user_id, title, notes, on_date,
		                             recurrence, notion_page_id, source_record_id, created_by)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${text(row, 'Notes')}, ${on}, ${recurrence}, ${row.notion_page_id},
		        ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			title = excluded.title,
			notes = excluded.notes,
			on_date = excluded.on_date,
			recurrence = excluded.recurrence,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertHabits = mapper('habits', async (sql, row, o) => {
	const unit = (text(row, 'Frequency Unit') ?? 'day').toLowerCase();
	const period = unit.includes('week') ? 'week' : unit.includes('month') ? 'month' : 'day';
	const status = (text(row, 'Status') ?? '').toLowerCase();

	const [r] = await sql<{ id: string }[]>`
		insert into habits (household_id, owner_user_id, name, target_count, target_period,
		                    active, notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${Math.max(1, int(row, 'Frequency') ?? 1)}, ${period},
		        ${!status.includes('retired') && !status.includes('paused')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name,
			target_count = excluded.target_count,
			target_period = excluded.target_period,
			active = excluded.active,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertDailyLogs = mapper('daily_logs', async (sql, row, o) => {
	const on = date(row, 'Date');
	// The daily log's identity is its date; without one there is nothing to key.
	if (!on || !o.ownerUserId) return null;

	const [r] = await sql<{ id: string }[]>`
		insert into daily_logs (household_id, owner_user_id, on_date, note, energy_level,
		                        gratitude, highlight, notion_page_id, source_record_id,
		                        created_by)
		values (${o.householdId}, ${o.ownerUserId}, ${on}, ${text(row, 'Intention')},
		        ${int(row, 'Energy')}, ${text(row, 'Gratitude')},
		        ${text(row, 'Highlight of the Day')}, ${row.notion_page_id}, ${row.id},
		        ${o.createdBy})
		on conflict (notion_page_id) do update set
			on_date = excluded.on_date,
			note = excluded.note,
			energy_level = excluded.energy_level,
			gratitude = excluded.gratitude,
			highlight = excluded.highlight,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

/** Source database name to mapper. Unlisted databases stay staged only. */
const MAPPERS: Record<string, Mapper> = {
	'Areas Database': upsertAreas,
	'Goals Database': upsertGoals,
	'Projects Database': upsertProjects,
	'Tasks Database': upsertTasks,
	'Tags & Topics (Resources) Database': upsertTags,
	'Important Dates Database': upsertImportantDates,
	'Habit Tracker Database': upsertHabits,
	'Daily Log Database': upsertDailyLogs
};

export const MAPPED_DATABASES = Object.keys(MAPPERS);
