import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
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
import { toDate, toDateOrNull } from '../db/coerce';
import { addDays, dayOfWeek } from './dates';
import {
	oneOf,
	optionalDay,
	optionalInt,
	optionalOneOf,
	optionalText,
	patched,
	requiredDay,
	requiredText
} from './validate';

/**
 * Medications & supplements (MODEL-002, feature pack 3; migration 0018).
 *
 * The source calls this "Vitamins & Medications": one Notion database of 23
 * items, each with its own type, dose, brand and schedule, plus a "Log Today"
 * button. It used to import as a seventh `health_vocabulary` kind, which had
 * nowhere to put any of that — only the name and a "Running Low" flag
 * survived. This module owns the real model: a medication is a record with a
 * dose and a schedule, not a label, and logging one is a fact about a
 * medication and a day, not about a journal entry.
 *
 * `medication_doses` is deliberately not scoped to `daily_logs` the way
 * `daily_log_health` is: taking the morning pills should not first require
 * writing a journal entry, and the source's own `Log Today` button works
 * whether or not that day's Daily Log page exists.
 *
 * Five of the source's columns are Notion formulas and are recomputed here
 * rather than stored, so they cannot go stale: `Due Today?` and `Next Due`
 * are {@link computeDueStatus}, `Last Taken` is a dose row's own `on_date`,
 * `Times Logged` is `recentDosesFor`'s row count, and `Medication Display` is
 * a presentation concern for the route. `Dates Logged` looks like data but is
 * a rollup of the same relation `medication_doses` now stores directly, so it
 * is not read either.
 */

export const MEDICATION_TYPES = [
	'prescription',
	'supplement',
	'vitamin',
	'electrolyte',
	'otc'
] as const;
export type MedicationType = (typeof MEDICATION_TYPES)[number];

export const SCHEDULE_KINDS = ['daily_am', 'daily_pm', 'scheduled', 'as_needed'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const MEDICATION_STATUSES = ['taking', 'paused'] as const;
export type MedicationStatus = (typeof MEDICATION_STATUSES)[number];

export interface Medication extends RecordBase {
	name: string;
	type: MedicationType;
	dose: string | null;
	unit: string | null;
	brand: string | null;
	scheduleKind: ScheduleKind;
	/** 0 = Sunday, matching `dayOfWeek`. Only meaningful when `scheduled`. */
	scheduledWeekday: number | null;
	/** Only meaningful when `scheduled`; never set alongside `scheduledWeekday`. */
	intervalDays: number | null;
	startDate: string | null;
	endDate: string | null;
	status: MedicationStatus;
	runningLow: boolean;
	notes: string | null;
	attributes: Record<string, unknown>;
}

interface MedicationRow extends BaseRow {
	name: string;
	type: string;
	dose: string | null;
	unit: string | null;
	brand: string | null;
	schedule_kind: string;
	scheduled_weekday: unknown;
	interval_days: unknown;
	start_date: string | null;
	end_date: string | null;
	status: string;
	running_low: unknown;
	notes: string | null;
	attributes: unknown;
}

const TABLE = 'medications';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, type, dose, unit, brand, schedule_kind, scheduled_weekday, interval_days,
	start_date::text as start_date, end_date::text as end_date, status, running_low,
	notes, attributes`;

function mapMedication(row: MedicationRow): Medication {
	return {
		...mapBase(row),
		name: toText(row.name),
		type: row.type as MedicationType,
		dose: toTextOrNull(row.dose),
		unit: toTextOrNull(row.unit),
		brand: toTextOrNull(row.brand),
		scheduleKind: row.schedule_kind as ScheduleKind,
		scheduledWeekday: toIntOrNull(row.scheduled_weekday),
		intervalDays: toIntOrNull(row.interval_days),
		startDate: row.start_date ? toDay(row.start_date) : null,
		endDate: row.end_date ? toDay(row.end_date) : null,
		status: row.status as MedicationStatus,
		runningLow: toBool(row.running_low),
		notes: toTextOrNull(row.notes),
		// Same defensive read as `health_vocabulary.attributes`: jsonb arrives
		// parsed, but a string is what a double-encoded write would produce.
		attributes:
			row.attributes && typeof row.attributes === 'object'
				? (row.attributes as Record<string, unknown>)
				: {}
	};
}

// ─── reading ────────────────────────────────────────────────────────────────

export interface MedicationFilters extends PageOptions {
	scheduleKind?: ScheduleKind | readonly ScheduleKind[];
	type?: MedicationType | readonly MedicationType[];
	search?: string;
	includeArchived?: boolean;
	order?: 'name' | 'schedule';
}

export async function listMedications(
	sql: Queryable,
	viewer: Viewer,
	filters: MedicationFilters = {}
): Promise<Medication[]> {
	const { limit, offset } = pageOf(filters);
	const schedules = filters.scheduleKind
		? Array.isArray(filters.scheduleKind)
			? filters.scheduleKind
			: [filters.scheduleKind as ScheduleKind]
		: null;
	const types = filters.type
		? Array.isArray(filters.type)
			? filters.type
			: [filters.type as MedicationType]
		: null;

	const rows = await sql<MedicationRow[]>`
		select ${columns(sql)} from ${sql(TABLE)}
		where ${readableScope(sql, viewer, TABLE)}
		  and ${liveScope(sql, TABLE, filters.includeArchived)}
		  ${schedules ? sql`and schedule_kind in ${sql([...schedules])}` : sql``}
		  ${types ? sql`and type in ${sql([...types])}` : sql``}
		  ${filters.search ? sql`and name ilike ${'%' + filters.search.trim() + '%'}` : sql``}
		order by ${filters.order === 'schedule' ? sql`schedule_kind asc, name asc` : sql`name asc`}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapMedication);
}

