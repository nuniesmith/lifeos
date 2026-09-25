import type { TransactionSql, Sql } from 'postgres';
import { parseReviewCadence, parseSourceBoolean, parseSourceDate } from '../csv.ts';

/**
 * The "Vitamins & Medications" mapper (migration 0018).
 *
 * Registered in `promote.ts` under the database's Notion id
 * (`3bc879a5-56f1-808c-8f0e-d230d152b08f`, `DATABASE_NAMES_BY_ID`'s
 * `'Vitamins Database'`), replacing the old `vocabularyMapper('vitamin', …)`
 * entry that only ever read a name, a page body and "Running Low".
 *
 * Five source columns are Notion formulas and are deliberately never read
 * here: `Due Today?`, `Last Taken`, `Next Due`, `Times Logged`, `Medication
 * Display`. A sixth, `Dates Logged`, looks like data but is a rollup of the
 * very `Medications & Vitamins` relation this file's sibling case in
 * `promote.ts` (`daily_logs -> medications`) already turns into
 * `medication_doses` rows — reading it too would risk double-counting a day
 * the relation already carries, for no new information.
 */

type Queryable = Sql | TransactionSql;

interface StagedRow {
	id: string;
	notion_page_id: string | null;
	title: string | null;
	raw: Record<string, string>;
	body: string | null;
}

interface MapperOptions {
	householdId: string;
	ownerUserId: string | null;
	createdBy: string | null;
}

const text = (row: StagedRow, column: string): string | null => {
	const v = row.raw[column];
	return v && v.trim() ? v.trim() : null;
};

/**
 * The page body plus the "Notes" column, matching `promote.ts`'s own
 * `withBody`: Notion keeps these as two separate pieces of content (a short
 * property and the page's long-form body), and this database has both a
 * "Notes" column and room to write in the page itself.
 */
const withNotes = (row: StagedRow): string | null => {
	const column = text(row, 'Notes');
	if (row.body && column) return `${row.body}\n\n---\n\n${column}`;
	return row.body ?? column;
};

const bool = (row: StagedRow, column: string): boolean =>
	parseSourceBoolean(row.raw[column] ?? '') === true;

const date = (row: StagedRow, column: string): string | null =>
	parseSourceDate(row.raw[column] ?? '')?.date ?? null;

/** Lowercased, letters only — the same decoration-stripping trick `promote.ts`
 *  uses for select values, kept local since these five columns are the only
 *  ones this mapper reads that way. */
const normalize = (value: string | null): string =>
	(value ?? '')
		.toLowerCase()
		.replace(/[^a-z]+/g, ' ')
		.trim();

const TYPES: Record<string, string> = {
	prescription: 'prescription',
	supplement: 'supplement',
	vitamin: 'vitamin',
	electrolyte: 'electrolyte',
	otc: 'otc'
};

/**
 * Unrecognised or blank falls back to 'vitamin' — the same blanket kind every
 * row in this database imported as before this migration, so an export the
 * household has not edited yet still lands somewhere sane rather than being
 * refused outright for want of one column.
 */
const mapType = (row: StagedRow): string => TYPES[normalize(text(row, 'Type'))] ?? 'vitamin';

const ROUTINES: Record<string, string> = {
	'daily am': 'daily_am',
	'daily pm': 'daily_pm',
	scheduled: 'scheduled',
	'as needed': 'as_needed'
};

/** Falls back to 'as_needed': the reading that asserts the least about a
 *  schedule the source did not actually state. */
const mapScheduleKind = (row: StagedRow): string =>
	ROUTINES[normalize(text(row, 'Routine'))] ?? 'as_needed';

const STATUSES: Record<string, string> = { taking: 'taking', paused: 'paused' };
const mapStatus = (row: StagedRow): string => STATUSES[normalize(text(row, 'Status'))] ?? 'taking';

const WEEKDAYS: Record<string, number> = {
	sunday: 0,
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6
};

/** 0-6 (Sunday first, matching `dayOfWeek`/PostgreSQL `dow`), or null when the
 *  cell is blank or not a day name. */
