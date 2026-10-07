import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate } from '../db/coerce';
import {
	InvalidInput,
	archiveScoped,
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
	toDay,
	toInt,
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
import { periodKey, periodsBetween, previousPeriod, type Period, type WeekStart } from './dates';
import {
	optionalBool,
	optionalId,
	optionalInt,
	optionalOneOf,
	optionalText,
	patched,
	requiredDay,
	requiredText
} from './validate';

/**
 * Habits and their daily logs (MODEL-003; reworked to drop streaks in
 * migration 0038).
 *
 * Kayla deliberately moved the habit system away from streaks: "Missing once
 * is normal. The important behaviour is returning." So nothing here counts a
 * current or longest run any more. What replaced it is the same kind of fact
 * a streak was — never stored, worked out fresh from the logs each time,
 * because a stored counter is a second copy that goes wrong the first time a
 * log is backfilled or corrected, which is exactly what people do with habit
 * trackers. `lastLoggedOn` says when the habit was last logged; `planTheReturn`
 * says only whether the most recently COMPLETED period — never the one still
 * running, and never compared against the target — had no check-in at all.
 * The arithmetic below is pure and unit-tested; the database only supplies
 * the days.
 */

export const HABIT_PERIODS = ['day', 'week', 'month'] as const;

export interface HabitRecord extends RecordBase {
	name: string;
	description: string | null;
	areaId: string | null;
	targetCount: number;
	targetPeriod: Period;
	active: boolean;
}

interface HabitRow extends BaseRow {
	name: string;
	description: string | null;
	area_id: string | null;
	target_count: unknown;
	target_period: string;
	active: unknown;
}

const TABLE = 'habits';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, description, area_id, target_count, target_period, active`;

function mapHabit(row: HabitRow): HabitRecord {
	return {
		...mapBase(row),
		name: toText(row.name),
		description: toTextOrNull(row.description),
		areaId: row.area_id,
		targetCount: toInt(row.target_count),
		targetPeriod: row.target_period as Period,
		active: toBool(row.active)
	};
}

// ─── habits ────────────────────────────────────────────────────────────────

export interface HabitFilters extends PageOptions {
	activeOnly?: boolean;
	areaId?: string;
	ownerUserId?: string | null;
	search?: string;
	includeArchived?: boolean;
}

function habitConditions(sql: Queryable, viewer: Viewer, filters: HabitFilters): Fragment {
	const parts: Fragment[] = [
		readableScope(sql, viewer, TABLE),
		liveScope(sql, TABLE, filters.includeArchived)
	];
	if (filters.activeOnly) parts.push(sql`active = true`);
	if (filters.areaId) parts.push(sql`area_id = ${filters.areaId}::uuid`);
	if (filters.ownerUserId !== undefined) {
		parts.push(
			filters.ownerUserId === null
				? sql`owner_user_id is null`
				: sql`owner_user_id = ${filters.ownerUserId}::uuid`
		);
	}
	if (filters.search?.trim()) parts.push(sql`name ilike ${`%${filters.search.trim()}%`}`);
	return parts.reduce((all, part) => sql`${all} and ${part}`);
}

export async function listHabits(
	sql: Queryable,
	viewer: Viewer,
	filters: HabitFilters = {}
): Promise<HabitRecord[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<HabitRow[]>`
		select ${columns(sql)} from habits
		where ${habitConditions(sql, viewer, filters)}
		order by name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapHabit);
}

