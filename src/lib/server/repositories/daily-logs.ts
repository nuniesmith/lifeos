import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	InvalidInput,
	archiveScoped,
	baseColumns,
	getScoped,
	guarded,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toDay,
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
import { isDay } from './dates';
import { optionalInt, optionalText, patched, requiredDay } from './validate';

/**
 * Daily logs (MODEL-003).
 *
 * Private by default, and the default is the point: a journal that arrives
 * shared and has to be locked down is the wrong way round to discover. The
 * owner is required — a daily log with no owner would be nobody's day — and
 * one entry per person per day is a database constraint, not a convention the
 * application has to remember.
 */

export interface DailyLogRecord extends RecordBase {
	ownerUserId: string;
	onDate: string;
	note: string | null;
	energyLevel: number | null;
	mood: string | null;
	gratitude: string | null;
	highlight: string | null;
}

interface DailyLogRow extends BaseRow {
	on_date: string;
	note: string | null;
	energy_level: unknown;
	mood: string | null;
	gratitude: string | null;
	highlight: string | null;
}

const TABLE = 'daily_logs';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	on_date::text as on_date, note, energy_level, mood, gratitude, highlight`;

function mapDailyLog(row: DailyLogRow): DailyLogRecord {
	const base = mapBase(row);
	if (base.ownerUserId === null) throw new TypeError('a daily log must have an owner');
	return {
		...base,
		ownerUserId: base.ownerUserId,
		onDate: toDay(row.on_date),
		note: toTextOrNull(row.note),
		energyLevel: toIntOrNull(row.energy_level),
		mood: toTextOrNull(row.mood),
		gratitude: toTextOrNull(row.gratitude),
		highlight: toTextOrNull(row.highlight)
	};
}

export interface DailyLogFilters extends PageOptions {
	from?: string;
	to?: string;
	ownerUserId?: string;
	includeArchived?: boolean;
	order?: 'newest' | 'oldest';
}

function dailyLogConditions(sql: Queryable, viewer: Viewer, filters: DailyLogFilters): Fragment {
	const parts: Fragment[] = [
		readableScope(sql, viewer, TABLE),
		liveScope(sql, TABLE, filters.includeArchived)
	];
	if (filters.from) parts.push(sql`on_date >= ${requiredDay(filters.from, 'from')}::date`);
	if (filters.to) parts.push(sql`on_date <= ${requiredDay(filters.to, 'to')}::date`);
	if (filters.ownerUserId) parts.push(sql`owner_user_id = ${filters.ownerUserId}::uuid`);
	return parts.reduce((all, part) => sql`${all} and ${part}`);
}

export async function listDailyLogs(
	sql: Queryable,
	viewer: Viewer,
	filters: DailyLogFilters = {}
): Promise<DailyLogRecord[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<DailyLogRow[]>`
		select ${columns(sql)} from daily_logs
		where ${dailyLogConditions(sql, viewer, filters)}
		order by ${filters.order === 'oldest' ? sql`on_date asc` : sql`on_date desc`}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapDailyLog);
}

export async function getDailyLog(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<DailyLogRecord | null> {
	const row = await getScoped<DailyLogRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapDailyLog(row) : null;
}

/** The entry for a day, for the viewer unless another owner is named. */
export async function getDailyLogForDate(
	sql: Queryable,
	viewer: Viewer,
	onDate: string,
	ownerUserId?: string
): Promise<DailyLogRecord | null> {
	if (!isDay(onDate)) return null;
	const rows = await sql<DailyLogRow[]>`
		select ${columns(sql)} from daily_logs
		where on_date = ${onDate}::date
		  and owner_user_id = ${ownerUserId ?? viewer.userId}::uuid
		  and ${readableScope(sql, viewer, TABLE)}
		limit 1
	`;
	const row = rows[0];
	return row ? mapDailyLog(row) : null;
}

export interface DailyLogInput extends OwnershipInput {
	onDate?: unknown;
	note?: unknown;
	energyLevel?: unknown;
	mood?: unknown;
	gratitude?: unknown;
	highlight?: unknown;
}

export function createDailyLog(
	sql: Queryable,
	viewer: Viewer,
	input: DailyLogInput
): Promise<WriteResult<DailyLogRecord>> {
	return guarded<DailyLogRecord>(async () => {
		const onDate = requiredDay(input.onDate, 'date');
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'private'
		});
		if (ownerUserId === null) throw new InvalidInput('a daily log needs an owner');

		const existing = await getDailyLogForDate(sql, viewer, onDate, ownerUserId);
		if (existing) {
			return { ok: false, reason: 'invalid', message: 'there is already a log for that day' };
		}

		const rows = await sql<DailyLogRow[]>`
			insert into daily_logs (
				household_id, owner_user_id, visibility, on_date, note,
				energy_level, mood, gratitude, highlight, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${onDate}::date,
				${optionalText(input.note, 'note')},
				${optionalInt(input.energyLevel, 'energy', { min: 1, max: 5 })}::int,
				${optionalText(input.mood, 'mood', 100)},
				${optionalText(input.gratitude, 'gratitude')},
				${optionalText(input.highlight, 'highlight')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapDailyLog(row) };
	});
}

export function updateDailyLog(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: DailyLogInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<DailyLogRecord>> {
	return guarded<DailyLogRecord>(async () => {
		const current = await getDailyLog(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			onDate: patched(patch, 'onDate', current.onDate, (v) => requiredDay(v, 'date')),
			note: patched(patch, 'note', current.note, (v) => optionalText(v, 'note')),
			energyLevel: patched(patch, 'energyLevel', current.energyLevel, (v) =>
				optionalInt(v, 'energy', { min: 1, max: 5 })
			),
			mood: patched(patch, 'mood', current.mood, (v) => optionalText(v, 'mood', 100)),
			gratitude: patched(patch, 'gratitude', current.gratitude, (v) =>
				optionalText(v, 'gratitude')
			),
			highlight: patched(patch, 'highlight', current.highlight, (v) => optionalText(v, 'highlight'))
		};
		// The owner cannot move; the day's uniqueness is keyed on it.
		const ownership = resolveOwnership(
			viewer,
			{ visibility: patch.visibility },
			{ ownerUserId: current.ownerUserId, visibility: current.visibility }
		);

		return writeScoped<DailyLogRow, DailyLogRecord>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`
				on_date = ${next.onDate}::date,
				note = ${next.note},
				energy_level = ${next.energyLevel}::int,
				mood = ${next.mood},
				gratitude = ${next.gratitude},
				highlight = ${next.highlight},
				visibility = ${ownership.visibility},
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapDailyLog,
			mayWrite: writableBy(viewer)
		});
	});
}

export const setDailyLogArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<DailyLogRecord>> =>
	archiveScoped<DailyLogRow, DailyLogRecord>({
		sql,
		table: TABLE,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: columns(sql),
		map: mapDailyLog
	});

export const archiveDailyLog = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setDailyLogArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveDailyLog = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setDailyLogArchived(sql, viewer, id, false, expectedUpdatedAt);
