import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
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
import { addDays, daysBetween, nextOccurrence, type Recurrence } from './dates';
import {
	optionalInt,
	optionalOneOf,
	optionalText,
	patched,
	requiredDay,
	requiredText
} from './validate';

/**
 * Important dates (MODEL-003).
 *
 * Birthdays and anniversaries are stored once, on the day they happened, and
 * the next occurrence is computed. Pre-expanding a recurring date into a row
 * per year is how a calendar ends up with a birthday that stops in 2029.
 */

export const RECURRENCES = ['none', 'yearly', 'monthly', 'custom'] as const;

export interface ImportantDateRecord extends RecordBase {
	title: string;
	notes: string | null;
	onDate: string;
	recurrence: Recurrence;
	recurrenceRule: string | null;
	remindDaysBefore: number | null;
	/** Who this date is about — a birthday, an anniversary. Most dates are not
	 *  about anyone, which is why migration 0024 added this nullable rather
	 *  than requiring it. */
	personId: string | null;
}

interface ImportantDateRow extends BaseRow {
	title: string;
	notes: string | null;
	on_date: string;
	recurrence: string;
	recurrence_rule: string | null;
	remind_days_before: unknown;
	person_id: string | null;
}

const TABLE = 'important_dates';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	title, notes, on_date::text as on_date, recurrence, recurrence_rule, remind_days_before,
	person_id`;

function mapImportantDate(row: ImportantDateRow): ImportantDateRecord {
	return {
		...mapBase(row),
		title: toText(row.title),
		notes: toTextOrNull(row.notes),
		onDate: toDay(row.on_date),
		recurrence: row.recurrence as Recurrence,
		recurrenceRule: toTextOrNull(row.recurrence_rule),
		remindDaysBefore: toIntOrNull(row.remind_days_before),
		personId: row.person_id
	};
}

export interface ImportantDateFilters extends PageOptions {
	from?: string;
	to?: string;
	recurrence?: Recurrence;
	ownerUserId?: string | null;
	/** A person's own dates, in `onDate` order — what /people/[id] reads. */
	personId?: string;
	search?: string;
	includeArchived?: boolean;
}

function importantDateConditions(
	sql: Queryable,
	viewer: Viewer,
	filters: ImportantDateFilters
): Fragment {
	const parts: Fragment[] = [
		readableScope(sql, viewer, TABLE),
		liveScope(sql, TABLE, filters.includeArchived)
	];
	if (filters.from) parts.push(sql`on_date >= ${requiredDay(filters.from, 'from')}::date`);
	if (filters.to) parts.push(sql`on_date <= ${requiredDay(filters.to, 'to')}::date`);
	if (filters.recurrence) parts.push(sql`recurrence = ${filters.recurrence}`);
	if (filters.ownerUserId !== undefined) {
		parts.push(
			filters.ownerUserId === null
				? sql`owner_user_id is null`
				: sql`owner_user_id = ${filters.ownerUserId}::uuid`
		);
	}
	if (filters.personId && isUuid(filters.personId)) {
		parts.push(sql`person_id = ${filters.personId}::uuid`);
	}
	if (filters.search?.trim()) parts.push(sql`title ilike ${`%${filters.search.trim()}%`}`);
	return parts.reduce((all, part) => sql`${all} and ${part}`);
}

export async function listImportantDates(
	sql: Queryable,
	viewer: Viewer,
	filters: ImportantDateFilters = {}
): Promise<ImportantDateRecord[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<ImportantDateRow[]>`
		select ${columns(sql)} from important_dates
		where ${importantDateConditions(sql, viewer, filters)}
		order by on_date asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapImportantDate);
}

