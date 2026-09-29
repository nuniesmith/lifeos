import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate, toDateOrNull } from '../db/coerce';
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
import { logHabit, unlogHabit } from './habits';
import {
	oneOf,
	optionalId,
	optionalOneOf,
	optionalInt,
	optionalText,
	patched,
	requiredDay,
	requiredText
} from './validate';

/**
 * Routines and their steps (Routines feature pack; migration 0031).
 *
 * The source's "Habits & Routines" is two Notion databases: Routine (a named
 * sequence such as "Morning", done at a time of day) and Routine Steps (each
 * step written three times, for three energy levels, with the smallest "1%
 * day" version always there for a day when the average one is too much).
 * LifeOS already has the habits half (migration 0004, ./habits.ts); this
 * module is the routines half.
 *
 * A step is completed the same way a habit is checked in -- readable, not
 * writable, is enough (see `completeStep`) -- because a shared routine is
 * something both household members do, and doing your own run of it must not
 * depend on being the one who happens to own its definition. Editing the
 * routine's own fields or its steps is stricter, and goes through
 * `writableScope` like everywhere else a record's structure changes.
 */

// TODO: base.ts exports `atomically` once the Finance PR lands; this is a
// private copy of food.ts's version until then.
function atomically<T>(sql: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
	return ('savepoint' in sql ? sql.savepoint(fn) : sql.begin(fn)) as Promise<T>;
}

export const TIME_OF_DAY = ['morning', 'afternoon', 'evening', 'anytime'] as const;
export type TimeOfDay = (typeof TIME_OF_DAY)[number];

export const STEP_VERSIONS = ['high', 'average', 'minimal'] as const;
export type StepVersion = (typeof STEP_VERSIONS)[number];

const MOVE_DIRECTIONS = ['up', 'down'] as const;
export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

// ─── routines ───────────────────────────────────────────────────────────────

export interface RoutineRecord extends RecordBase {
	name: string;
	notes: string | null;
	timeOfDay: TimeOfDay;
	sortOrder: number;
}

interface RoutineRow extends BaseRow {
	name: string;
	notes: string | null;
	time_of_day: string;
	sort_order: unknown;
}

const TABLE = 'routines';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)}, name, notes, time_of_day, sort_order`;

function mapRoutine(row: RoutineRow): RoutineRecord {
	return {
		...mapBase(row),
		name: toText(row.name),
		notes: toTextOrNull(row.notes),
		timeOfDay: row.time_of_day as TimeOfDay,
		sortOrder: toInt(row.sort_order)
	};
}

export interface RoutineFilters extends PageOptions {
	includeArchived?: boolean;
}

export async function listRoutines(
	sql: Queryable,
	viewer: Viewer,
	filters: RoutineFilters = {}
): Promise<RoutineRecord[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<RoutineRow[]>`
		select ${columns(sql)} from routines
		where ${readableScope(sql, viewer, TABLE)}
		  and ${liveScope(sql, TABLE, filters.includeArchived)}
		order by sort_order asc, name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapRoutine);
}

export async function getRoutine(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<RoutineRecord | null> {
	const row = await getScoped<RoutineRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapRoutine(row) : null;
}

export interface RoutineInput extends OwnershipInput {
	name?: unknown;
	notes?: unknown;
	timeOfDay?: unknown;
}

export function createRoutine(
	sql: Queryable,
	viewer: Viewer,
	input: RoutineInput
): Promise<WriteResult<RoutineRecord>> {
	return guarded<RoutineRecord>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const notes = optionalText(input.notes, 'notes');
		const timeOfDay = optionalOneOf(input.timeOfDay, 'time of day', TIME_OF_DAY) ?? 'anytime';
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'household'
		});

		const rows = await sql<RoutineRow[]>`
			insert into routines (
				household_id, owner_user_id, visibility, name, notes, time_of_day,
				created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name}, ${notes},
				${timeOfDay}, ${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapRoutine(row) };
	});
}

export function updateRoutine(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: RoutineInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<RoutineRecord>> {
	return guarded<RoutineRecord>(async () => {
		const current = await getRoutine(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes')),
			timeOfDay: patched(
				patch,
				'timeOfDay',
				current.timeOfDay,
				(v) => optionalOneOf(v, 'time of day', TIME_OF_DAY) ?? current.timeOfDay
			)
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<RoutineRow, RoutineRecord>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			// This table has no updated_at trigger (only migration 0004's tables
			// do -- base.ts's header), so every update sets it by hand or a stale
			// tab's optimistic check would never actually find a conflict.
			assignments: sql`
				name = ${next.name}, notes = ${next.notes}, time_of_day = ${next.timeOfDay},
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapRoutine,
			mayWrite: writableBy(viewer)
		});
	});
}

