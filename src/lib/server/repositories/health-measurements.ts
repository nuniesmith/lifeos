import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate } from '../db/coerce';
import {
	InvalidInput,
	baseColumns,
	getScoped,
	guarded,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toNumberOrNull,
	toIntOrNull,
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
	optionalId,
	optionalInt,
	optionalNumber,
	optionalText,
	patched,
	requiredLocalDateTime
} from './validate';

/**
 * Health Measurements (MODEL-002; migration 0019).
 *
 * Blood pressure, heart rate, blood glucose, weight and QT interval — every
 * spot reading someone takes and writes down, in one table. Notion moved the
 * first four out of its Daily Log database and gave them a home of their own
 * alongside the last two; this module is that home on the LifeOS side. See
 * the migration for the data that already lived on `daily_logs` and why it
 * was moved rather than left to go stale, and `./mappers/measurements.ts`
 * (via the importer) for how a Notion row becomes a row here.
 *
 * Owned like a daily log, not shared like the health vocabulary: a reading is
 * a fact about one person's body, so it defaults to private and every read
 * here is scoped the same way `readableScope` scopes anything else — a
 * household's shared visibility is *available*, the way it is for a daily
 * log, but nothing here turns it on by default.
 */

export interface HealthMeasurement extends RecordBase {
	ownerUserId: string;
	measuredAt: Date;
	systolic: number | null;
	diastolic: number | null;
	bpContext: string | null;
	heartRate: number | null;
	glucose: number | null;
	glucoseContext: string | null;
	weight: number | null;
	qtInterval: number | null;
	notes: string | null;
	dailyLogId: string | null;
}

interface HealthMeasurementRow extends BaseRow {
	measured_at: unknown;
	systolic: unknown;
	diastolic: unknown;
	bp_context: string | null;
	heart_rate: unknown;
	glucose: unknown;
	glucose_context: string | null;
	weight: unknown;
	qt_interval: unknown;
	notes: string | null;
	daily_log_id: string | null;
}

const TABLE = 'health_measurements';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	measured_at, systolic, diastolic, bp_context, heart_rate, glucose, glucose_context,
	weight, qt_interval, notes, daily_log_id`;

function mapMeasurement(row: HealthMeasurementRow): HealthMeasurement {
	const base = mapBase(row);
	if (base.ownerUserId === null) throw new TypeError('a health measurement must have an owner');
	return {
		...base,
		ownerUserId: base.ownerUserId,
		measuredAt: toDate(row.measured_at),
		systolic: toIntOrNull(row.systolic),
		diastolic: toIntOrNull(row.diastolic),
		bpContext: toTextOrNull(row.bp_context),
		heartRate: toIntOrNull(row.heart_rate),
		glucose: toNumberOrNull(row.glucose),
		glucoseContext: toTextOrNull(row.glucose_context),
		weight: toNumberOrNull(row.weight),
		qtInterval: toIntOrNull(row.qt_interval),
		notes: toTextOrNull(row.notes),
		dailyLogId: row.daily_log_id
	};
}

export interface HealthMeasurementFilters extends PageOptions {
	/** ISO instants, inclusive. */
	from?: string;
	to?: string;
	includeArchived?: boolean;
}

/** Most recent first — every list and chart on the page reads it that way. */
export async function listHealthMeasurements(
	sql: Queryable,
	viewer: Viewer,
	filters: HealthMeasurementFilters = {}
): Promise<HealthMeasurement[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<HealthMeasurementRow[]>`
		select ${columns(sql)} from ${sql(TABLE)}
		where ${readableScope(sql, viewer, TABLE)}
		  and ${liveScope(sql, TABLE, filters.includeArchived)}
		  ${filters.from ? sql`and measured_at >= ${filters.from}::timestamptz` : sql``}
		  ${filters.to ? sql`and measured_at <= ${filters.to}::timestamptz` : sql``}
		order by measured_at desc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapMeasurement);
}