export async function getImportantDate(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<ImportantDateRecord | null> {
	const row = await getScoped<ImportantDateRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapImportantDate(row) : null;
}

// ─── derived view ──────────────────────────────────────────────────────────

export interface UpcomingDate {
	record: ImportantDateRecord;
	/** The occurrence that falls inside the window. */
	nextOn: string;
	daysAway: number;
	/** True once the record's own reminder lead time has been reached. */
	reminderDue: boolean;
}

/**
 * Dates falling within the next N days, recurrence resolved.
 *
 * The window is applied to the *occurrence*, not to the stored date, which is
 * the whole difficulty: a 1985 birthday is never within seven days of today,
 * but its anniversary may be tomorrow.
 *
 * Which rows to consider is decided in SQL — non-recurring rows can be bounded
 * by the window directly, and a household's recurring dates are a small set —
 * while the occurrence arithmetic runs in a pure function, where 29 February
 * and month-end clamping are testable without a database.
 */
export async function upcomingImportantDates(
	sql: Queryable,
	viewer: Viewer,
	options: { today: string; days?: number; limit?: number }
): Promise<UpcomingDate[]> {
	const today = requiredDay(options.today, 'today');
	const days = Math.max(0, Math.trunc(options.days ?? 30));
	const until = addDays(today, days);

	const rows = await sql<ImportantDateRow[]>`
		select ${columns(sql)} from important_dates
		where ${readableScope(sql, viewer, TABLE)}
		  and archived_at is null
		  and (recurrence in ('yearly', 'monthly')
		       or on_date between ${today}::date and ${until}::date)
		order by on_date asc
	`;

	const upcoming: UpcomingDate[] = [];
	for (const row of rows) {
		const record = mapImportantDate(row);
		const nextOn = nextOccurrence(record.onDate, record.recurrence, today);
		if (nextOn === null || nextOn > until) continue;
		const daysAway = daysBetween(today, nextOn);
		upcoming.push({
			record,
			nextOn,
			daysAway,
			reminderDue:
				record.remindDaysBefore !== null ? daysAway <= record.remindDaysBefore : daysAway === 0
		});
	}

	upcoming.sort((a, b) => (a.nextOn === b.nextOn ? 0 : a.nextOn < b.nextOn ? -1 : 1));
	return options.limit ? upcoming.slice(0, options.limit) : upcoming;
}

// ─── writes ────────────────────────────────────────────────────────────────

export interface ImportantDateInput extends OwnershipInput {
	title?: unknown;
	notes?: unknown;
	onDate?: unknown;
	recurrence?: unknown;
	recurrenceRule?: unknown;
	remindDaysBefore?: unknown;
	personId?: unknown;
}

export function createImportantDate(
	sql: Queryable,
	viewer: Viewer,
	input: ImportantDateInput
): Promise<WriteResult<ImportantDateRecord>> {
	return guarded<ImportantDateRecord>(async () => {
		const title = requiredText(input.title, 'title', 300);
		const onDate = requiredDay(input.onDate, 'date');
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'household'
		});
		// Malformed shape is rejected here so a bad id cannot reach `::uuid` and
		// turn into a raw 500; whether it is actually READABLE is then checked
		// by the subquery below, in the same statement that writes it.
		const rawPersonId =
			typeof input.personId === 'string' && isUuid(input.personId) ? input.personId : null;
		const rows = await sql<ImportantDateRow[]>`
			insert into important_dates (
				household_id, owner_user_id, visibility, title, notes, on_date,
				recurrence, recurrence_rule, remind_days_before, person_id, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title},
				${optionalText(input.notes, 'notes')}, ${onDate}::date,
				${optionalOneOf(input.recurrence, 'recurrence', RECURRENCES) ?? 'none'},
				${optionalText(input.recurrenceRule, 'recurrence rule', 500)},
				${optionalInt(input.remindDaysBefore, 'reminder', { min: 0, max: 365 })}::int,
				-- An id the viewer cannot read simply fails to match: the date is
				-- saved with no person attached rather than attaching it anyway.
				(select p.id from people p
				 where p.id = ${rawPersonId}::uuid and ${readableScope(sql, viewer, 'p')}),
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapImportantDate(row) };
	});
}

export function updateImportantDate(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: ImportantDateInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<ImportantDateRecord>> {
	return guarded<ImportantDateRecord>(async () => {
		const current = await getImportantDate(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			title: patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 300)),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes')),
			onDate: patched(patch, 'onDate', current.onDate, (v) => requiredDay(v, 'date')),
			recurrence: patched(
				patch,
				'recurrence',
				current.recurrence,
				(v) => optionalOneOf(v, 'recurrence', RECURRENCES) ?? current.recurrence
			),
			recurrenceRule: patched(patch, 'recurrenceRule', current.recurrenceRule, (v) =>
				optionalText(v, 'recurrence rule', 500)
			),
			remindDaysBefore: patched(patch, 'remindDaysBefore', current.remindDaysBefore, (v) =>
				optionalInt(v, 'reminder', { min: 0, max: 365 })
			)
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		// Same rule as create: re-checked readable in this statement, not a
		// separate lookup beforehand. Leaving `personId` out of the patch keeps
		// the existing link; the CASE is what tells that apart from clearing it.
		const personGiven = 'personId' in patch;
		const rawPersonId =
			typeof patch.personId === 'string' && isUuid(patch.personId) ? patch.personId : null;

		return writeScoped<ImportantDateRow, ImportantDateRecord>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`
				title = ${next.title},
				notes = ${next.notes},
				on_date = ${next.onDate}::date,
				recurrence = ${next.recurrence},
				recurrence_rule = ${next.recurrenceRule},
				remind_days_before = ${next.remindDaysBefore}::int,
				person_id = case when ${personGiven}::boolean then
					(select p.id from people p
					 where p.id = ${rawPersonId}::uuid and ${readableScope(sql, viewer, 'p')})
					else person_id end,
				owner_user_id = ${ownership.ownerUserId}::uuid,
				visibility = ${ownership.visibility},
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapImportantDate,
			mayWrite: writableBy(viewer)
		});
	});
}

export const setImportantDateArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<ImportantDateRecord>> =>
	archiveScoped<ImportantDateRow, ImportantDateRecord>({
		sql,
		table: TABLE,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: columns(sql),
		map: mapImportantDate
	});

export const archiveImportantDate = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setImportantDateArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveImportantDate = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setImportantDateArchived(sql, viewer, id, false, expectedUpdatedAt);
