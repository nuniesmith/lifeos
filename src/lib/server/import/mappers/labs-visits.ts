import type { Sql, TransactionSql } from 'postgres';
import { parseSourceDate } from '../csv.ts';
import type { PromoteOptions } from '../promote.ts';

/**
 * Importer mappers for lab results and medical visits (migration 0020).
 *
 * A separate file rather than three more functions inside promote.ts: three
 * agents were adding mappers to this importer at once (health/labs, health/
 * medications, health/measurements), and promote.ts is a single 1500-line file
 * every one of them would otherwise be editing in the same place. promote.ts
 * itself changes only to import these three and register them.
 *
 * That separation is also why the small row-reading helpers below (`text`,
 * `date`, `numeric`, `withBody`, `multi`, `money`, `sourceInstant`) are
 * duplicated from promote.ts rather than imported from it: promote.ts imports
 * *this* file to register the mappers, so importing anything back would make
 * the two files circular. Every duplicate here is a small, pure function with
 * no state of its own -- see promote.ts for the fuller reasoning behind each,
 * in particular `sourceInstant` on why a Notion date-time cannot be read with
 * a bare `Date.parse`.
 *
 * The relations these three databases carry -- a result's marker and visit, a
 * visit's daily log and symptoms -- are not resolved here at all. Promotion
 * runs in two passes (see promote.ts), and a relation only becomes a foreign
 * key in the second one, once every row from every database has a promoted
 * id to point at; this file only ever runs in the first.
 */

type Queryable = Sql | TransactionSql;

interface StagedRow {
	id: string;
	notion_page_id: string | null;
	database_name: string;
	database_notion_id: string | null;
	title: string | null;
	raw: Record<string, string>;
	body: string | null;
}

type MapFn = (sql: Queryable, row: StagedRow, options: PromoteOptions) => Promise<string | null>;
type Mapper = MapFn & { table: string };

/** Tags a mapping function with the table it writes to, as promote.ts's own. */
function mapper(table: string, fn: MapFn): Mapper {
	return Object.assign(fn, { table });
}

// ─── row-reading helpers (mirror promote.ts's own; see the note above) ─────

const text = (row: StagedRow, column: string): string | null => {
	const v = row.raw[column];
	return v && v.trim() ? v.trim() : null;
};

const date = (row: StagedRow, column: string): string | null =>
	parseSourceDate(row.raw[column] ?? '')?.date ?? null;

/** Decimal readings such as a reference bound of 6.5, which parseInt would truncate. */
const numeric = (row: StagedRow, column: string): number | null => {
	const raw = (row.raw[column] ?? '').trim();
	if (!raw) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
};

/** The body is the richer content and goes first, but the column is kept when both exist. */
const withBody = (row: StagedRow, column: string | null): string | null => {
	const columnValue = column ? text(row, column) : null;
	if (row.body && columnValue) return `${row.body}\n\n---\n\n${columnValue}`;
	return row.body ?? columnValue;
};

/** "Bloodwork, Fasting" is how the source spells a multi-select. */
const multi = (row: StagedRow, column: string): string[] => {
	const raw = text(row, column);
	if (!raw) return [];
	return raw
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
};

/** A money amount written the way the source writes it: "CA$150.00". */
function money(row: StagedRow, column: string): { amount: number | null; currency: string } {
	const raw = (row.raw[column] ?? '').trim();
	if (!raw) return { amount: null, currency: 'CAD' };

	const currency = /^([A-Z]{2,3})\s*\$/.exec(raw)?.[1];
	const digits = raw.replace(/[^0-9.]/g, '');
	const amount = digits ? Number(digits) : null;

	return {
		amount: amount !== null && Number.isFinite(amount) ? amount : null,
		currency: currency === 'CA' || !currency ? 'CAD' : currency
	};
}

/**
 * The instant a Notion date-time names, as an ISO string, read in the
 * household's own zone rather than the process's -- see promote.ts's own
 * `sourceInstant` (2026-09-24) for why a bare `Date.parse` is wrong here: a
 * visit's "September 25, 2026 2:40 PM (EDT)" would otherwise land on a
 * different UTC instant depending on which host happened to run the import.
 */
