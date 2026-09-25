import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	InvalidInput,
	baseColumns,
	getScoped,
	guarded,
	householdScope,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toDay,
	toInt,
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
import { optionalText, patched, requiredText } from './validate';

/**
 * Health (MODEL-002, feature pack 1).
 *
 * The source workspace keeps seven small databases here — Symptoms,
 * Mood/Feelings, Vitamins, Energy Level, Activity, Exercise — and none of them
 * is a record about a day. They are the *words* used to describe days, related
 * back to the Daily Log. So this module owns one vocabulary and the link that
 * says a word applied to a day; see migration 0011.
 *
 * Privacy is inherited rather than reimplemented. The link hangs off
 * `daily_logs`, which is owner-scoped, so every read here joins through the
 * log and a person's own entries are the only ones they can reach. The
 * vocabulary is household-scoped: a shared list of words discloses nothing
 * about who used them.
 */

export const HEALTH_KINDS = [
	'symptom',
	'mood',
	'vitamin',
	'energy',
	'activity',
	'exercise'
] as const;

export type HealthKind = (typeof HEALTH_KINDS)[number];

export interface HealthTerm extends RecordBase {
	kind: HealthKind;
	name: string;
	notes: string | null;
	attributes: Record<string, unknown>;
}

interface HealthTermRow extends BaseRow {
	kind: string;
	name: string;
	notes: string | null;
	attributes: unknown;
}

const TABLE = 'health_vocabulary';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	kind, name, notes, attributes`;

function mapTerm(row: HealthTermRow): HealthTerm {
	return {
		...mapBase(row),
		kind: row.kind as HealthKind,
		name: toText(row.name),
		notes: toTextOrNull(row.notes),
		// jsonb arrives parsed under this driver, but a string is what a
		// double-encoded write would produce; treat that as no attributes
		// rather than exploding on a page render.
		attributes:
			row.attributes && typeof row.attributes === 'object'
				? (row.attributes as Record<string, unknown>)
				: {}
	};
}

// ─── vocabulary ────────────────────────────────────────────────────────────

export interface HealthTermFilters extends PageOptions {
	kind?: HealthKind | readonly HealthKind[];
	search?: string;
	includeArchived?: boolean;
}

export async function listHealthTerms(
	sql: Queryable,
	viewer: Viewer,
	filters: HealthTermFilters = {}
): Promise<HealthTerm[]> {
	const { limit, offset } = pageOf(filters);
	const kinds = filters.kind
		? Array.isArray(filters.kind)
			? filters.kind
			: [filters.kind as HealthKind]
		: null;

	const rows = await sql<HealthTermRow[]>`
		select ${columns(sql)} from ${sql(TABLE)}
		where ${readableScope(sql, viewer, TABLE)}
		  and ${liveScope(sql, TABLE, filters.includeArchived)}
		  ${kinds ? sql`and kind in ${sql([...kinds])}` : sql``}
		  ${filters.search ? sql`and name ilike ${'%' + filters.search.trim() + '%'}` : sql``}
		order by kind asc, name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapTerm);
}

export async function getHealthTerm(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<HealthTerm | null> {
	const row = await getScoped<HealthTermRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapTerm(row) : null;
}

export interface HealthTermInput extends OwnershipInput {
	kind?: unknown;
	name?: unknown;
	notes?: unknown;
	attributes?: unknown;
}

function requiredKind(value: unknown): HealthKind {
	const kind = typeof value === 'string' ? value.trim().toLowerCase() : '';
	if (!HEALTH_KINDS.includes(kind as HealthKind)) {
		throw new InvalidInput(`kind must be one of ${HEALTH_KINDS.join(', ')}`);
	}
	return kind as HealthKind;
}

/** Attributes must be a plain object; an array or a scalar is a caller error. */
function optionalAttributes(value: unknown): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new InvalidInput('attributes must be an object');
	}
	return value as Record<string, unknown>;
}

