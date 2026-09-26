import { int, mapper, numeric, sourceInstant, text } from '../promote.ts';

/**
 * Health Measurements (MODEL-002; migration 0019).
 *
 * New 2026-09-24: Notion split Systolic BP / Diastolic BP / Heart Rate /
 * Blood Glucose out of the Daily Log database into this one, alongside
 * Weight, a QT Interval, and two context selects. See the migration for why
 * `daily_logs` no longer carries the first four at all.
 *
 * Kept in its own file, unlike the other per-database mappers in ./promote.ts,
 * because two sibling Health feature packs (medications; lab results & visits)
 * land in the same window and each needs a database of its own to add without
 * the three of them editing the same function.
 */

/**
 * A row with nothing measured is not a measurement — the "Add Health
 * Measurements" template page in the source exports as its own row with every
 * property empty, and would otherwise become a database row with nothing in
 * it. Refused here the same way `upsertImportantDates` refuses a dateless
 * entry: staged, counted under `refusedByMapper`, never silently dropped.
 */
function hasAnyReading(values: (number | null)[]): boolean {
	return values.some((v) => v !== null);
}

export const upsertHealthMeasurements = mapper('health_measurements', async (sql, row, o) => {
	const measuredAt = sourceInstant(row.raw['Date & Time'] ?? '', o.timeZone ?? 'America/Toronto');
	const systolic = int(row, 'Systolic BP');
	const diastolic = int(row, 'Diastolic BP');
	const heartRate = int(row, 'Heart Rate');
	const glucose = numeric(row, 'Blood Glucose');
	const weight = numeric(row, 'Weight');
	const qtInterval = int(row, 'QT Interval');

	// `measured_at` is `not null` and the table's own CHECK refuses an entirely
	// empty row; both are re-checked here so a row that fails either reads as
	// refused rather than as a database error the report cannot explain.
	if (
		!measuredAt ||
		!hasAnyReading([systolic, diastolic, heartRate, glucose, weight, qtInterval])
	) {
		return null;
	}
	if (!o.ownerUserId) return null;

	const bpContext = text(row, 'BP Context');
	const glucoseContext = text(row, 'Glucose Context');

	// "Measurement Summary" is a Notion formula ("🩺 BP 118/76 mmHg · ...") and
	// is deliberately never read: it is derived from the columns above, and a
	// stored copy of a derived value goes stale the moment one of them changes.
	//
	// The "Symptoms" relation is deliberately not resolved either — see the
	// `health_measurements->daily_logs` case in ./promote.ts's applyRelation,
	// which explains why. "Daily Log" IS resolved there, in pass two, once
	// both sides of the relation exist.
	//
	// No `archived_at`: unlike most source databases, this one has no Archive
	// checkbox to read, so a promoted row is always live.
	//
	// No units either (migration 0022): Notion's "Blood Glucose" and "Weight"
	// are bare numbers, so a new row records none. On a re-import, a unit
	// someone set in LifeOS is kept -- the export has nothing to say about it --
	// unless the value itself is gone, when the unit goes with it, as the
	// table's own CHECK requires.
	const [r] = await sql<{ id: string }[]>`
		insert into health_measurements (
			household_id, owner_user_id, measured_at, systolic, diastolic, bp_context,
			heart_rate, glucose, glucose_context, weight, qt_interval, notes,
			notion_page_id, source_record_id, created_by
		)
		values (
			${o.householdId}, ${o.ownerUserId}, ${measuredAt}::timestamptz,
			${systolic}, ${diastolic}, ${bpContext}, ${heartRate}, ${glucose}, ${glucoseContext},
			${weight}, ${qtInterval}, ${row.body ?? null},
			${row.notion_page_id}, ${row.id}, ${o.createdBy}
		)
		on conflict (notion_page_id) do update set
			measured_at = excluded.measured_at,
			systolic = excluded.systolic,
			diastolic = excluded.diastolic,
			bp_context = excluded.bp_context,
			heart_rate = excluded.heart_rate,
			glucose = excluded.glucose,
			glucose_unit = case when excluded.glucose is null then null
			                    else health_measurements.glucose_unit end,
			glucose_context = excluded.glucose_context,
			weight = excluded.weight,
			weight_unit = case when excluded.weight is null then null
			                   else health_measurements.weight_unit end,
			qt_interval = excluded.qt_interval,
			notes = excluded.notes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});