export async function getHealthMeasurement(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<HealthMeasurement | null> {
	const row = await getScoped<HealthMeasurementRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapMeasurement(row) : null;
}

export interface HealthMeasurementInput extends OwnershipInput {
	measuredAt?: unknown;
	systolic?: unknown;
	diastolic?: unknown;
	bpContext?: unknown;
	heartRate?: unknown;
	glucose?: unknown;
	glucoseContext?: unknown;
	weight?: unknown;
	qtInterval?: unknown;
	notes?: unknown;
	dailyLogId?: unknown;
}

/**
 * `glucose` and `weight` are `> 0` in the table's own CHECK, not `>= 0` —
 * `optionalNumber`'s bounds are inclusive, so 0 would pass validation here and
 * then fail as a raw constraint violation `guarded` does not special-case
 * (unlike a unique violation, which it does). Checked by hand instead.
 */
function positive(value: unknown, field: string): number | null {
	const n = optionalNumber(value, field);
	if (n !== null && n <= 0) throw new InvalidInput(`${field} must be greater than 0`);
	return n;
}

interface Readings {
	systolic: number | null;
	diastolic: number | null;
	heartRate: number | null;
	glucose: number | null;
	weight: number | null;
	qtInterval: number | null;
}

/** The same bounds as migration 0019's CHECKs, so a bad value is a field-level
 *  error next to the form rather than a raw constraint violation as a 500. */
function readingsOf(input: HealthMeasurementInput, current?: Readings): Readings {
	return {
		systolic: patched(input, 'systolic', current?.systolic ?? null, (v) =>
			optionalInt(v, 'systolic', { min: 40, max: 300 })
		),
		diastolic: patched(input, 'diastolic', current?.diastolic ?? null, (v) =>
			optionalInt(v, 'diastolic', { min: 20, max: 200 })
		),
		heartRate: patched(input, 'heartRate', current?.heartRate ?? null, (v) =>
			optionalInt(v, 'heart rate', { min: 20, max: 250 })
		),
		glucose: patched(input, 'glucose', current?.glucose ?? null, (v) => positive(v, 'glucose')),
		weight: patched(input, 'weight', current?.weight ?? null, (v) => positive(v, 'weight')),
		qtInterval: patched(input, 'qtInterval', current?.qtInterval ?? null, (v) =>
			optionalInt(v, 'QT interval', { min: 200, max: 800 })
		)
	};
}

/** Mirrors the table's own CHECK: an empty reading is refused before the
 *  database would refuse it, so the form can show one plain sentence. */
function requireAtLeastOneReading(readings: Readings): void {
	if (Object.values(readings).every((v) => v === null)) {
		throw new InvalidInput('enter at least one reading');
	}
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * How far `timeZone` is ahead of UTC at `instant`, in milliseconds.
 *
 * Copied from `sourceInstant`'s `zoneOffset` in the importer (`promote.ts`)
 * rather than imported from it: that function takes Notion's human-written
 * date text, this one a `datetime-local` value, and the two input grammars
 * are different enough that sharing the parser would mean bending one of them
 * to fit the other. The offset arithmetic itself — read twice, so a DST
 * transition settles — is the same idea, copied on purpose rather than
 * reached for across the importer/repository boundary.
 */
function zoneOffset(instant: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric'
	}).formatToParts(new Date(instant));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((p) => p.type === type)?.value);
	const asUtc = Date.UTC(
		part('year'),
		part('month') - 1,
		part('day'),
		part('hour'),
		part('minute'),
		part('second')
	);
	return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Places a wall-clock time (from a `datetime-local` input, so it names no
 * zone of its own) in the given zone and returns the resulting instant.
 *
 * Deliberately NOT `` `${localDateTime}::timestamp at time zone ${zone}` ``,
 * sent as a query parameter: the `postgres` driver's own conversion of a
 * bare date-like string parameter collides with PostgreSQL's own reading of
 * it as a naive `timestamp`, and the two disagree about which wall clock the
 * text is already in — the result was a value shifted by the zone's offset
 * *twice*, discovered because it was exactly double the expected 4 hours from
 * a test pinned to America/Toronto (see the integration test for this
 * function). Sending an unambiguous instant instead — this function's job —
 * sidesteps the disagreement entirely; base.ts's own header comment is the
 * general form of this rule.
 *
 * Exported for its own unit tests; not part of this module's public API
 * otherwise.
 */
export function placeInZone(localDateTime: string, timeZone: string): Date {
	const m = LOCAL_DATE_TIME.exec(localDateTime);
	if (!m) throw new InvalidInput('date and time must be a valid date and time');
	const [, year, month, day, hour, minute, second] = m;
	const wall = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second ?? '0')
	);
	// The offset is taken at the wall time and re-taken once at the result,
	// which settles every instant except the hour a DST change skips or
	// repeats — the same two-pass shape as `sourceInstant`.
	let instant = wall - zoneOffset(wall, timeZone);
	instant = wall - zoneOffset(instant, timeZone);
	return new Date(instant);
}

async function householdTimezone(sql: Queryable, householdId: string): Promise<string> {
	const rows = await sql<{ timezone: string }[]>`
		select timezone from households where id = ${householdId}::uuid
	`;
	const row = rows[0];
	if (!row) throw new Error('household not found');
	return row.timezone;
}

/**
 * Resolves an optional daily-log link, checking it the same way a relation is
 * checked everywhere else in this layer: both sides in one query, so a
 * caller cannot attach someone else's day by guessing its id.
 *
 * Returns `undefined` for "named but not reachable", which is different from
 * `null` for "not named at all" — the caller turns the first into a refusal
 * and the second into a plain absence.
 */
