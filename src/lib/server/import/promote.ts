import type { Sql, TransactionSql } from 'postgres';

/**
 * Promotion always runs inside the import's transaction, so it must accept a
 * TransactionSql as well as a pool. They are structurally different types in
 * this driver even though the query interface is identical.
 */
type Queryable = Sql | TransactionSql;
import {
	parseReviewCadence,
	parseSourceBoolean,
	parseSourceDate,
	parseSourceRange
} from './csv.ts';

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
	/** Page body from the Markdown export; the CSVs do not carry it. */
	body: string | null;
}

/**
 * Combines a CSV column with the page body.
 *
 * The body is the richer content and goes first, but the column is kept when
 * both exist — they are different fields in the source and discarding either
 * would lose something the household wrote.
 */
const withBody = (row: StagedRow, column: string | null): string | null => {
	const columnValue = column ? text(row, column) : null;
	if (row.body && columnValue) return `${row.body}\n\n---\n\n${columnValue}`;
	return row.body ?? columnValue;
};

const text = (row: StagedRow, column: string): string | null => {
	const v = row.raw[column];
	return v && v.trim() ? v.trim() : null;
};

const date = (row: StagedRow, column: string): string | null =>
	parseSourceDate(row.raw[column] ?? '')?.date ?? null;

const bool = (row: StagedRow, column: string): boolean =>
	parseSourceBoolean(row.raw[column] ?? '') === true;

/**
 * The same, but keeping the difference between No and not recorded.
 *
 * `bool` folds an absent value to false, which is right for a checkbox like
 * Archive and wrong for a reading: a day where nobody wrote down whether they
 * had caffeine is not a day without caffeine.
 */
const boolOrNull = (row: StagedRow, column: string): boolean | null =>
	parseSourceBoolean(row.raw[column] ?? '');

const int = (row: StagedRow, column: string): number | null => {
	const n = Number.parseInt(row.raw[column] ?? '', 10);
	return Number.isFinite(n) ? n : null;
};

/**
 * A full timestamp, for the columns that carry one.
 *
 * `date()` throws away the time of day, which is right for a due date and
 * wrong for "last interaction" — the library's rediscover ordering is the
 * only thing that makes an old note findable again.
 */