export async function getHabit(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<HabitRecord | null> {
	const row = await getScoped<HabitRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapHabit(row) : null;
}

export interface HabitInput extends OwnershipInput {
	name?: unknown;
	description?: unknown;
	areaId?: unknown;
	targetCount?: unknown;
	targetPeriod?: unknown;
	active?: unknown;
}

async function checkArea(sql: Queryable, viewer: Viewer, areaId: string | null): Promise<void> {
	if (areaId === null) return;
	if (!isUuid(areaId)) throw new InvalidInput('area is not a valid id');
	const found = await getScoped<{ id: string }>(
		sql,
		'areas',
		areaId,
		readableScope(sql, viewer, 'areas'),
		sql`id`
	);
	if (!found) throw new InvalidInput('area was not found');
}

export function createHabit(
	sql: Queryable,
	viewer: Viewer,
	input: HabitInput
): Promise<WriteResult<HabitRecord>> {
	return guarded<HabitRecord>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const areaId = optionalId(input.areaId, 'area');
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'household'
		});
		await checkArea(sql, viewer, areaId);

		const rows = await sql<HabitRow[]>`
			insert into habits (
				household_id, owner_user_id, visibility, name, description, area_id,
				target_count, target_period, active, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${optionalText(input.description, 'description')}, ${areaId}::uuid,
				${optionalInt(input.targetCount, 'target', { min: 1 }) ?? 1}::int,
				${optionalOneOf(input.targetPeriod, 'period', HABIT_PERIODS) ?? 'day'},
				${optionalBool(input.active, 'active') ?? true}::boolean,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapHabit(row) };
	});
}

export function updateHabit(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: HabitInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<HabitRecord>> {
	return guarded<HabitRecord>(async () => {
		const current = await getHabit(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			description: patched(patch, 'description', current.description, (v) =>
				optionalText(v, 'description')
			),
			areaId: patched(patch, 'areaId', current.areaId, (v) => optionalId(v, 'area')),
			targetCount: patched(
				patch,
				'targetCount',
				current.targetCount,
				(v) => optionalInt(v, 'target', { min: 1 }) ?? 1
			),
			targetPeriod: patched(
				patch,
				'targetPeriod',
				current.targetPeriod,
				(v) => optionalOneOf(v, 'period', HABIT_PERIODS) ?? current.targetPeriod
			),
			active: patched(patch, 'active', current.active, (v) => optionalBool(v, 'active') ?? true)
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});
		if (next.areaId !== current.areaId) await checkArea(sql, viewer, next.areaId);

		return writeScoped<HabitRow, HabitRecord>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`
				name = ${next.name},
				description = ${next.description},
				area_id = ${next.areaId}::uuid,
				target_count = ${next.targetCount}::int,
				target_period = ${next.targetPeriod},
				active = ${next.active}::boolean,
				owner_user_id = ${ownership.ownerUserId}::uuid,
				visibility = ${ownership.visibility},
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapHabit,
			mayWrite: writableBy(viewer)
		});
	});
}

export const setHabitArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<HabitRecord>> =>
	archiveScoped<HabitRow, HabitRecord>({
		sql,
		table: TABLE,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: columns(sql),
		map: mapHabit
	});

export const archiveHabit = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setHabitArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveHabit = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setHabitArchived(sql, viewer, id, false, expectedUpdatedAt);

// ─── habit logs ────────────────────────────────────────────────────────────

export interface HabitLogRecord {
	id: string;
	habitId: string;
	userId: string;
	onDate: string;
	completed: boolean;
	note: string | null;
	createdAt: Date;
}

interface HabitLogRow {
	id: string;
	habit_id: string;
	user_id: string;
	on_date: string;
	completed: unknown;
	note: string | null;
	created_at: unknown;
}

const mapLog = (row: HabitLogRow): HabitLogRecord => ({
	id: row.id,
	habitId: row.habit_id,
	userId: row.user_id,
	onDate: toDay(row.on_date),
	completed: toBool(row.completed),
	note: toTextOrNull(row.note),
	createdAt: toDate(row.created_at)
});

const logColumns = (sql: Queryable): Fragment =>
	sql`id, habit_id, user_id, on_date::text as on_date, completed, note, created_at`;

/**
 * Records a check-in, for the viewer and nobody else.
 *
 * `habit_logs` carries no visibility of its own, so the habit's own
 * readability is the gate — and it is applied by selecting *through* the
 * habits table rather than by checking first and inserting after. A habit in
 * another household matches nothing, so the insert writes nothing.
 *
 * Idempotent by (habit, user, day), which is a database constraint rather than
 * something the application has to remember. That is also why there is no
 * version precondition here: checking a box twice is not a conflict.
 */