export const setRoutineArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<RoutineRecord>> =>
	archiveScoped<RoutineRow, RoutineRecord>({
		sql,
		table: TABLE,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: columns(sql),
		map: mapRoutine
	});

export const archiveRoutine = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setRoutineArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveRoutine = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setRoutineArchived(sql, viewer, id, false, expectedUpdatedAt);

/**
 * Sets the order routines are listed in. Best-effort over the ids the viewer
 * may actually write: one outside that scope (someone else's private
 * routine, a stale id) is silently skipped rather than failing the whole
 * reorder, the same way a forged extra id in the list cannot be allowed to
 * block the ones that are genuinely the viewer's to arrange.
 */
export function reorderRoutines(
	sql: Queryable,
	viewer: Viewer,
	orderedIds: readonly string[]
): Promise<WriteResult<{ updated: number }>> {
	return guarded(async () => {
		const ids = orderedIds.filter(isUuid);
		if (ids.length === 0) return { ok: true, record: { updated: 0 } };
		const rows = await sql<{ id: string }[]>`
			update routines r
			set sort_order = v.ord - 1, updated_at = now(), updated_by = ${viewer.userId}::uuid
			from unnest(${ids}::uuid[]) with ordinality as v(id, ord)
			where r.id = v.id and ${writableScope(sql, viewer, 'r')}
			returning r.id
		`;
		return { ok: true, record: { updated: rows.length } };
	});
}

// ─── routine steps ──────────────────────────────────────────────────────────
//
// Scoped through `routines` the way `medication_doses` is scoped through
// `medications` (migration 0018): no household_id, owner or visibility of
// its own, so every function below reaches its scope by joining routines.

export interface RoutineStepRecord {
	id: string;
	routineId: string;
	position: number;
	title: string;
	highVersion: string | null;
	averageVersion: string;
	minimalVersion: string | null;
	durationMinutes: number | null;
	habitId: string | null;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string | null;
	updatedBy: string | null;
}

interface RoutineStepRow {
	id: string;
	routine_id: string;
	position: unknown;
	title: string;
	high_version: string | null;
	average_version: string;
	minimal_version: string | null;
	duration_minutes: unknown;
	habit_id: string | null;
	archived_at: unknown;
	created_at: unknown;
	updated_at: unknown;
	created_by: string | null;
	updated_by: string | null;
}

const stepColumns = (sql: Queryable): Fragment => sql`
	s.id, s.routine_id, s.position, s.title, s.high_version, s.average_version,
	s.minimal_version, s.duration_minutes, s.habit_id, s.archived_at,
	s.created_at, s.updated_at, s.created_by, s.updated_by`;

function mapStep(row: RoutineStepRow): RoutineStepRecord {
	return {
		id: row.id,
		routineId: row.routine_id,
		position: toInt(row.position),
		title: toText(row.title),
		highVersion: toTextOrNull(row.high_version),
		averageVersion: toText(row.average_version),
		minimalVersion: toTextOrNull(row.minimal_version),
		durationMinutes: toIntOrNull(row.duration_minutes),
		habitId: row.habit_id,
		archivedAt: toDateOrNull(row.archived_at),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
		createdBy: row.created_by,
		updatedBy: row.updated_by
	};
}