const timestamp = (row: StagedRow, column: string): string | null => {
	const raw = (row.raw[column] ?? '').trim();
	if (!raw) return null;

	// Notion writes the zone as a trailing "(UTC)", which Date.parse ignores
	// entirely — it then reads the clock time as LOCAL and every timestamp
	// shifts by the server's offset. Rewriting the marker into a form the
	// parser understands is what makes the value mean what it says.
	const zoned = /\(UTC\)\s*$/i.test(raw) ? `${raw.replace(/\(UTC\)\s*$/i, '').trim()} UTC` : raw;

	const parsed = Date.parse(zoned);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/** Decimal readings such as a blood glucose of 6.2, which `int` would truncate. */
const numeric = (row: StagedRow, column: string): number | null => {
	const raw = (row.raw[column] ?? '').trim();
	if (!raw) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
};

/** Row-reading wrappers over the pure parsers in ./csv. */
const reviewEveryDays = (row: StagedRow, column: string): number | null =>
	parseReviewCadence(row.raw[column] ?? '');

/** The leading year of a relation value such as `2026 (Time%20Databases/...)`. */
function yearOf(row: StagedRow, column: string, fallbackColumn: string): number | null {
	const direct = /\b(19|20)\d{2}\b/.exec(row.raw[column] ?? '');
	if (direct) return Number(direct[0]);
	const created = parseSourceDate(row.raw[fallbackColumn] ?? '')?.date;
	return created ? Number(created.slice(0, 4)) : null;
}

/** Notion status values vary per database; each mapper supplies its own table. */
function mapStatus(value: string | null, table: Record<string, string>, fallback: string): string {
	if (!value) return fallback;
	return table[value.trim().toLowerCase()] ?? fallback;
}

const TASK_STATUS: Record<string, string> = {
	'in inbox': 'inbox',
	inbox: 'inbox',
	// The largest group in the export. Without this it lands on the 'todo'
	// fallback and the inbox imports empty.
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
	// Chosen for later, not started. Without these two the "On the Horizon"
	// board collapses into the active goals and a review asks for progress on
	// something deliberately not begun.
	someday: 'someday',
	planned: 'planned',
	'not started': 'planned',
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
		select id, notion_page_id, database_name, title, raw, body
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
/**
 * Table name to the `entity_tags.entity_type` the application uses.
 *
 * Mirrors TAGGABLE in repositories/tags.ts; a table missing here simply
 * cannot be tagged, which is why the relation returns null rather than
 * inventing a type the reader would never query for.
 */
const TAGGABLE_BY_TABLE: Record<string, string> = {
	tasks: 'task',
	projects: 'project',
	areas: 'area',
	goals: 'goal',
	habits: 'habit',
	important_dates: 'important_date',
	daily_logs: 'daily_log',
	library_items: 'library_item'
};

async function applyRelation(
	sql: Queryable,
	from: { table: string; id: string },
	to: { table: string; id: string },
	property: string
): Promise<string | null> {
	const pair = `${from.table}->${to.table}`;

	// Tags are the one relation that is the same shape from every table, and
	// nothing was handling it: every "Tags & Topics" link in the export — on
	// tasks, projects, goals, areas and the library — was being counted and
	// then dropped, so `entity_tags` came out of a full import empty.
	if (to.table === 'tags') {
		const entityType = TAGGABLE_BY_TABLE[from.table];
		if (!entityType) return null;
		await sql`
			insert into entity_tags (tag_id, entity_type, entity_id)
			values (${to.id}, ${entityType}, ${from.id}) on conflict do nothing
		`;
		return 'tag.attached';
	}

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

		case 'daily_logs->health_vocabulary':
			// Physical Symptoms, Mood/Feelings, Vitamins and Energy all land
			// here. Which list a term came from is the term's own `kind`, so the
			// property name does not need inspecting — a day simply logged it.
			await sql`
				insert into daily_log_health (daily_log_id, vocabulary_id)
				values (${from.id}, ${to.id}) on conflict do nothing
			`;
			return 'daily_log.health';

		case 'recipes->ingredients':
			await sql`
				insert into recipe_ingredients (recipe_id, ingredient_id)
				values (${from.id}, ${to.id}) on conflict do nothing
			`;
			return 'recipe.ingredient';

		case 'meal_plans->recipes': {
			// Which meal it is lives in the PROPERTY name — Breakfast, Lunch,
			// Dinner, Snacks — not in the recipe. The source also has display
			// columns spelled "Breakfast:" and "DInner:", so the match is on a
			// lowercased substring rather than equality.
			const p = property.toLowerCase();
			const slot = p.includes('breakfast')
				? 'breakfast'
				: p.includes('lunch')
					? 'lunch'
					: p.includes('dinner')
						? 'dinner'
						: p.includes('snack')
							? 'snack'
							: null;
			if (!slot) return null;
			await sql`
				insert into meal_plan_recipes (meal_plan_id, recipe_id, slot)
				values (${from.id}, ${to.id}, ${slot}) on conflict do nothing
			`;
			return 'meal_plan.recipe';
		}

		case 'prep_tasks->recipes':
			await sql`update prep_tasks set recipe_id = ${to.id} where id = ${from.id}`;
			return 'prep_task.recipe';

		case 'wishlist_items->people':
			await sql`update wishlist_items set for_person_id = ${to.id} where id = ${from.id}`;
			return 'wishlist.person';

		case 'life_assessments->areas':
			await sql`update life_assessments set area_id = ${to.id} where id = ${from.id}`;
			return 'assessment.area';

		case 'significant_events->areas':
			await sql`update significant_events set area_id = ${to.id} where id = ${from.id}`;
			return 'event.area';

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
		insert into areas (household_id, owner_user_id, name, description, review_every_days,
		                   last_reviewed_on, notion_page_id, source_record_id,
		                   created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${withBody(row, null)}, ${reviewEveryDays(row, 'Review Every')},
		        ${date(row, 'Last Reviewed')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name,
			description = excluded.description,
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
		                   target_date, achieved_on, review_every_days, last_reviewed_on,
		                   notion_page_id, source_record_id,
		                   created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${withBody(row, 'Short Summary')},
		        ${mapStatus(text(row, 'Status'), GOAL_STATUS, 'active')},
		        ${date(row, 'Deadline')}, ${date(row, 'Achieved on')},
		        ${reviewEveryDays(row, 'Set Review Frequency')}, ${date(row, 'Last Review')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			title = excluded.title,
			description = excluded.description,
			status = excluded.status,
			target_date = excluded.target_date,
			achieved_on = excluded.achieved_on,
			review_every_days = excluded.review_every_days,
			last_reviewed_on = excluded.last_reviewed_on,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertProjects = mapper('projects', async (sql, row, o) => {
	// `Review Due` is a Yes/No formula, not a date. Reading it as one left
	// `due_on` null for every project in the export, while the schedule that
	// does exist — the `Timeline` range — was dropped on the floor.
	const timeline = parseSourceRange(text(row, 'Timeline'), yearOf(row, 'Year', 'Created time'));

	const [r] = await sql<{ id: string }[]>`
		insert into projects (household_id, owner_user_id, name, description, status,
		                      start_on, due_on, review_every_days, last_reviewed_on,
		                      notion_page_id, source_record_id, created_by,
		                      is_template, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${withBody(row, 'Notes')},
		        ${mapStatus(text(row, 'Status'), PROJECT_STATUS, 'active')},
		        ${timeline.start}, ${timeline.end},
		        ${reviewEveryDays(row, 'Review Frequency in Days')},
		        ${date(row, 'Last Review')},
		        ${row.notion_page_id}, ${row.id},
		        ${o.createdBy},
		        ${/template/i.test(row.title ?? '')},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name,
			description = excluded.description,
			status = excluded.status,
			start_on = excluded.start_on,
			due_on = excluded.due_on,
			review_every_days = excluded.review_every_days,
			last_reviewed_on = excluded.last_reviewed_on,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertTasks = mapper('tasks', async (sql, row, o) => {
	const energyRaw = (text(row, 'Energy Requirement') ?? '').toLowerCase();
	const energy = ['low', 'medium', 'high'].find((e) => energyRaw.includes(e)) ?? null;

	const [r] = await sql<{ id: string }[]>`
		insert into tasks (household_id, owner_user_id, title, notes, kind, status, do_on,
		                   deadline_on, is_important, is_urgent, energy, context,
		                   recurrence_rule, recurrence_every, next_due_on,
		                   last_completed_on, is_template, notion_page_id,
		                   source_record_id, created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${row.title ?? 'Untitled'},
		        ${withBody(row, null)},
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
			notes = excluded.notes,
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
		        ${withBody(row, 'Notes')}, ${on}, ${recurrence}, ${row.notion_page_id},
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
	// `energy_level` is deliberately not set here. The source's Energy column
	// is a RELATION to the Energy Level database — 'Balanced (…)' — and it was
	// being read with parseInt, so it resolved to null on every row. It is a
	// vocabulary term now and arrives through the relation pass instead.
	const on = date(row, 'Date');
	// The daily log's identity is its date; without one there is nothing to key.
	if (!on || !o.ownerUserId) return null;

	const [r] = await sql<{ id: string }[]>`
		insert into daily_logs (household_id, owner_user_id, on_date, note,
		                        gratitude, highlight, blood_glucose, systolic_bp,
		                        diastolic_bp, heart_rate, heart_rate_variability,
		                        sleep_score, water, caffeine, carbonation, intimacy,
		                        activation, effectiveness, head_space,
		                        notion_page_id, source_record_id, created_by)
		values (${o.householdId}, ${o.ownerUserId}, ${on}, ${withBody(row, 'Intention')},
		        ${text(row, 'Gratitude')},
		        ${text(row, 'Highlight of the Day')},
		        ${numeric(row, 'Blood Glucose')}, ${int(row, 'Systolic BP')},
		        ${int(row, 'Diastolic BP')}, ${int(row, 'Heart Rate')},
		        ${int(row, 'Heart Rate Variability')}, ${int(row, 'Sleep Score')},
		        ${int(row, 'Water')}, ${boolOrNull(row, 'Caffeine')},
		        ${boolOrNull(row, 'Carbonation')}, ${boolOrNull(row, 'Intimacy')},
		        ${int(row, 'Activation')}, ${int(row, 'Effectiveness')},
		        ${text(row, 'Head Space')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			on_date = excluded.on_date,
			note = excluded.note,
			gratitude = excluded.gratitude,
			highlight = excluded.highlight,
			blood_glucose = excluded.blood_glucose,
			systolic_bp = excluded.systolic_bp,
			diastolic_bp = excluded.diastolic_bp,
			heart_rate = excluded.heart_rate,
			heart_rate_variability = excluded.heart_rate_variability,
			sleep_score = excluded.sleep_score,
			water = excluded.water,
			caffeine = excluded.caffeine,
			carbonation = excluded.carbonation,
			intimacy = excluded.intimacy,
			activation = excluded.activation,
			effectiveness = excluded.effectiveness,
			head_space = excluded.head_space,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

/**
 * The health and journal vocabularies (migration 0011).
 *
 * Six Notion databases — Symptoms, Mood/Feelings, Vitamins, Energy Level,
 * Activity, Exercise — that are all the same shape: a list of named things
 * related back to the Daily Log. One factory rather than six near-identical
 * mappers, so a seventh list costs a line.
 *
 * `attributeColumns` are the per-kind extras that do not deserve a column
 * each: Energy Level carries an approach, a mantra and what to watch for;
 * Mood carries a type and what helps.
 */
function vocabularyMapper(kind: string, attributeColumns: readonly string[] = []): Mapper {
	return mapper('health_vocabulary', async (sql, row, o) => {
		const attributes: Record<string, string> = {};
		for (const column of attributeColumns) {
			const value = text(row, column);
			if (value) attributes[column.replace(/[:?]\s*$/, '').trim()] = value;
		}

		const [r] = await sql<{ id: string }[]>`
			insert into health_vocabulary (household_id, owner_user_id, visibility, kind, name,
			                               notes, attributes, notion_page_id, source_record_id,
			                               created_by, archived_at)
			values (${o.householdId}, null, 'household', ${kind}, ${row.title ?? 'Untitled'},
			        ${withBody(row, null)},
			        ${JSON.stringify(attributes)}::text::jsonb,
			        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
			        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
			on conflict (notion_page_id) do update set
				name = excluded.name,
				notes = excluded.notes,
				attributes = excluded.attributes,
				source_record_id = excluded.source_record_id
			returning id
		`;
		return r?.id ?? null;
	});
}

// ─── food (migration 0012) ─────────────────────────────────────────────────

/**
 * Matches a select value by the words in it, ignoring decoration.
 *
 * The Ingredients status options are spelled "✅ In Stock", "🛒 Shopping List",
 * "⚡️ Use up!" and "❌ Don\u2019t Need". An exact lookup misses every one of
 * them, and `mapStatus` would quietly return its fallback — so all 68
 * ingredients would have imported as "in stock" including the shopping list.
 */
function matchOption<T extends string>(
	value: string | null,
	table: readonly (readonly [string, T])[],
	fallback: T | null
): T | null {
	if (!value) return fallback;
	// Strip everything that is not a letter or a space, so emoji and
	// punctuation cannot prevent a match.
	const text = value
		.toLowerCase()
		.replace(/[^a-z ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	for (const [needle, result] of table) if (text.includes(needle)) return result;
	return fallback;
}

const INGREDIENT_STATUS = [
	['shopping', 'shopping_list'],
	['use up', 'use_up'],
	['don t need', 'not_needed'],
	['dont need', 'not_needed'],
	['in stock', 'in_stock']
] as const;

const PREP_WHEN = [
	['batch', 'batch_prep'],
	['night before', 'night_before'],
	['before cooking', 'before_cooking']
] as const;

/** "Breakfast, Snacks" is how the source spells a multi-select. */
const multi = (row: StagedRow, column: string): string[] => {
	const raw = text(row, column);
	if (!raw) return [];
	return raw
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
};

const upsertIngredients = mapper('ingredients', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into ingredients (household_id, owner_user_id, name, aisle, category, status,
		                         is_staple, store, quantity, preferred_brand, notes,
		                         notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'},
		        ${text(row, 'Aisle')}, ${text(row, 'Category')},
		        ${matchOption(text(row, 'Status'), INGREDIENT_STATUS, 'in_stock')},
		        ${bool(row, 'Staple?')}, ${text(row, 'Store')}, ${text(row, 'Quantity')},
		        ${text(row, 'Preferred Brand')}, ${withBody(row, 'Notes')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name,
			aisle = excluded.aisle,
			category = excluded.category,
			status = excluded.status,
			is_staple = excluded.is_staple,
			store = excluded.store,
			quantity = excluded.quantity,
			preferred_brand = excluded.preferred_brand,
			notes = excluded.notes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertRecipes = mapper('recipes', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into recipes (household_id, owner_user_id, name, notes, url, servings,
		                     prep_minutes, cook_minutes, additional_minutes,
		                     kcal_per_serving, protein_g, carbs_g, fibre_g, sugar_g,
		                     total_fat_g, sodium_mg, courses, seasons, cuisine, occasion,
		                     effort, source_type, status, is_favourite, last_made_on,
		                     notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'},
		        ${withBody(row, 'Notes')}, ${text(row, 'URL')},
		        ${int(row, '# of Servings')},
		        ${int(row, 'Prep Time')}, ${int(row, 'Cook Time')},
		        ${int(row, 'Additional Time')},
		        ${numeric(row, 'kcal/serving')}, ${numeric(row, 'Protein')},
		        ${numeric(row, 'Carbs')}, ${numeric(row, 'Fibre')}, ${numeric(row, 'Sugar')},
		        ${numeric(row, 'Total Fat')}, ${numeric(row, 'Sodium')},
		        ${multi(row, 'Course')}::text[], ${multi(row, 'Season')}::text[],
		        ${text(row, 'Cuisine')}, ${text(row, 'Occasion')},
		        ${text(row, 'Effort/Energy')}, ${text(row, 'Source Type')},
		        ${text(row, 'Status')}, ${bool(row, 'Favourite')},
		        ${date(row, 'Date Last Made')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive?') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name,
			notes = excluded.notes,
			url = excluded.url,
			servings = excluded.servings,
			prep_minutes = excluded.prep_minutes,
			cook_minutes = excluded.cook_minutes,
			additional_minutes = excluded.additional_minutes,
			kcal_per_serving = excluded.kcal_per_serving,
			protein_g = excluded.protein_g,
			carbs_g = excluded.carbs_g,
			fibre_g = excluded.fibre_g,
			sugar_g = excluded.sugar_g,
			total_fat_g = excluded.total_fat_g,
			sodium_mg = excluded.sodium_mg,
			courses = excluded.courses,
			seasons = excluded.seasons,
			cuisine = excluded.cuisine,
			occasion = excluded.occasion,
			effort = excluded.effort,
			source_type = excluded.source_type,
			status = excluded.status,
			is_favourite = excluded.is_favourite,
			last_made_on = excluded.last_made_on,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertMealPlans = mapper('meal_plans', async (sql, row, o) => {
	const on = date(row, 'Date');
	// The date is the identity; a menu with no date cannot be placed.
	if (!on) return null;

	const [r] = await sql<{ id: string }[]>`
		insert into meal_plans (household_id, owner_user_id, on_date, name, notes,
		                        notion_page_id, source_record_id, created_by)
		values (${o.householdId}, null, ${on}, ${row.title ?? null}, ${withBody(row, null)},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			on_date = excluded.on_date,
			name = excluded.name,
			notes = excluded.notes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertPrepTasks = mapper('prep_tasks', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into prep_tasks (household_id, owner_user_id, name, is_done, when_to_do,
		                        notes, notion_page_id, source_record_id, created_by)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'},
		        ${bool(row, 'Done')},
		        ${matchOption(text(row, 'When?'), PREP_WHEN, null)},
		        ${withBody(row, null)},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			name = excluded.name,
			is_done = excluded.is_done,
			when_to_do = excluded.when_to_do,
			notes = excluded.notes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

// ─── the library (migration 0013) ──────────────────────────────────────────

const ENTRY_TYPE = [
	['book', 'book'],
	['note', 'note'],
	['reference', 'reference']
] as const;

const LIBRARY_STATUS = [
	['reading list', 'reading_list'],
	['inbox', 'inbox'],
	['new', 'inbox'],
	['live', 'live'],
	['archive', 'archived_read']
] as const;

const upsertLibrary = mapper('library_items', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into library_items (household_id, owner_user_id, title, full_title, author,
		                           url, summary, notes, entry_type, format, status,
		                           highlight_count, last_interaction_at, is_favourite,
		                           notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'},
		        ${text(row, 'Full Title')}, ${text(row, 'Author')}, ${text(row, 'URL')},
		        ${text(row, 'Summary')}, ${withBody(row, null)},
		        ${matchOption(text(row, 'Entry Type'), ENTRY_TYPE, 'reference')},
		        ${text(row, 'Format')},
		        ${matchOption(text(row, 'Status'), LIBRARY_STATUS, 'inbox')},
		        ${int(row, 'Highlights') ?? 0},
		        ${timestamp(row, 'Last Interaction')}::timestamptz,
		        ${bool(row, 'Favourite?')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive?') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			title = excluded.title,
			full_title = excluded.full_title,
			author = excluded.author,
			url = excluded.url,
			summary = excluded.summary,
			notes = excluded.notes,
			entry_type = excluded.entry_type,
			format = excluded.format,
			status = excluded.status,
			highlight_count = excluded.highlight_count,
			last_interaction_at = excluded.last_interaction_at,
			is_favourite = excluded.is_favourite,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

// ─── collections (migration 0014) ──────────────────────────────────────────

/**
 * A money amount written the way the source writes it: "CA$14.99".
 *
 * The currency and the number are separate facts. Reading the whole string as
 * a number gives NaN, and keeping it as a string means no total can ever be
 * computed — so both halves are pulled out and stored apart.
 */
function money(row: StagedRow, column: string): { amount: number | null; currency: string } {
	const raw = (row.raw[column] ?? '').trim();
	if (!raw) return { amount: null, currency: 'CAD' };

	const currency = /^([A-Z]{2,3})\s*\$/.exec(raw)?.[1];
	const digits = raw.replace(/[^0-9.]/g, '');
	const amount = digits ? Number(digits) : null;

	return {
		amount: amount !== null && Number.isFinite(amount) ? amount : null,
		// "CA$" means Canadian dollars; a bare "$" is the household's own
		// currency, which for this workspace is the same thing.
		currency: currency === 'CA' || !currency ? 'CAD' : currency
	};
}

/** "★★★★★" is a count, not a label. */
function stars(row: StagedRow, column: string): number | null {
	const raw = (row.raw[column] ?? '').trim();
	if (!raw) return null;
	const count = (raw.match(/★/g) ?? []).length;
	return count > 0 ? Math.min(count, 5) : null;
}

const PERSON_KIND = [
	['me', 'me'],
	['place', 'place'],
	['pet', 'pet'],
	['person', 'person']
] as const;

const MEDIA_TYPE = [
	['tv', 'tv'],
	['movie', 'movie']
] as const;

const MEDIA_STATUS = [
	['currently watching', 'watching'],
	['watching', 'watching'],
	['want', 'want_to_watch'],
	['paused', 'paused'],
	['dropped', 'dropped'],
	['watched', 'watched']
] as const;

const WISHLIST_STATUS = [
	['wishlist', 'wanted'],
	['bought', 'bought'],
	['purchased', 'bought'],
	['given', 'given'],
	['declined', 'declined']
] as const;

const BILL_FREQUENCY = [
	['week', 'weekly'],
	['biweek', 'biweekly'],
	['month', 'monthly'],
	['quarter', 'quarterly'],
	['annual', 'annual'],
	['year', 'annual'],
	['one', 'one_off']
] as const;

const BILL_STATUS = [
	['free trial', 'free_trial'],
	['trial', 'free_trial'],
	['paused', 'paused'],
	['cancel', 'cancelled'],
	['active', 'active'],
	['current', 'active']
] as const;

const upsertPeople = mapper('people', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into people (household_id, owner_user_id, name, kind, groups, notes,
		                    notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'},
		        ${matchOption(text(row, 'What?'), PERSON_KIND, 'person')},
		        ${multi(row, 'Groups')}::text[], ${withBody(row, null)},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive?') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name, kind = excluded.kind, groups = excluded.groups,
			notes = excluded.notes, source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertPets = mapper('people', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into people (household_id, owner_user_id, name, kind, birthday, notes,
		                    notion_page_id, source_record_id, created_by)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'}, 'pet',
		        ${date(row, 'Birthday')}, ${withBody(row, null)},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			name = excluded.name, birthday = excluded.birthday,
			notes = excluded.notes, source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertWishlist = mapper('wishlist_items', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into wishlist_items (household_id, owner_user_id, name, item_type, status,
		                            price_range, purpose, shop_source, url, occasion,
		                            is_favourite, buy_again,
		                            notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'},
		        ${text(row, 'Type')},
		        ${matchOption(text(row, 'Status'), WISHLIST_STATUS, 'wanted')},
		        ${text(row, 'Price Range')}, ${text(row, 'Purpose')},
		        ${text(row, 'Shop/Source')}, ${text(row, 'URL')}, ${text(row, 'Occasion')},
		        ${bool(row, 'Favourite')}, ${bool(row, 'Buy Again')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name, item_type = excluded.item_type, status = excluded.status,
			price_range = excluded.price_range, purpose = excluded.purpose,
			shop_source = excluded.shop_source, url = excluded.url,
			occasion = excluded.occasion, is_favourite = excluded.is_favourite,
			buy_again = excluded.buy_again, source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertMedia = mapper('media_items', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into media_items (household_id, owner_user_id, name, media_type, status,
		                         rating, genre, streaming_service, release_year,
		                         total_seasons, current_season, current_episode,
		                         times_watched, why_saved, is_favourite, watch_again,
		                         started_on, finished_on, last_watched_at,
		                         notion_page_id, source_record_id, created_by)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'},
		        ${matchOption(text(row, 'Type'), MEDIA_TYPE, 'other')},
		        ${matchOption(text(row, 'Status'), MEDIA_STATUS, 'want_to_watch')},
		        ${stars(row, '\u2b50\ufe0f Rating')},
		        ${text(row, 'Genre')}, ${text(row, 'Streaming Service')},
		        ${int(row, 'Release Year')}, ${int(row, 'Total Seasons')},
		        ${int(row, 'Current Season')}, ${int(row, 'Current Episode')},
		        ${int(row, 'Times Watched') ?? 0},
		        ${text(row, 'Why I Saved This?')},
		        ${bool(row, 'Favourite')}, ${bool(row, 'Watch Again?')},
		        ${date(row, 'Date Started')}, ${date(row, 'Date FInished')},
		        ${timestamp(row, 'Last Watched')}::timestamptz,
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			name = excluded.name, media_type = excluded.media_type, status = excluded.status,
			rating = excluded.rating, genre = excluded.genre,
			streaming_service = excluded.streaming_service,
			release_year = excluded.release_year, total_seasons = excluded.total_seasons,
			current_season = excluded.current_season, current_episode = excluded.current_episode,
			times_watched = excluded.times_watched, why_saved = excluded.why_saved,
			is_favourite = excluded.is_favourite, watch_again = excluded.watch_again,
			started_on = excluded.started_on, finished_on = excluded.finished_on,
			last_watched_at = excluded.last_watched_at,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertBills = mapper('bills', async (sql, row, o) => {
	const { amount, currency } = money(row, 'Amount');
	const [r] = await sql<{ id: string }[]>`
		insert into bills (household_id, owner_user_id, name, amount, currency, frequency,
		                   next_due_on, category, account, autopay, status,
		                   free_trial_ends_on, notes,
		                   notion_page_id, source_record_id, created_by)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'},
		        ${amount}::numeric, ${currency},
		        ${matchOption(text(row, 'Frequency'), BILL_FREQUENCY, null)},
		        ${date(row, 'Next Due')}, ${text(row, 'Category')}, ${text(row, 'Account')},
		        ${bool(row, 'Autopay?')},
		        ${matchOption(text(row, 'Status'), BILL_STATUS, 'active')},
		        ${date(row, 'Free Trial End')}, ${withBody(row, null)},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			name = excluded.name, amount = excluded.amount, currency = excluded.currency,
			frequency = excluded.frequency, next_due_on = excluded.next_due_on,
			category = excluded.category, account = excluded.account,
			autopay = excluded.autopay, status = excluded.status,
			free_trial_ends_on = excluded.free_trial_ends_on, notes = excluded.notes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

// ─── reflection (migration 0015) ───────────────────────────────────────────

const upsertAssessments = mapper('life_assessments', async (sql, row, o) => {
	const rating = int(row, 'Rate 1-10');
	// A wheel entry without a score is not an assessment of anything.
	if (rating === null || rating < 1 || rating > 10) return null;

	const [r] = await sql<{ id: string }[]>`
		insert into life_assessments (household_id, owner_user_id, visibility, focus, rating,
		                              period, year, is_priority, notes,
		                              notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, 'private', ${row.title ?? 'Untitled'},
		        ${rating}, ${text(row, 'When?')},
		        ${yearOf(row, 'Year', 'Created time')},
		        ${bool(row, 'Proritize?')}, ${withBody(row, null)},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${bool(row, 'Archive?') ? new Date().toISOString() : null}::timestamptz)
		on conflict (notion_page_id) do update set
			focus = excluded.focus, rating = excluded.rating, period = excluded.period,
			year = excluded.year, is_priority = excluded.is_priority,
			notes = excluded.notes, source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const upsertEvents = mapper('significant_events', async (sql, row, o) => {
	// "Event Date" is the day it happened; "Date" is a relation to the day's
	// own log, which the relation pass handles separately.
	const on = date(row, 'Event Date');
	if (!on) return null;

	const [r] = await sql<{ id: string }[]>`
		insert into significant_events (household_id, owner_user_id, title, on_date,
		                                is_favourite, notes,
		                                notion_page_id, source_record_id, created_by)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'}, ${on},
		        ${bool(row, 'Favourite')}, ${withBody(row, null)},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			title = excluded.title, on_date = excluded.on_date,
			is_favourite = excluded.is_favourite, notes = excluded.notes,
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
	'Daily Log Database': upsertDailyLogs,
	'Symptoms Database': vocabularyMapper('symptom'),
	'Mood Feelings Database': vocabularyMapper('mood', ['Type', 'What Helps?']),
	'Vitamins Database': vocabularyMapper('vitamin', ['Running Low']),
	'Energy Level Database': vocabularyMapper('energy', [
		'Approach',
		'Mantra',
		'Watch For:',
		'Good Tasks:',
		'What Helps?'
	]),
	'Activity Database': vocabularyMapper('activity'),
	'Exercise Database': vocabularyMapper('exercise'),
	'Ingredients Database': upsertIngredients,
	'Recipes Database': upsertRecipes,
	'Meal Plan Database': upsertMealPlans,
	'Prep Tasks Database': upsertPrepTasks,
	Library: upsertLibrary,
	'People & Places Databases': upsertPeople,
	'Pet Database': upsertPets,
	'Wishlist Database': upsertWishlist,
	'Movies & TV Database': upsertMedia,
	'Bills & Subscriptions Database': upsertBills,
	'Wheel of Life Database': upsertAssessments,
	'Highlights & Significant Events Database': upsertEvents
};

export const MAPPED_DATABASES = Object.keys(MAPPERS);