export async function getMedication(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<Medication | null> {
	const row = await getScoped<MedicationRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapMedication(row) : null;
}

// ─── writing ────────────────────────────────────────────────────────────────

export interface MedicationInput extends OwnershipInput {
	name?: unknown;
	type?: unknown;
	dose?: unknown;
	unit?: unknown;
	brand?: unknown;
	scheduleKind?: unknown;
	scheduledWeekday?: unknown;
	intervalDays?: unknown;
	startDate?: unknown;
	endDate?: unknown;
	status?: unknown;
	runningLow?: unknown;
	notes?: unknown;
}

/**
 * Validates the weekday/interval pair against the schedule kind, mirroring
 * the two table-level CHECK constraints in migration 0018 so a bad
 * combination is a field-level message rather than a 500 from the database.
 */
function normalizeSchedule(
	scheduleKind: ScheduleKind,
	weekdayInput: unknown,
	intervalInput: unknown
): { scheduledWeekday: number | null; intervalDays: number | null } {
	const scheduledWeekday = optionalInt(weekdayInput, 'scheduled weekday', { min: 0, max: 6 });
	const intervalDays = optionalInt(intervalInput, 'interval (days)', { min: 1 });

	if (scheduledWeekday !== null && intervalDays !== null) {
		throw new InvalidInput('choose a scheduled weekday or an interval of days, not both');
	}
	if (scheduleKind !== 'scheduled' && (scheduledWeekday !== null || intervalDays !== null)) {
		throw new InvalidInput('a weekday or an interval only applies to a scheduled medication');
	}
	return { scheduledWeekday, intervalDays };
}

const runningLowFrom = (value: unknown): boolean => value === true || value === 'on';

export function createMedication(
	sql: Queryable,
	viewer: Viewer,
	input: MedicationInput
): Promise<WriteResult<Medication>> {
	return guarded<Medication>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const type = oneOf(input.type, 'type', MEDICATION_TYPES);
		const scheduleKind =
			input.scheduleKind === undefined
				? 'as_needed'
				: oneOf(input.scheduleKind, 'schedule', SCHEDULE_KINDS);
		const schedule = normalizeSchedule(scheduleKind, input.scheduledWeekday, input.intervalDays);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		// NOT EXISTS rather than a unique index, for the reason migration 0016
		// gives: a duplicated name must tell the person typing it, not abort an
		// import — the importer upserts by `notion_page_id` and never calls this.
		const rows = await sql<MedicationRow[]>`
			insert into ${sql(TABLE)} (
				household_id, owner_user_id, visibility, name, type, dose, unit, brand,
				schedule_kind, scheduled_weekday, interval_days, start_date, end_date,
				status, running_low, notes, created_by, updated_by
			)
			select ${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name}, ${type},
				${optionalText(input.dose, 'dose', 100)}, ${optionalText(input.unit, 'unit', 50)},
				${optionalText(input.brand, 'brand', 200)},
				${scheduleKind}, ${schedule.scheduledWeekday}::int, ${schedule.intervalDays}::int,
				${optionalDay(input.startDate, 'start date')}::date,
				${optionalDay(input.endDate, 'end date')}::date,
				${optionalOneOf(input.status, 'status', MEDICATION_STATUSES) ?? 'taking'},
				${runningLowFrom(input.runningLow)}::boolean,
				${optionalText(input.notes, 'notes')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			where not exists (
				select 1 from ${sql(TABLE)} existing
				where existing.household_id = ${viewer.householdId}::uuid
				  and lower(trim(existing.name)) = lower(trim(${name}))
				  and existing.archived_at is null
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row)
			return { ok: false, reason: 'invalid', message: 'that medication is already on the list' };
		return { ok: true, record: mapMedication(row) };
	});
}

export function updateMedication(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: MedicationInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Medication>> {
	return guarded<Medication>(async () => {
		const current = await getMedication(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			type: patched(patch, 'type', current.type, (v) => oneOf(v, 'type', MEDICATION_TYPES)),
			dose: patched(patch, 'dose', current.dose, (v) => optionalText(v, 'dose', 100)),
			unit: patched(patch, 'unit', current.unit, (v) => optionalText(v, 'unit', 50)),
			brand: patched(patch, 'brand', current.brand, (v) => optionalText(v, 'brand', 200)),
			scheduleKind: patched(patch, 'scheduleKind', current.scheduleKind, (v) =>
				oneOf(v, 'schedule', SCHEDULE_KINDS)
			),
			startDate: patched(patch, 'startDate', current.startDate, (v) =>
				optionalDay(v, 'start date')
			),
			endDate: patched(patch, 'endDate', current.endDate, (v) => optionalDay(v, 'end date')),
			status: patched(patch, 'status', current.status, (v) =>
				oneOf(v, 'status', MEDICATION_STATUSES)
			),
			runningLow: patched(patch, 'runningLow', current.runningLow, runningLowFrom),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};
		// Read together and re-validated as a pair, even when only one of the two
		// was actually patched, so a stray weekday cannot survive a schedule
		// change away from `scheduled` by never being mentioned.
		const schedule = normalizeSchedule(
			next.scheduleKind,
			'scheduledWeekday' in patch ? patch.scheduledWeekday : current.scheduledWeekday,
			'intervalDays' in patch ? patch.intervalDays : current.intervalDays
		);
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<MedicationRow, Medication>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`
				name = ${next.name}, type = ${next.type}, dose = ${next.dose}, unit = ${next.unit},
				brand = ${next.brand}, schedule_kind = ${next.scheduleKind},
				scheduled_weekday = ${schedule.scheduledWeekday}::int,
				interval_days = ${schedule.intervalDays}::int,
				start_date = ${next.startDate}::date, end_date = ${next.endDate}::date,
				status = ${next.status}, running_low = ${next.runningLow}::boolean, notes = ${next.notes},
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapMedication,
			mayWrite: writableBy(viewer)
		});
	});
}