/**
 * The version of a step to show for an energy level, falling back to the
 * average version when the one asked for is blank.
 *
 * Pure, so the fallback rule -- the entire point of writing a step three
 * times -- is unit-tested without a database. A step someone entered with
 * only the average version filled in still reads as something on a 1% day,
 * rather than a blank line.
 */
export function resolveStepVersion(
	step: Pick<RoutineStepRecord, 'highVersion' | 'averageVersion' | 'minimalVersion'>,
	energy: StepVersion
): string {
	if (energy === 'high') return step.highVersion?.trim() ? step.highVersion : step.averageVersion;
	if (energy === 'minimal') {
		return step.minimalVersion?.trim() ? step.minimalVersion : step.averageVersion;
	}
	return step.averageVersion;
}

/**
 * Renumbers a routine's live steps to a contiguous 1..N in position order.
 *
 * Pure, so the renumbering itself is unit-tested without a database; the
 * repository (`setStepArchived`) is what writes the result back, in
 * ascending order, because that is what lets a plain sequence of one-row
 * UPDATEs close a gap without ever giving two live steps the same position
 * at once under the table's own unique index.
 */
export function compactPositions<T extends { id: string; position: number }>(
	steps: readonly T[]
): { id: string; position: number }[] {
	return [...steps]
		.sort((a, b) => a.position - b.position)
		.map((step, index) => ({ id: step.id, position: index + 1 }));
}

/** Reads a step through its routine's readable scope, for defaults and for
 *  functions that authorize the actual write themselves. Not exported: it
 *  answers "what is here", never "may this be changed". */
async function getStepScoped(
	sql: Queryable,
	viewer: Viewer,
	stepId: string
): Promise<RoutineStepRecord | null> {
	if (!isUuid(stepId)) return null;
	const rows = await sql<RoutineStepRow[]>`
		select ${stepColumns(sql)} from routine_steps s
		join routines r on r.id = s.routine_id
		where s.id = ${stepId}::uuid and ${readableScope(sql, viewer, 'r')}
	`;
	return rows[0] ? mapStep(rows[0]) : null;
}

/** A routine's live steps, in position order. Readable is enough, like
 *  completing one (see `completeStep`): both members of a shared routine see
 *  the same "do it now" list, whichever of them owns the definition. */
export async function listRoutineSteps(
	sql: Queryable,
	viewer: Viewer,
	routineId: string
): Promise<RoutineStepRecord[]> {
	if (!isUuid(routineId)) return [];
	const rows = await sql<RoutineStepRow[]>`
		select ${stepColumns(sql)} from routine_steps s
		join routines r on r.id = s.routine_id
		where s.routine_id = ${routineId}::uuid and s.archived_at is null
		  and ${readableScope(sql, viewer, 'r')}
		order by s.position asc
	`;
	return rows.map(mapStep);
}

export interface RoutineWithSteps {
	routine: RoutineRecord;
	steps: RoutineStepRecord[];
}