async function resolveDailyLogId(
	sql: Queryable,
	viewer: Viewer,
	dailyLogId: string | null
): Promise<string | null | undefined> {
	if (dailyLogId === null) return null;
	if (!isUuid(dailyLogId)) return undefined;
	const rows = await sql<{ id: string }[]>`
		select id from daily_logs where id = ${dailyLogId}::uuid and ${readableScope(sql, viewer, 'daily_logs')}
	`;
	return rows[0]?.id;
}

export function createHealthMeasurement(
	sql: Queryable,
	viewer: Viewer,
	input: HealthMeasurementInput
): Promise<WriteResult<HealthMeasurement>> {
	return guarded<HealthMeasurement>(async () => {
		const measuredAtLocal = requiredLocalDateTime(input.measuredAt, 'date and time');
		const readings = readingsOf(input);
		requireAtLeastOneReading(readings);

		const bpContext = optionalText(input.bpContext, 'BP context', 200);
		const glucoseContext = optionalText(input.glucoseContext, 'glucose context', 200);
		const notes = optionalText(input.notes, 'notes');

		const rawDailyLogId = optionalId(input.dailyLogId, 'daily log');
		const dailyLogId = await resolveDailyLogId(sql, viewer, rawDailyLogId);
		if (dailyLogId === undefined) {
			return { ok: false, reason: 'not_found', message: 'could not find that daily log' };
		}

		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'private'
		});
		if (ownerUserId === null) throw new InvalidInput('a reading needs an owner');

		const measuredAt = placeInZone(
			measuredAtLocal,
			await householdTimezone(sql, viewer.householdId)
		);

		const rows = await sql<HealthMeasurementRow[]>`
			insert into ${sql(TABLE)} (
				household_id, owner_user_id, visibility, measured_at, systolic, diastolic,
				bp_context, heart_rate, glucose, glucose_context, weight, qt_interval, notes,
				daily_log_id, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility},
				${measuredAt.toISOString()}::timestamptz,
				${readings.systolic}, ${readings.diastolic}, ${bpContext}, ${readings.heartRate},
				${readings.glucose}, ${glucoseContext}, ${readings.weight}, ${readings.qtInterval},
				${notes}, ${dailyLogId}::uuid, ${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapMeasurement(row) };
	});
}

export function updateHealthMeasurement(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: HealthMeasurementInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<HealthMeasurement>> {
	return guarded<HealthMeasurement>(async () => {
		const current = await getHealthMeasurement(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const readings = readingsOf(patch, current);
		requireAtLeastOneReading(readings);

		const next = {
			bpContext: patched(patch, 'bpContext', current.bpContext, (v) =>
				optionalText(v, 'BP context', 200)
			),
			glucoseContext: patched(patch, 'glucoseContext', current.glucoseContext, (v) =>
				optionalText(v, 'glucose context', 200)
			),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};

		let measuredAt = current.measuredAt;
		if (patch.measuredAt !== undefined) {
			const local = requiredLocalDateTime(patch.measuredAt, 'date and time');
			measuredAt = placeInZone(local, await householdTimezone(sql, viewer.householdId));
		}

		let dailyLogId = current.dailyLogId;
		if (patch.dailyLogId !== undefined) {
			const raw = optionalId(patch.dailyLogId, 'daily log');
			const resolved = await resolveDailyLogId(sql, viewer, raw);
			if (resolved === undefined) {
				return { ok: false, reason: 'not_found', message: 'could not find that daily log' };
			}
			dailyLogId = resolved;
		}

		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<HealthMeasurementRow, HealthMeasurement>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				measured_at = ${measuredAt.toISOString()}::timestamptz,
				systolic = ${readings.systolic}, diastolic = ${readings.diastolic},
				bp_context = ${next.bpContext}, heart_rate = ${readings.heartRate},
				glucose = ${readings.glucose}, glucose_context = ${next.glucoseContext},
				weight = ${readings.weight}, qt_interval = ${readings.qtInterval},
				notes = ${next.notes}, daily_log_id = ${dailyLogId}::uuid,
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapMeasurement,
			mayWrite: writableBy(viewer)
		});
	});
}

/** "Delete": archived rows leave every list and chart, and are recoverable
 *  like everything else in LifeOS — see `base.ts`'s `archivedAssignment`. */
export function setHealthMeasurementArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<HealthMeasurement>> {
	return guarded<HealthMeasurement>(async () =>
		writeScoped<HealthMeasurementRow, HealthMeasurement>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapMeasurement,
			mayWrite: writableBy(viewer)
		})
	);
}