/** The one-tap toggle on each card in the source; its own action so the
 *  common case is not a full edit form round trip. */
export function setMedicationRunningLow(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	runningLow: boolean
): Promise<WriteResult<Medication>> {
	return guarded<Medication>(async () =>
		writeScoped<MedicationRow, Medication>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			assignments: sql`
				running_low = ${runningLow}::boolean,
				updated_at = now(),
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapMedication,
			mayWrite: writableBy(viewer)
		})
	);
}

export const setMedicationArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Medication>> =>
	archiveScoped<MedicationRow, Medication>({
		sql,
		table: TABLE,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: columns(sql),
		map: mapMedication
	});

export const archiveMedication = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setMedicationArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveMedication = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setMedicationArchived(sql, viewer, id, false, expectedUpdatedAt);

// ─── dose log ───────────────────────────────────────────────────────────────

export const DOSE_SLOTS = ['am', 'pm', 'adhoc'] as const;
export type DoseSlot = (typeof DOSE_SLOTS)[number];

export interface MedicationDose {
	id: string;
	medicationId: string;
	onDate: string;
	slot: DoseSlot;
	takenAt: Date | null;
	note: string | null;
	createdAt: Date;
	createdBy: string | null;
}

interface MedicationDoseRow {
	id: string;
	medication_id: string;
	on_date: string;
	slot: string;
	taken_at: unknown;
	note: string | null;
	created_at: unknown;
	created_by: string | null;
}

const doseColumns = (sql: Queryable): Fragment => sql`
	d.id, d.medication_id, d.on_date::text as on_date, d.slot, d.taken_at, d.note,
	d.created_at, d.created_by`;

function mapDose(row: MedicationDoseRow): MedicationDose {
	return {
		id: row.id,
		medicationId: row.medication_id,
		onDate: toDay(row.on_date),
		slot: row.slot as DoseSlot,
		takenAt: toDateOrNull(row.taken_at),
		note: toTextOrNull(row.note),
		createdAt: toDate(row.created_at),
		createdBy: row.created_by
	};
}

/**
 * Logs a dose for today (or any date), or refreshes an existing one.
 *
 * The slot is derived from the medication's own `schedule_kind` — `am` for
 * `daily_am`, `pm` for `daily_pm`, `adhoc` for everything else — the same
 * rule the importer's `daily_logs -> medications` relation uses, so a dose
 * logged by hand and one carried in from Notion land in the same place. The
 * medication has to be the viewer's to write, checked in the statement.
 */
export function logDose(
	sql: Queryable,
	viewer: Viewer,
	medicationId: string,
	onDate: string,
	note?: string | null
): Promise<WriteResult<MedicationDose>> {
	return guarded<MedicationDose>(async () => {
		if (!isUuid(medicationId)) return { ok: false, reason: 'not_found' };
		const day = requiredDay(onDate, 'date');
		const cleanNote = optionalText(note ?? null, 'note');

		// The insert target is aliased `d` so ON CONFLICT can read the
		// pre-existing row (to keep a note nobody just overwrote) and RETURNING
		// can share `doseColumns`, which every dose reader already qualifies
		// with `d.` for the join in `recentDosesFor`.
		const rows = await sql<MedicationDoseRow[]>`
			insert into medication_doses as d (medication_id, on_date, slot, taken_at, note, created_by)
			select m.id, ${day}::date,
			       case m.schedule_kind
			         when 'daily_am' then 'am'
			         when 'daily_pm' then 'pm'
			         else 'adhoc'
			       end,
			       now(), ${cleanNote}, ${viewer.userId}::uuid
			from medications m
			where m.id = ${medicationId}::uuid and ${writableScope(sql, viewer, 'm')}
			on conflict (medication_id, on_date, slot) do update set
				taken_at = excluded.taken_at,
				note = coalesce(excluded.note, d.note)
			returning ${doseColumns(sql)}
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'not_found' };
		return { ok: true, record: mapDose(row) };
	});
}