export function createHealthTerm(
	sql: Queryable,
	viewer: Viewer,
	input: HealthTermInput
): Promise<WriteResult<HealthTerm>> {
	return guarded<HealthTerm>(async () => {
		const kind = requiredKind(input.kind);
		const name = requiredText(input.name, 'name', 200);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		// See migration 0016 for why this is a condition rather than a unique
		// index: a duplicated label must not be able to abort an import.
		const rows = await sql<HealthTermRow[]>`
			insert into ${sql(TABLE)} (
				household_id, owner_user_id, visibility, kind, name, notes, attributes,
				created_by, updated_by
			)
			select ${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${kind}, ${name},
				${optionalText(input.notes, 'notes')},
				-- ::text::jsonb, never ::jsonb: under the bundled build the driver
				-- double-encodes a bare object cast and every attribute lands as a
				-- JSON string of an object.
				${JSON.stringify(optionalAttributes(input.attributes))}::text::jsonb,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			where not exists (
				select 1 from ${sql(TABLE)} existing
				where existing.household_id = ${viewer.householdId}::uuid
				  and existing.kind = ${kind}
				  and lower(trim(existing.name)) = lower(trim(${name}))
				  and existing.archived_at is null
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'invalid', message: 'that is already on the list' };
		return { ok: true, record: mapTerm(row) };
	});
}

export function updateHealthTerm(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: HealthTermInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<HealthTerm>> {
	return guarded<HealthTerm>(async () => {
		const current = await getHealthTerm(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes')),
			attributes: patched(patch, 'attributes', current.attributes, optionalAttributes)
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<HealthTermRow, HealthTerm>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`
				name = ${next.name},
				notes = ${next.notes},
				attributes = ${JSON.stringify(next.attributes)}::text::jsonb,
				owner_user_id = ${ownership.ownerUserId}::uuid,
				visibility = ${ownership.visibility},
				updated_at = now(),
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapTerm,
			mayWrite: writableBy(viewer)
		});
	});
}

export function setHealthTermArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean
): Promise<WriteResult<HealthTerm>> {
	return guarded<HealthTerm>(async () =>
		writeScoped<HealthTermRow, HealthTerm>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(),
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapTerm,
			mayWrite: writableBy(viewer)
		})
	);
}

// ─── what was logged ───────────────────────────────────────────────────────

export interface LoggedTerm {
	vocabularyId: string;
	kind: HealthKind;
	name: string;
	detail: string | null;
}

/**
 * The terms logged against one day.
 *
 * Scoped through the daily log rather than by the vocabulary's own visibility:
 * the question is "what did this person record", and that is theirs.
 */
export async function healthForLog(
	sql: Queryable,
	viewer: Viewer,
	dailyLogId: string
): Promise<LoggedTerm[]> {
	if (!isUuid(dailyLogId)) return [];
	const rows = await sql<
		{ vocabulary_id: string; kind: string; name: string; detail: string | null }[]
	>`
		select h.vocabulary_id, v.kind, v.name, h.detail
		from daily_log_health h
		join daily_logs l on l.id = h.daily_log_id
		join health_vocabulary v on v.id = h.vocabulary_id
		where h.daily_log_id = ${dailyLogId}::uuid
		  and l.household_id = ${viewer.householdId}::uuid
		  and l.owner_user_id = ${viewer.userId}::uuid
		order by v.kind asc, v.name asc
	`;
	return rows.map((row) => ({
		vocabularyId: row.vocabulary_id,
		kind: row.kind as HealthKind,
		name: toText(row.name),
		detail: toTextOrNull(row.detail)
	}));
}

/**
 * Records a term against a day, or updates its detail.
 *
 * Both sides are checked in SQL: the log must be the viewer's own, and the
 * term must be one they can read. A caller cannot attach an arbitrary uuid.
 */