/** A routine together with its live steps, for the "do it now" page's load. */
export async function getRoutineWithSteps(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<RoutineWithSteps | null> {
	const routine = await getRoutine(sql, viewer, id);
	if (!routine) return null;
	const steps = await listRoutineSteps(sql, viewer, id);
	return { routine, steps };
}

export interface RoutineStepInput {
	title?: unknown;
	highVersion?: unknown;
	averageVersion?: unknown;
	minimalVersion?: unknown;
	durationMinutes?: unknown;
	habitId?: unknown;
}

/** Validates a habit reference's shape, the same way `checkArea` does in
 *  habits.ts: `optionalId` only checks it is a string, and an id that is not
 *  a well-formed uuid would otherwise reach the database as one and raise a
 *  raw driver error instead of a field-level message. */
function validatedHabitId(value: unknown): string | null {
	const id = optionalId(value, 'habit');
	if (id !== null && !isUuid(id)) throw new InvalidInput('habit is not a valid id');
	return id;
}

/**
 * Adds a step at the end of a routine.
 *
 * The routine must be the writer's, and a habit that is named must be one the
 * writer can actually read -- both checked in this one INSERT (rule: a link
 * to a habit is only ever set from a statement that also checks it can be
 * read), so a race between the two checks cannot let either be skipped.
 */
export function addStep(
	sql: Queryable,
	viewer: Viewer,
	routineId: string,
	input: RoutineStepInput
): Promise<WriteResult<RoutineStepRecord>> {
	if (!isUuid(routineId)) return Promise.resolve({ ok: false, reason: 'not_found' });

	return guarded<RoutineStepRecord>(async () => {
		const title = requiredText(input.title, 'title', 200);
		const averageVersion = requiredText(input.averageVersion, 'average version', 20_000);
		const highVersion = optionalText(input.highVersion, 'high-energy version');
		const minimalVersion = optionalText(input.minimalVersion, '1% day version');
		const durationMinutes = optionalInt(input.durationMinutes, 'duration', { min: 1 });
		const habitId = validatedHabitId(input.habitId);

		const rows = await sql<RoutineStepRow[]>`
			insert into routine_steps as s (
				routine_id, position, title, high_version, average_version, minimal_version,
				duration_minutes, habit_id, created_by, updated_by
			)
			select r.id,
			       coalesce(
			           (select max(rs.position) from routine_steps rs
			            where rs.routine_id = r.id and rs.archived_at is null),
			           0
			       ) + 1,
			       ${title}, ${highVersion}, ${averageVersion}, ${minimalVersion},
			       ${durationMinutes}::int, h.id, ${viewer.userId}::uuid, ${viewer.userId}::uuid
			from routines r
			left join habits h on h.id = ${habitId}::uuid and ${readableScope(sql, viewer, 'h')}
			where r.id = ${routineId}::uuid and ${writableScope(sql, viewer, 'r')}
			  and (${habitId}::uuid is null or h.id is not null)
			returning ${stepColumns(sql)}
		`;
		const row = rows[0];
		if (!row) {
			return { ok: false, reason: 'not_found', message: 'could not find that routine or habit' };
		}
		return { ok: true, record: mapStep(row) };
	});
}

export function updateStep(
	sql: Queryable,
	viewer: Viewer,
	stepId: string,
	patch: RoutineStepInput
): Promise<WriteResult<RoutineStepRecord>> {
	return guarded<RoutineStepRecord>(async () => {
		const current = await getStepScoped(sql, viewer, stepId);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			title: patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 200)),
			highVersion: patched(patch, 'highVersion', current.highVersion, (v) =>
				optionalText(v, 'high-energy version')
			),
			averageVersion: patched(patch, 'averageVersion', current.averageVersion, (v) =>
				requiredText(v, 'average version', 20_000)
			),
			minimalVersion: patched(patch, 'minimalVersion', current.minimalVersion, (v) =>
				optionalText(v, '1% day version')
			),
			durationMinutes: patched(patch, 'durationMinutes', current.durationMinutes, (v) =>
				optionalInt(v, 'duration', { min: 1 })
			)
		};

		// Only re-validated when the caller actually named a habit to change:
		// leaving it out of the patch must not force a fresh readability check
		// against a value that is not being touched, and must not be able to
		// clear it by accident either.
		const habitPatched = 'habitId' in patch;
		const requestedHabitId = habitPatched ? validatedHabitId(patch.habitId) : null;

		const rows = await sql<RoutineStepRow[]>`
			update routine_steps as s set
				title = ${next.title}, high_version = ${next.highVersion},
				average_version = ${next.averageVersion}, minimal_version = ${next.minimalVersion},
				duration_minutes = ${next.durationMinutes}::int,
				habit_id = case when ${habitPatched}::boolean then h.id else s.habit_id end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid
			from routines r
			left join habits h on h.id = ${requestedHabitId}::uuid and ${readableScope(sql, viewer, 'h')}
			where s.id = ${stepId}::uuid and s.routine_id = r.id and ${writableScope(sql, viewer, 'r')}
			  and (not ${habitPatched}::boolean or ${requestedHabitId}::uuid is null or h.id is not null)
			returning ${stepColumns(sql)}
		`;
		const row = rows[0];
		if (!row) {
			return { ok: false, reason: 'not_found', message: 'could not find that routine or habit' };
		}
		return { ok: true, record: mapStep(row) };
	});
}