export function logHabit(
	sql: Queryable,
	viewer: Viewer,
	input: { habitId: string; onDate: string; completed?: boolean; note?: unknown }
): Promise<WriteResult<HabitLogRecord>> {
	return guarded<HabitLogRecord>(async () => {
		const onDate = requiredDay(input.onDate, 'date');
		if (!isUuid(input.habitId)) return { ok: false, reason: 'not_found' };

		const rows = await sql<HabitLogRow[]>`
			insert into habit_logs (habit_id, user_id, on_date, completed, note)
			select h.id, ${viewer.userId}::uuid, ${onDate}::date,
			       ${input.completed ?? true}::boolean, ${optionalText(input.note, 'note', 2000)}
			from habits h
			where h.id = ${input.habitId}::uuid
			  and h.archived_at is null
			  and ${readableScope(sql, viewer, 'h')}
			on conflict (habit_id, user_id, on_date) do update
				set completed = excluded.completed, note = excluded.note
			returning ${logColumns(sql)}
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'not_found' };
		return { ok: true, record: mapLog(row) };
	});
}

/**
 * Records a check-in only if the day has none yet, and says whether it did.
 *
 * For a check-in made on someone's behalf -- a routine step linked to this
 * habit -- rather than by the person on /habits. `logHabit`'s upsert would
 * overwrite a check-in they already made (clearing its note), so this
 * inserts or does nothing. The `true` it returns is what lets the caller
 * undo exactly the check-in it made, and never one it didn't. Readability is
 * gated the same way `logHabit` gates it, through the habits table in the
 * same statement.
 */
export async function logHabitIfAbsent(
	sql: Queryable,
	viewer: Viewer,
	input: { habitId: string; onDate: string }
): Promise<boolean> {
	if (!isUuid(input.habitId)) return false;
	const onDate = requiredDay(input.onDate, 'date');
	const rows = await sql<{ id: string }[]>`
		insert into habit_logs (habit_id, user_id, on_date, completed)
		select h.id, ${viewer.userId}::uuid, ${onDate}::date, true
		from habits h
		where h.id = ${input.habitId}::uuid
		  and h.archived_at is null
		  and ${readableScope(sql, viewer, 'h')}
		on conflict (habit_id, user_id, on_date) do nothing
		returning id
	`;
	return rows.length > 0;
}

/** Removes a check-in. Missing is success: the day ends up unlogged either way. */
export async function unlogHabit(
	sql: Queryable,
	viewer: Viewer,
	habitId: string,
	onDate: string
): Promise<boolean> {
	if (!isUuid(habitId)) return false;
	const rows = await sql<{ id: string }[]>`
		delete from habit_logs hl
		using habits h
		where hl.habit_id = h.id
		  and hl.habit_id = ${habitId}::uuid
		  and hl.user_id = ${viewer.userId}::uuid
		  and hl.on_date = ${requiredDay(onDate, 'date')}::date
		  and ${readableScope(sql, viewer, 'h')}
		returning hl.id
	`;
	return rows.length > 0;
}

export async function listHabitLogs(
	sql: Queryable,
	viewer: Viewer,
	habitId: string,
	range: { from: string; to: string; userId?: string }
): Promise<HabitLogRecord[]> {
	if (!isUuid(habitId)) return [];
	const rows = await sql<HabitLogRow[]>`
		select ${logColumns(sql)} from habit_logs hl
		where hl.habit_id = ${habitId}::uuid
		  and hl.user_id = ${range.userId ?? viewer.userId}::uuid
		  and hl.on_date between ${requiredDay(range.from, 'from')}::date
		                     and ${requiredDay(range.to, 'to')}::date
		  and exists (
		      select 1 from habits h
		      where h.id = hl.habit_id and ${readableScope(sql, viewer, 'h')}
		  )
		order by hl.on_date asc
	`;
	return rows.map(mapLog);
}

// ─── streaks and completion ────────────────────────────────────────────────

export interface HabitPeriodSummary {
	/** The first day of the period, which is its identity. */
	key: string;
	completed: number;
	target: number;
	met: boolean;
}

export interface HabitSummary {
	habitId: string;
	userId: string;
	period: Period;
	target: number;
	from: string;
	to: string;
	/** Check-ins inside the window. */
	completedCount: number;
	/** Periods in the window multiplied by the target. */
	expectedCount: number;
	/** 0..1, capped: overshooting a target does not read as more than done. */
	completionRate: number;
	periodsMet: number;
	periods: HabitPeriodSummary[];
	/** The most recent day logged, at or before `today`; null if never. */
	lastLoggedOn: string | null;
	/**
	 * Whether the period immediately before the one containing `today` — the
	 * most recent one that has actually finished — had no check-in at all.
	 * Never the current, still-running period, and never a comparison
	 * against the target: one check-in out of three is still someone coming
	 * back, which is the whole point of dropping the streak.
	 */
	planTheReturn: boolean;
}

export interface SummariseInput {
	completedDays: readonly string[];
	period: Period;
	target: number;
	from: string;
	to: string;
	today: string;
	weekStartsOn?: WeekStart;
}

/**
 * Turns a set of completed days into completion and return-nudge numbers.
 *
 * Pure, so the rules are testable without a database. Two of them are
 * judgements worth stating:
 *
 *  - **An unfinished current period never prompts a return.** Asking at
 *    breakfast whether today is done and being told to "plan the return" is
 *    both wrong and discouraging. Only the period immediately before the one
 *    containing `today` — the most recent one that has actually finished —
 *    is asked about.
 *  - **Any log counts, regardless of the target.** A week that fell short of
 *    its target of three is still a week the household came back to, so
 *    `planTheReturn` asks only whether the prior period's count is zero, not
 *    whether it met `target` — that comparison is what `periodsMet` is for.
 */
export function summariseHabit(input: SummariseInput): Omit<HabitSummary, 'habitId' | 'userId'> {
	const { period, target, from, to, today } = input;
	const weekStartsOn = input.weekStartsOn ?? 1;

	const counts = new Map<string, number>();
	for (const day of input.completedDays) {
		const key = periodKey(day, period, weekStartsOn);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const windowKeys = periodsBetween(from, to, period, weekStartsOn);
	const periods: HabitPeriodSummary[] = windowKeys.map((key) => {
		const completed = counts.get(key) ?? 0;
		return { key, completed, target, met: completed >= target };
	});

	const completedCount = input.completedDays.filter((day) => day >= from && day <= to).length;
	const expectedCount = windowKeys.length * target;

	// The most recently logged day at or before today, from the FULL history
	// `completedDays` carries — not clipped to [from, to], because a window
	// of a single day must still be able to say "three days ago" rather than
	// only ever "" or "today".
	const lastLoggedOn = input.completedDays.reduce<string | null>(
		(latest, day) => (day <= today && (latest === null || day > latest) ? day : latest),
		null
	);

	// Plan the return: the period right before the one containing today —
	// never the current one, which is still running — had zero check-ins,
	// AND there is real history older than that period to have returned to.
	// Without the second half, a habit younger than its own "most recent
	// full period" reads as having missed one: it simply did not exist yet,
	// which is not a return anybody needs prompting to make. Logging a
	// brand-new habit for the first time today must not open on this nudge.
	const currentKey = periodKey(today, period, weekStartsOn);
	const previousKey = previousPeriod(currentKey, period);
	const hasOlderHistory = input.completedDays.some((day) => day < previousKey);
	const planTheReturn = hasOlderHistory && (counts.get(previousKey) ?? 0) === 0;

	return {
		period,
		target,
		from,
		to,
		completedCount,
		expectedCount,
		completionRate: expectedCount === 0 ? 0 : Math.min(1, completedCount / expectedCount),
		periodsMet: periods.filter((p) => p.met).length,
		periods,
		lastLoggedOn,
		planTheReturn
	};
}

export interface HabitSummaryOptions {
	from: string;
	to: string;
	today: string;
	weekStartsOn?: WeekStart;
	/** Whose check-ins to count. Defaults to the viewer's own. */
	userId?: string;
	/** How far back to look for the streak, beyond the reported window. */
	streakLookbackDays?: number;
}

/** Completion and streak for one habit, or null if the viewer cannot see it. */
export async function habitSummary(
	sql: Queryable,
	viewer: Viewer,
	habitId: string,
	options: HabitSummaryOptions
): Promise<HabitSummary | null> {
	const habit = await getHabit(sql, viewer, habitId);
	if (!habit) return null;
	const [summary] = await summariseMany(sql, viewer, [habit], options);
	return summary ?? null;
}

/**
 * The same numbers for every habit at once, in two queries rather than two per
 * habit. The check-in screen shows the whole list, so the loop belongs here.
 */
export async function habitSummaries(
	sql: Queryable,
	viewer: Viewer,
	options: HabitSummaryOptions & { filters?: HabitFilters }
): Promise<HabitSummary[]> {
	const habits = await listHabits(sql, viewer, options.filters ?? { activeOnly: true });
	return summariseMany(sql, viewer, habits, options);
}

async function summariseMany(
	sql: Queryable,
	viewer: Viewer,
	habits: HabitRecord[],
	options: HabitSummaryOptions
): Promise<HabitSummary[]> {
	if (habits.length === 0) return [];
	const userId = options.userId ?? viewer.userId;
	const lookback = options.streakLookbackDays ?? 400;

	const rows = await sql<{ habit_id: string; on_date: string }[]>`
		select hl.habit_id, hl.on_date::text as on_date
		from habit_logs hl
		join habits h on h.id = hl.habit_id
		where hl.habit_id in ${sql(habits.map((h) => h.id))}
		  and hl.user_id = ${userId}::uuid
		  and hl.completed = true
		  and hl.on_date >= (${options.to}::date - ${lookback}::int)
		  and hl.on_date <= ${options.to}::date
		  and ${readableScope(sql, viewer, 'h')}
		order by hl.on_date asc
	`;

	const byHabit = new Map<string, string[]>();
	for (const row of rows) {
		const days = byHabit.get(row.habit_id) ?? [];
		days.push(toDay(row.on_date));
		byHabit.set(row.habit_id, days);
	}

	return habits.map((habit) => ({
		habitId: habit.id,
		userId,
		...summariseHabit({
			completedDays: byHabit.get(habit.id) ?? [],
			period: habit.targetPeriod,
			target: habit.targetCount,
			from: options.from,
			to: options.to,
			today: options.today,
			weekStartsOn: options.weekStartsOn
		})
	}));
}