export async function logHealthTerm(
	sql: Queryable,
	viewer: Viewer,
	dailyLogId: string,
	vocabularyId: string,
	detail?: string | null
): Promise<WriteResult<{ dailyLogId: string; vocabularyId: string }>> {
	if (!isUuid(dailyLogId) || !isUuid(vocabularyId)) return { ok: false, reason: 'not_found' };

	const rows = await sql<{ daily_log_id: string }[]>`
		insert into daily_log_health (daily_log_id, vocabulary_id, detail)
		select l.id, v.id, ${detail ?? null}
		from daily_logs l, health_vocabulary v
		where l.id = ${dailyLogId}::uuid
		  and l.household_id = ${viewer.householdId}::uuid
		  and l.owner_user_id = ${viewer.userId}::uuid
		  and v.id = ${vocabularyId}::uuid
		  and ${readableScope(sql, viewer, 'v')}
		  and v.archived_at is null
		on conflict (daily_log_id, vocabulary_id) do update set detail = excluded.detail
		returning daily_log_id
	`;

	if (!rows[0]) return { ok: false, reason: 'not_found' };
	return { ok: true, record: { dailyLogId, vocabularyId } };
}

export async function unlogHealthTerm(
	sql: Queryable,
	viewer: Viewer,
	dailyLogId: string,
	vocabularyId: string
): Promise<WriteResult<{ dailyLogId: string }>> {
	if (!isUuid(dailyLogId) || !isUuid(vocabularyId)) return { ok: false, reason: 'not_found' };

	const rows = await sql<{ daily_log_id: string }[]>`
		delete from daily_log_health h
		using daily_logs l
		where h.daily_log_id = l.id
		  and h.daily_log_id = ${dailyLogId}::uuid
		  and h.vocabulary_id = ${vocabularyId}::uuid
		  and l.household_id = ${viewer.householdId}::uuid
		  and l.owner_user_id = ${viewer.userId}::uuid
		returning h.daily_log_id
	`;

	if (!rows[0]) return { ok: false, reason: 'not_found' };
	return { ok: true, record: { dailyLogId } };
}

// ─── patterns ──────────────────────────────────────────────────────────────

export interface TermFrequency {
	vocabularyId: string;
	kind: HealthKind;
	name: string;
	days: number;
	lastLoggedOn: string | null;
}

/**
 * How often each term has been logged, most frequent first.
 *
 * This is the whole point of keeping a symptom list rather than free text: the
 * source workspace shows a "# of Days" rollup on every symptom, and a count
 * across months is the thing that turns "I feel rough a lot" into something a
 * person can take to an appointment.
 */
export async function healthFrequencies(
	sql: Queryable,
	viewer: Viewer,
	options: {
		kind?: HealthKind | readonly HealthKind[];
		from?: string;
		to?: string;
		limit?: number;
	} = {}
): Promise<TermFrequency[]> {
	const kinds = options.kind
		? Array.isArray(options.kind)
			? options.kind
			: [options.kind as HealthKind]
		: null;
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

	const rows = await sql<
		{
			vocabulary_id: string;
			kind: string;
			name: string;
			days: number;
			last_logged_on: string | null;
		}[]
	>`
		select v.id as vocabulary_id, v.kind, v.name,
		       count(distinct l.on_date)::int as days,
		       max(l.on_date)::text as last_logged_on
		from health_vocabulary v
		join daily_log_health h on h.vocabulary_id = v.id
		join daily_logs l on l.id = h.daily_log_id
		where ${readableScope(sql, viewer, 'v')}
		  and l.household_id = ${viewer.householdId}::uuid
		  and l.owner_user_id = ${viewer.userId}::uuid
		  ${kinds ? sql`and v.kind in ${sql([...kinds])}` : sql``}
		  ${options.from ? sql`and l.on_date >= ${options.from}::date` : sql``}
		  ${options.to ? sql`and l.on_date <= ${options.to}::date` : sql``}
		group by v.id, v.kind, v.name
		order by days desc, v.name asc
		limit ${limit}
	`;

	return rows.map((row) => ({
		vocabularyId: row.vocabulary_id,
		kind: row.kind as HealthKind,
		name: toText(row.name),
		days: toInt(row.days),
		lastLoggedOn: row.last_logged_on ? toDay(row.last_logged_on) : null
	}));
}

export interface VitalsReading {
	onDate: string;
	bloodGlucose: number | null;
	systolicBp: number | null;
	diastolicBp: number | null;
	heartRate: number | null;
	heartRateVariability: number | null;
	sleepScore: number | null;
	water: number | null;
}