/**
 * Swaps a step with its live neighbour, in one transaction.
 *
 * A plain two-row UPDATE cannot do this under the (routine_id, position)
 * unique index: whichever row the database happens to write first would
 * briefly hold the position its neighbour still has, and collide with it.
 * Parking the moving step on a negative position first -- guaranteed free,
 * because no live step is ever given one -- avoids that ordering hazard
 * without needing to know which row would be written first.
 */
export function moveStep(
	sql: Queryable,
	viewer: Viewer,
	stepId: string,
	direction: string
): Promise<WriteResult<RoutineStepRecord>> {
	const dir = oneOf(direction, 'direction', MOVE_DIRECTIONS);

	return guarded<RoutineStepRecord>(() =>
		atomically(sql, async (tx): Promise<WriteResult<RoutineStepRecord>> => {
			const current = await getStepScoped(tx, viewer, stepId);
			if (!current) return { ok: false, reason: 'not_found' };

			const neighbourPosition = dir === 'up' ? current.position - 1 : current.position + 1;
			const [neighbour] = await tx<{ id: string }[]>`
				select s.id from routine_steps s
				join routines r on r.id = s.routine_id
				where s.routine_id = ${current.routineId}::uuid and s.archived_at is null
				  and s.position = ${neighbourPosition}::int and ${writableScope(tx, viewer, 'r')}
			`;
			// Already first (moving up) or last (moving down): a no-op success,
			// not an error -- the button that asked for this is disabled the
			// moment the page re-reads the list.
			if (!neighbour) return { ok: true, record: current };

			const parked = await tx<{ id: string }[]>`
				update routine_steps s set position = -s.position
				from routines r
				where s.id = ${stepId}::uuid and s.routine_id = r.id and ${writableScope(tx, viewer, 'r')}
				returning s.id
			`;
			if (parked.length === 0) return { ok: false, reason: 'not_found' };

			await tx`
				update routine_steps set position = ${current.position}::int
				where id = ${neighbour.id}::uuid
			`;
			const rows = await tx<RoutineStepRow[]>`
				update routine_steps as s
				set position = ${neighbourPosition}::int, updated_at = now(),
					updated_by = ${viewer.userId}::uuid
				where s.id = ${stepId}::uuid
				returning ${stepColumns(tx)}
			`;
			const row = rows[0];
			if (!row) throw new Error('step vanished mid-move');
			return { ok: true, record: mapStep(row) };
		})
	);
}

/**
 * Archives or restores a step.
 *
 * Archiving compacts the remaining live positions back to a contiguous 1..N
 * (see `compactPositions`). Restoring appends the step at the end, the same
 * place `addStep` would put a brand new one, because its old slot is long
 * gone and may already belong to a different step.
 *
 * There is no page that restores one step by itself -- see archive.ts's
 * `NOT_IN_THE_ARCHIVE` entry for `routine_steps`, and its own comment for
 * why -- but this stays symmetric like every other `set*Archived` in this
 * codebase, rather than a one-way `archiveStep` that would make a future
 * caller invent the restore half from scratch.
 */