const weekdayOf = (row: StagedRow, column: string): number | null => {
	const n = WEEKDAYS[normalize(text(row, column))];
	return n === undefined ? null : n;
};

/**
 * Maps the medication row itself.
 *
 * `attributes` carries the two composition fields only the Electrolyte type
 * uses — Sodium, Essential Calcium — the same "per-kind extras" treatment
 * `vocabularyMapper` already gives Energy Level and Mood in migration 0011.
 */
export async function upsertMedication(
	sql: Queryable,
	row: StagedRow,
	o: MapperOptions
): Promise<string | null> {
	const scheduleKind = mapScheduleKind(row);
	const scheduledWeekday =
		scheduleKind === 'scheduled' ? weekdayOf(row, 'Scheduled Weekday') : null;
	// An interval only fills in when there is no weekday to prefer, matching
	// the "alternatives, not a pair" rule migration 0018's CHECK constraints
	// enforce. `parseReviewCadence` is the review-cadence word table
	// ("Monthly" -> 30, "Weekly" -> 7, …) reused rather than duplicated.
	const intervalDays =
		scheduleKind === 'scheduled' && scheduledWeekday === null
			? parseReviewCadence(text(row, 'Frequency') ?? '')
			: null;

	const attributes: Record<string, string> = {};
	const essentialCalcium = text(row, 'Essential Calcium');
	const sodium = text(row, 'Sodium');
	if (essentialCalcium) attributes['Essential Calcium'] = essentialCalcium;
	if (sodium) attributes['Sodium'] = sodium;

	const [r] = await sql<{ id: string }[]>`
		insert into medications (
			household_id, owner_user_id, visibility, name, type, dose, unit, brand,
			schedule_kind, scheduled_weekday, interval_days, start_date, end_date,
			status, running_low, notes, attributes,
			notion_page_id, source_record_id, created_by, archived_at
		)
		values (
			${o.householdId}, null, 'household', ${row.title ?? 'Untitled'}, ${mapType(row)},
			${text(row, 'Dose')}, ${text(row, 'Unit')}, ${text(row, 'Brand')},
			${scheduleKind}, ${scheduledWeekday}, ${intervalDays},
			${date(row, 'Start Date')}, ${date(row, 'End Date')},
			${mapStatus(row)}, ${bool(row, 'Running Low')}, ${withNotes(row)},
			${JSON.stringify(attributes)}::text::jsonb,
			${row.notion_page_id}, ${row.id}, ${o.createdBy},
			${bool(row, 'Archive') ? new Date().toISOString() : null}::timestamptz
		)
		on conflict (notion_page_id) do update set
			name = excluded.name,
			type = excluded.type,
			dose = excluded.dose,
			unit = excluded.unit,
			brand = excluded.brand,
			schedule_kind = excluded.schedule_kind,
			scheduled_weekday = excluded.scheduled_weekday,
			interval_days = excluded.interval_days,
			start_date = excluded.start_date,
			end_date = excluded.end_date,
			status = excluded.status,
			running_low = excluded.running_low,
			notes = excluded.notes,
			attributes = excluded.attributes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
}

/**
 * Turns a `daily_logs -> medications` relation edge (the source's
 * "Medications & Vitamins" property) into a dose.
 *
 * Called from `promote.ts`'s `applyRelation`, which already has both ids —
 * this only needs the daily log's date and the medication's own schedule, so
 * it stays a single INSERT rather than two round trips. `on conflict … do
 * nothing` makes a rerun idempotent the same way every other relation case
 * in that file already is.
 */
export async function applyMedicationDose(
	sql: Queryable,
	dailyLogId: string,
	medicationId: string
): Promise<boolean> {
	const rows = await sql<{ medication_id: string }[]>`
		insert into medication_doses (medication_id, on_date, slot)
		select m.id, d.on_date,
		       case m.schedule_kind
		         when 'daily_am' then 'am'
		         when 'daily_pm' then 'pm'
		         else 'adhoc'
		       end
		from daily_logs d, medications m
		where d.id = ${dailyLogId} and m.id = ${medicationId}
		on conflict (medication_id, on_date, slot) do nothing
		returning medication_id
	`;
	return rows.length > 0;
}