/**
 * The scalar readings, most recent first, for the days that have any.
 *
 * Blood glucose, systolic/diastolic BP and heart rate moved to
 * `health_measurements` (migration 0019); heart rate variability, sleep score
 * and water stayed on `daily_logs`. This still returns one row per DAY, not
 * per measurement, because the caller (`/health`) keys its table on `onDate`
 * — a day with two blood-pressure readings must not become two rows. Where a
 * day has more than one reading of the same kind, the most recent one wins,
 * picked with `array_agg(... order by measured_at desc)` rather than `max()`:
 * `max` would pick the largest NUMBER, which for blood pressure is not the
 * same thing as the latest reading.
 */
export async function recentVitals(
	sql: Queryable,
	viewer: Viewer,
	limit = 30
): Promise<VitalsReading[]> {
	const rows = await sql<
		{
			on_date: string;
			blood_glucose: unknown;
			systolic_bp: unknown;
			diastolic_bp: unknown;
			heart_rate: unknown;
			heart_rate_variability: unknown;
			sleep_score: unknown;
			water: unknown;
		}[]
	>`
		with measured as (
			select m.household_id, m.owner_user_id, m.measured_at,
			       m.glucose, m.systolic, m.diastolic, m.heart_rate,
			       (m.measured_at at time zone h.timezone)::date as on_date
			from health_measurements m
			join households h on h.id = m.household_id
			where m.household_id = ${viewer.householdId}::uuid
			  and m.owner_user_id = ${viewer.userId}::uuid
			  and m.archived_at is null
		),
		by_day as (
			select on_date,
			       (array_agg(glucose order by measured_at desc) filter (where glucose is not null))[1]
			           as blood_glucose,
			       (array_agg(systolic order by measured_at desc) filter (where systolic is not null))[1]
			           as systolic_bp,
			       (array_agg(diastolic order by measured_at desc) filter (where diastolic is not null))[1]
			           as diastolic_bp,
			       (array_agg(heart_rate order by measured_at desc) filter (where heart_rate is not null))[1]
			           as heart_rate
			from measured
			group by on_date
		)
		select coalesce(by_day.on_date, d.on_date)::text as on_date,
		       by_day.blood_glucose, by_day.systolic_bp, by_day.diastolic_bp, by_day.heart_rate,
		       d.heart_rate_variability, d.sleep_score, d.water
		from by_day
		full join daily_logs d
		  on d.on_date = by_day.on_date
		 and d.household_id = ${viewer.householdId}::uuid
		 and d.owner_user_id = ${viewer.userId}::uuid
		 and d.archived_at is null
		where by_day.on_date is not null
		   or (d.heart_rate_variability is not null or d.sleep_score is not null or d.water is not null)
		order by coalesce(by_day.on_date, d.on_date) desc
		limit ${Math.min(Math.max(limit, 1), 365)}
	`;

	return rows.map((row) => ({
		onDate: toDay(row.on_date),
		bloodGlucose: toNumberOrNull(row.blood_glucose),
		systolicBp: toIntOrNull(row.systolic_bp),
		diastolicBp: toIntOrNull(row.diastolic_bp),
		heartRate: toIntOrNull(row.heart_rate),
		heartRateVariability: toIntOrNull(row.heart_rate_variability),
		sleepScore: toIntOrNull(row.sleep_score),
		water: toIntOrNull(row.water)
	}));
}

/** How many distinct terms exist per kind, for the page's chips. */
export async function healthTermCounts(
	sql: Queryable,
	viewer: Viewer
): Promise<Record<HealthKind, number>> {
	const rows = await sql<{ kind: string; total: number }[]>`
		select kind, count(*)::int as total
		from ${sql(TABLE)}
		where ${householdScope(sql, viewer, TABLE)} and archived_at is null
		group by kind
	`;
	const counts = Object.fromEntries(HEALTH_KINDS.map((k) => [k, 0])) as Record<HealthKind, number>;
	for (const row of rows) counts[row.kind as HealthKind] = Number(row.total);
	return counts;
}