/** Removes the dose logged for a medication on a day — the undo half of the
 *  one-tap toggle. Not slot-scoped: at most one dose exists per day under the
 *  table's own unique constraint, so the day alone identifies it. */
export function undoDose(
	sql: Queryable,
	viewer: Viewer,
	medicationId: string,
	onDate: string
): Promise<WriteResult<{ medicationId: string; onDate: string }>> {
	return guarded(async () => {
		if (!isUuid(medicationId)) return { ok: false, reason: 'not_found' };
		const day = requiredDay(onDate, 'date');

		const rows = await sql<{ medication_id: string }[]>`
			delete from medication_doses d
			using medications m
			where d.medication_id = m.id
			  and d.medication_id = ${medicationId}::uuid
			  and d.on_date = ${day}::date
			  and ${writableScope(sql, viewer, 'm')}
			returning d.medication_id
		`;
		if (!rows[0]) return { ok: false, reason: 'not_found' };
		return { ok: true, record: { medicationId, onDate: day } };
	});
}

/**
 * Recent doses for a set of medications, capped per medication, in one round
 * trip — the `foodSummary` discipline of one query rather than one per card.
 * Used both for the "recent history" list and to know, without a second
 * query, whether today is already logged.
 */
export async function recentDosesFor(
	sql: Queryable,
	viewer: Viewer,
	medicationIds: readonly string[],
	limitPerMedication = 10
): Promise<Map<string, MedicationDose[]>> {
	const ids = [...new Set(medicationIds.filter(isUuid))];
	const byMedication = new Map<string, MedicationDose[]>();
	if (ids.length === 0) return byMedication;

	const cap = Math.min(Math.max(limitPerMedication, 1), 100);
	const rows = await sql<MedicationDoseRow[]>`
		select ${doseColumns(sql)}
		from medications m
		join lateral (
			select * from medication_doses md
			where md.medication_id = m.id
			order by md.on_date desc, md.created_at desc
			limit ${cap}
		) d on true
		where m.id = any(${ids}::uuid[]) and ${readableScope(sql, viewer, 'm')}
		order by m.id, d.on_date desc
	`;

	for (const row of rows) {
		const list = byMedication.get(row.medication_id) ?? [];
		list.push(mapDose(row));
		byMedication.set(row.medication_id, list);
	}
	return byMedication;
}

// ─── due today / next due (Notion's formula columns, recomputed) ──────────

export interface DueStatus {
	lastTakenOn: string | null;
	/** Null when the schedule cannot resolve to a date: `as_needed`, or a
	 *  `scheduled` item with neither a weekday nor an interval recorded. */
	nextDueOn: string | null;
	isDueToday: boolean;
}