function sourceInstant(raw: string, timeZone: string): string | null {
	const value = raw.trim();
	if (!value) return null;

	const utcMarked = /\(UTC\)\s*$/i.test(value);
	const explicitZone = utcMarked || /(?:Z|[+-]\d{2}:?\d{2}|\bUTC|\bGMT)\s*$/i.test(value);
	if (explicitZone) {
		const parsed = Date.parse(
			utcMarked ? `${value.replace(/\(UTC\)\s*$/i, '').trim()} UTC` : value
		);
		return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
	}

	// Pinning the string to UTC reads its wall-clock parts without a zone...
	const wall = Date.parse(`${value} UTC`);
	if (!Number.isFinite(wall)) return null;
	// ...which are then placed in the household's zone. The offset is taken at
	// the wall time and re-taken once at the result, which settles every
	// instant except the hour a DST change skips or repeats.
	let instant = wall - zoneOffset(wall, timeZone);
	instant = wall - zoneOffset(instant, timeZone);
	return new Date(instant).toISOString();
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
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

const timestamp = (row: StagedRow, column: string, o: PromoteOptions): string | null =>
	sourceInstant(row.raw[column] ?? '', o.timeZone ?? 'America/Toronto');

// ─── mappers ────────────────────────────────────────────────────────────────

/**
 * Lab Markers Database -> lab_markers.
 *
 * "Results" is a rollup over Lab Results and is not read here; it would be a
 * second, staler copy of what `lab_results.marker_id` already answers by
 * query. Neither database in this export marks a row Archived, so archival
 * is left to its column default rather than read from a property that does
 * not exist here (compare `upsertMealPlans` in promote.ts, which does the
 * same for the same reason).
 */
export const mapLabMarker = mapper('lab_markers', async (sql, row, o) => {
	const [r] = await sql<{ id: string }[]>`
		insert into lab_markers (household_id, owner_user_id, name, units, reference_low,
		                         reference_high, notes, notion_page_id, source_record_id,
		                         created_by)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'}, ${text(row, 'Units')},
		        ${numeric(row, 'Reference Low')}, ${numeric(row, 'Reference High')},
		        ${withBody(row, 'Notes')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			name = excluded.name,
			units = excluded.units,
			reference_low = excluded.reference_low,
			reference_high = excluded.reference_high,
			notes = excluded.notes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

/**
 * Lab Results Database -> lab_results.
 *
 * "Out of Range?" is a formula over the value and the marker's reference
 * range and is not read here; see `rangeStatus` in the repository, which
 * computes the same answer on demand so it can never go stale against an
 * edited range. "Lab Test" and "Medical Visit" are relations, resolved in
 * promote.ts's second pass rather than here -- see the file header.
 */
export const mapLabResult = mapper('lab_results', async (sql, row, o) => {
	const resultDate = date(row, 'Date');
	const value = numeric(row, 'Value');
	// A result with no date cannot be placed and one with no value has nothing
	// to plot or flag; either missing means there is nothing to store yet.
	if (!resultDate || value === null) return null;

	const [r] = await sql<{ id: string }[]>`
		insert into lab_results (household_id, owner_user_id, result_date, value, notes,
		                         notion_page_id, source_record_id, created_by)
		values (${o.householdId}, null, ${resultDate}, ${value}, ${withBody(row, 'Notes')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			result_date = excluded.result_date,
			value = excluded.value,
			notes = excluded.notes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

/**
 * Medical Visit Log Database -> medical_visits.
 *
 * Was `NOT_IMPORTED`/`EMPTY_PLACEHOLDERS` in promote.ts while the database
 * held one empty placeholder row; it now holds a real visit, so it moves to
 * `MAPPERS` here (see promote.ts's registration). "Daily Log" and "Symptoms"
 * are relations, resolved in promote.ts's second pass.
 */
export const mapMedicalVisit = mapper('medical_visits', async (sql, row, o) => {
	const visitAt = timestamp(row, 'Date', o);
	// A visit's identity is when it happened; without that there is nothing to
	// place on an appointments list.
	if (!visitAt) return null;
	const { amount, currency } = money(row, 'Cost');

	const [r] = await sql<{ id: string }[]>`
		insert into medical_visits (household_id, owner_user_id, reason, visit_at, visit_type,
		                            provider, location, amount, currency, paid_by, requirements,
		                            family_member, notes, notion_page_id, source_record_id,
		                            created_by)
		values (${o.householdId}, null, ${row.title ?? 'Untitled'}, ${visitAt}::timestamptz,
		        ${text(row, 'Visit Type')}, ${text(row, 'Provider')}, ${text(row, 'Location')},
		        ${amount}::numeric, ${currency}, ${text(row, 'Paid by?')},
		        ${multi(row, 'Requirements')}::text[], ${text(row, 'Family Member')},
		        ${withBody(row, 'Notes')},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			reason = excluded.reason,
			visit_at = excluded.visit_at,
			visit_type = excluded.visit_type,
			provider = excluded.provider,
			location = excluded.location,
			amount = excluded.amount,
			currency = excluded.currency,
			paid_by = excluded.paid_by,
			requirements = excluded.requirements,
			family_member = excluded.family_member,
			notes = excluded.notes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});