export function setStepArchived(
	sql: Queryable,
	viewer: Viewer,
	stepId: string,
	archived: boolean
): Promise<WriteResult<RoutineStepRecord>> {
	return guarded<RoutineStepRecord>(() =>
		atomically(sql, async (tx): Promise<WriteResult<RoutineStepRecord>> => {
			const current = await getStepScoped(tx, viewer, stepId);
			if (!current) return { ok: false, reason: 'not_found' };
			if (Boolean(current.archivedAt) === archived) return { ok: true, record: current };

			if (archived) {
				const rows = await tx<RoutineStepRow[]>`
					update routine_steps as s set archived_at = now(),
						updated_at = now(), updated_by = ${viewer.userId}::uuid
					from routines r
					where s.id = ${stepId}::uuid and s.routine_id = r.id
					  and ${writableScope(tx, viewer, 'r')}
					returning ${stepColumns(tx)}
				`;
				const row = rows[0];
				if (!row) return { ok: false, reason: 'not_found' };

				const remaining = await tx<{ id: string; position: number }[]>`
					select s.id, s.position::int from routine_steps s
					where s.routine_id = ${current.routineId}::uuid and s.archived_at is null
					order by s.position asc
				`;
				for (const target of compactPositions(remaining)) {
					await tx`
						update routine_steps set position = ${target.position}::int
						where id = ${target.id}::uuid
					`;
				}
				return { ok: true, record: mapStep(row) };
			}

			const rows = await tx<RoutineStepRow[]>`
				update routine_steps as s set archived_at = null,
					position = coalesce(
					    (select max(rs.position) from routine_steps rs
					     where rs.routine_id = s.routine_id and rs.archived_at is null),
					    0
					) + 1,
					updated_at = now(), updated_by = ${viewer.userId}::uuid
				from routines r
				where s.id = ${stepId}::uuid and s.routine_id = r.id
				  and ${writableScope(tx, viewer, 'r')}
				returning ${stepColumns(tx)}
			`;
			const row = rows[0];
			if (!row) return { ok: false, reason: 'not_found' };
			return { ok: true, record: mapStep(row) };
		})
	);
}

// ─── routine step completions ───────────────────────────────────────────────

export interface RoutineStepCompletionRecord {
	id: string;
	stepId: string;
	userId: string;
	completedOn: string;
	version: StepVersion;
	createdAt: Date;
}

interface RoutineStepCompletionRow {
	id: string;
	step_id: string;
	user_id: string;
	completed_on: string;
	version: string;
	created_at: unknown;
}

const completionColumns = (sql: Queryable): Fragment =>
	sql`id, step_id, user_id, completed_on::text as completed_on, version, created_at`;

function mapCompletion(row: RoutineStepCompletionRow): RoutineStepCompletionRecord {
	return {
		id: row.id,
		stepId: row.step_id,
		userId: row.user_id,
		completedOn: toDay(row.completed_on),
		version: row.version as StepVersion,
		createdAt: toDate(row.created_at)
	};
}

/**
 * Marks a step done for a day, with the version that was actually used.
 *
 * Readable is enough to complete a step, the same as `logHabit`: a shared
 * routine is something both members do, and doing your own run of it must
 * not depend on being the one who happens to own the routine's definition.
 *
 * When the step names a habit, that habit's own check-in is recorded too, in
 * the same transaction, with the existing `logHabit` from habits.ts -- one
 * tap on the routine is one fact about the habit as well, not two separate
 * ones a person has to remember to keep in sync. If the habit is no longer
 * readable by this viewer (made private after the two were linked, say),
 * `logHabit` itself returns `not_found` rather than throwing, and that
 * outcome is deliberately ignored here: the step's own completion must not
 * fail merely because the habit behind it changed visibility.
 * `uncompleteStep` mirrors this with `unlogHabit`, which already no-ops the
 * same way for the same reason.
 */