/** The next date on/after `day` that falls on `weekday` (0 = Sunday). */
function nextWeekdayOnOrAfter(day: string, weekday: number): string {
	const delta = (weekday - dayOfWeek(day) + 7) % 7;
	return addDays(day, delta);
}

/**
 * Recomputes the source's `Due Today?` and `Next Due` formulas from a
 * medication's schedule and its dose history, so neither can drift out of
 * sync with what was actually logged the way a stored copy would.
 *
 * `doseDatesDesc` only needs its first element (the most recent dose); the
 * rest is accepted as a plain array because every caller already has one from
 * {@link recentDosesFor} and slicing it themselves would be one more place to
 * get the ordering wrong.
 */
export function computeDueStatus(
	medication: Pick<Medication, 'scheduleKind' | 'scheduledWeekday' | 'intervalDays'>,
	doseDatesDesc: readonly string[],
	today: string
): DueStatus {
	const lastTakenOn = doseDatesDesc[0] ?? null;
	const takenToday = lastTakenOn === today;

	if (medication.scheduleKind === 'daily_am' || medication.scheduleKind === 'daily_pm') {
		// A daily routine is due every day until it is logged that day.
		return { lastTakenOn, nextDueOn: today, isDueToday: !takenToday };
	}

	if (medication.scheduleKind === 'as_needed') {
		// PRN is never "due" — it is available, which the UI expresses by not
		// showing a due badge at all rather than by a permanently-false one.
		return { lastTakenOn, nextDueOn: null, isDueToday: false };
	}

	// scheduled
	if (medication.scheduledWeekday !== null) {
		const nextDueOn = nextWeekdayOnOrAfter(today, medication.scheduledWeekday);
		return { lastTakenOn, nextDueOn, isDueToday: nextDueOn === today && !takenToday };
	}

	if (medication.intervalDays !== null) {
		const nextDueOn = lastTakenOn ? addDays(lastTakenOn, medication.intervalDays) : today;
		// `<=` rather than `===`: a missed cadence should keep reading as due
		// today, not go quiet until the next multiple of the interval.
		return { lastTakenOn, nextDueOn, isDueToday: nextDueOn <= today && !takenToday };
	}

	// Neither a weekday nor an interval is recorded — the honest answer is
	// "unknown", not a guessed date. See migration 0018's note on the one row
	// this applies to at import time.
	return { lastTakenOn, nextDueOn: null, isDueToday: false };
}

// ─── at a glance (the Health landing page) ────────────────────────────────

export interface MedicationGlance {
	/** Live medications the viewer can see, paused ones included — the same
	 *  "tracked" the medications page's own header counts. */
	tracked: number;
	/** Due today and not yet logged today, by {@link computeDueStatus}. */
	dueToday: number;
	runningLow: number;
}

/**
 * The three numbers `/health` shows for this list, in one query.
 *
 * "Due today" is not a column, so it cannot be a SQL `count`: it is
 * {@link computeDueStatus}, applied here exactly as the medications page
 * applies it, so the two pages cannot disagree. What that rule needs from the
 * dose history is only the most recent day, so SQL hands back `max(on_date)`
 * per medication — one narrow row per medication, never the doses
 * themselves. Scoped exactly as {@link listMedications} and
 * {@link recentDosesFor} are: readable, and not archived.
 */
export async function medicationGlance(
	sql: Queryable,
	viewer: Viewer,
	today: string
): Promise<MedicationGlance> {
	const rows = await sql<
		{
			schedule_kind: string;
			scheduled_weekday: unknown;
			interval_days: unknown;
			running_low: unknown;
			last_taken_on: string | null;
		}[]
	>`
		select m.schedule_kind, m.scheduled_weekday, m.interval_days, m.running_low,
		       (select max(d.on_date) from medication_doses d where d.medication_id = m.id)::text
		           as last_taken_on
		from ${sql(TABLE)} m
		where ${readableScope(sql, viewer, 'm')}
		  and m.archived_at is null
	`;

	let dueToday = 0;
	let runningLow = 0;
	for (const row of rows) {
		const status = computeDueStatus(
			{
				scheduleKind: row.schedule_kind as ScheduleKind,
				scheduledWeekday: toIntOrNull(row.scheduled_weekday),
				intervalDays: toIntOrNull(row.interval_days)
			},
			row.last_taken_on ? [toDay(row.last_taken_on)] : [],
			today
		);
		// The page's own header test, "due and not taken today", spelled out
		// rather than trusting `isDueToday` to imply the second half.
		if (status.isDueToday && status.lastTakenOn !== today) dueToday++;
		if (toBool(row.running_low)) runningLow++;
	}
	return { tracked: rows.length, dueToday, runningLow };
}