export function completeStep(
	sql: Queryable,
	viewer: Viewer,
	stepId: string,
	day: string,
	version: string
): Promise<WriteResult<RoutineStepCompletionRecord>> {
	if (!isUuid(stepId)) return Promise.resolve({ ok: false, reason: 'not_found' });

	return guarded<RoutineStepCompletionRecord>(() =>
		atomically(sql, async (tx): Promise<WriteResult<RoutineStepCompletionRecord>> => {
			const completedOn = requiredDay(day, 'date');
			const ver = oneOf(version, 'version', STEP_VERSIONS);

			const rows = await tx<RoutineStepCompletionRow[]>`
				insert into routine_step_completions (step_id, user_id, completed_on, version)
				select s.id, ${viewer.userId}::uuid, ${completedOn}::date, ${ver}
				from routine_steps s
				join routines r on r.id = s.routine_id
				where s.id = ${stepId}::uuid and s.archived_at is null
				  and ${readableScope(tx, viewer, 'r')}
				on conflict (step_id, user_id, completed_on) do update set version = excluded.version
				returning ${completionColumns(tx)}
			`;
			const row = rows[0];
			if (!row) return { ok: false, reason: 'not_found' };

			const [step] = await tx<{ habit_id: string | null }[]>`
				select habit_id from routine_steps where id = ${stepId}::uuid
			`;
			if (step?.habit_id) {
				await logHabit(tx, viewer, { habitId: step.habit_id, onDate: completedOn, completed: true });
			}

			return { ok: true, record: mapCompletion(row) };
		})
	);
}

/** Undoes a completion, and the habit check-in that came with it if any.
 *  Missing is success either way -- the day ends up undone, which is what
 *  was asked for, the same idempotence `unlogHabit` itself already has. */
export function uncompleteStep(
	sql: Queryable,
	viewer: Viewer,
	stepId: string,
	day: string
): Promise<boolean> {
	if (!isUuid(stepId)) return Promise.resolve(false);

	return atomically(sql, async (tx) => {
		const completedOn = requiredDay(day, 'date');
		const rows = await tx<{ habit_id: string | null }[]>`
			delete from routine_step_completions c
			using routine_steps s, routines r
			where c.step_id = s.id and s.routine_id = r.id
			  and c.step_id = ${stepId}::uuid and c.user_id = ${viewer.userId}::uuid
			  and c.completed_on = ${completedOn}::date and ${readableScope(tx, viewer, 'r')}
			returning s.habit_id
		`;
		const row = rows[0];
		if (!row) return false;
		if (row.habit_id) await unlogHabit(tx, viewer, row.habit_id, completedOn);
		return true;
	});
}

/**
 * How many of a routine's live steps are done for a day, per routine, in one
 * round trip -- the `recentDosesFor`/`summariseMany` discipline of one query
 * for a whole list rather than one per row.
 */
export async function routineStepProgress(
	sql: Queryable,
	viewer: Viewer,
	routineIds: readonly string[],
	userId: string,
	day: string
): Promise<Map<string, { done: number; total: number }>> {
	const ids = [...new Set(routineIds.filter(isUuid))];
	const progress = new Map<string, { done: number; total: number }>();
	if (ids.length === 0) return progress;

	const rows = await sql<{ routine_id: string; done: number; total: number }[]>`
		select s.routine_id,
		       count(c.id)::int as done,
		       count(s.id)::int as total
		from routine_steps s
		join routines r on r.id = s.routine_id
		left join routine_step_completions c
		       on c.step_id = s.id and c.user_id = ${userId}::uuid and c.completed_on = ${day}::date
		where s.routine_id = any(${ids}::uuid[]) and s.archived_at is null
		  and ${readableScope(sql, viewer, 'r')}
		group by s.routine_id
	`;
	for (const row of rows) progress.set(row.routine_id, { done: row.done, total: row.total });
	return progress;
}

/** Which version of each of a routine's steps this viewer already did on a
 *  day, for the "do it now" page's completed-state display. */
export async function stepCompletionsOn(
	sql: Queryable,
	viewer: Viewer,
	routineId: string,
	userId: string,
	day: string
): Promise<Map<string, StepVersion>> {
	if (!isUuid(routineId)) return new Map();
	const rows = await sql<{ step_id: string; version: string }[]>`
		select c.step_id, c.version
		from routine_step_completions c
		join routine_steps s on s.id = c.step_id
		join routines r on r.id = s.routine_id
		where s.routine_id = ${routineId}::uuid and c.user_id = ${userId}::uuid
		  and c.completed_on = ${day}::date and ${readableScope(sql, viewer, 'r')}
	`;
	return new Map(rows.map((row) => [row.step_id, row.version as StepVersion]));
}
