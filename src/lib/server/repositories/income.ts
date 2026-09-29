import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	InvalidInput,
	baseColumns,
	getScoped,
	guarded,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toDay,
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
import { optionalNumber, optionalText, patched, requiredDay, requiredText } from './validate';

/**
 * Income (PACK4-002, the Financial Hub).
 *
 * The source's Income database was a pair of rollup formulas over nothing —
 * see migration 0029 — so this is built with no import to match: whatever a
 * household logs here is the first income record LifeOS has ever held for it.
 * Kept in its own module rather than folded into `collections.ts` because
 * nothing here references bills, wishlist, people or watchlist rows, unlike
 * that module's own reason for grouping four tables together.
 */

export interface IncomeEntry extends RecordBase {
	title: string;
	source: string | null;
	type: string | null;
	expectedAmount: number | null;
	actualAmount: number | null;
	/** actual − expected, only when both are recorded — the same "derived,
	 *  never stored" treatment `Bill.monthlyEquivalent` gets. */
	difference: number | null;
	receivedOn: string;
	currency: string;
	notes: string | null;
}

interface IncomeEntryRow extends BaseRow {
	title: string;
	source: string | null;
	type: string | null;
	expected_amount: unknown;
	actual_amount: unknown;
	received_on: string;
	currency: string;
	notes: string | null;
}

const INCOME_ENTRIES = 'income_entries';

const incomeColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	title, source, type, expected_amount, actual_amount,
	received_on::text as received_on, currency, notes`;

function mapIncomeEntry(row: IncomeEntryRow): IncomeEntry {
	const expectedAmount = toNumberOrNull(row.expected_amount);
	const actualAmount = toNumberOrNull(row.actual_amount);
	return {
		...mapBase(row),
		title: toText(row.title),
		source: toTextOrNull(row.source),
		type: toTextOrNull(row.type),
		expectedAmount,
		actualAmount,
		difference:
			expectedAmount !== null && actualAmount !== null
				? Math.round((actualAmount - expectedAmount) * 100) / 100
				: null,
		receivedOn: toDay(row.received_on),
		currency: toText(row.currency),
		notes: toTextOrNull(row.notes)
	};
}

export interface IncomeEntryFilters extends PageOptions {
	/** Calendar days, inclusive. */
	from?: string;
	to?: string;
	includeArchived?: boolean;
}

/** Most recent first: unlike a bill, which is a thing still to happen, an
 *  income entry is a record of what already did. */
export async function listIncomeEntries(
	sql: Queryable,
	viewer: Viewer,
	filters: IncomeEntryFilters = {}
): Promise<IncomeEntry[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<IncomeEntryRow[]>`
		select ${incomeColumns(sql)} from ${sql(INCOME_ENTRIES)}
		where ${readableScope(sql, viewer, INCOME_ENTRIES)}
		  and ${liveScope(sql, INCOME_ENTRIES, filters.includeArchived)}
		  ${filters.from ? sql`and received_on >= ${filters.from}::date` : sql``}
		  ${filters.to ? sql`and received_on <= ${filters.to}::date` : sql``}
		order by received_on desc, created_at desc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapIncomeEntry);
}

export async function getIncomeEntry(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<IncomeEntry | null> {
	const row = await getScoped<IncomeEntryRow>(
		sql,
		INCOME_ENTRIES,
		id,
		readableScope(sql, viewer, INCOME_ENTRIES),
		incomeColumns(sql)
	);
	return row ? mapIncomeEntry(row) : null;
}

export interface IncomeEntryInput extends OwnershipInput {
	title?: unknown;
	source?: unknown;
	type?: unknown;
	expectedAmount?: unknown;
	actualAmount?: unknown;
	receivedOn?: unknown;
	currency?: unknown;
	notes?: unknown;
}

function nonNegativeAmount(value: unknown, field: string): number | null {
	const n = optionalNumber(value, field);
	if (n !== null && n < 0) throw new InvalidInput(`${field} must be zero or greater`);
	return n;
}

/** Mirrors the table's own CHECK: an entry with neither amount recorded is
 *  refused here with a field-level message before the database refuses it. */
function requireAnAmount(expected: number | null, actual: number | null): void {
	if (expected === null && actual === null) {
		throw new InvalidInput('enter an expected amount, an actual amount, or both');
	}
}

function currencyOf(value: unknown, fallback: string): string {
	if (value === undefined || value === null || value === '') return fallback;
	return String(value).toUpperCase().slice(0, 3);
}

export function createIncomeEntry(
	sql: Queryable,
	viewer: Viewer,
	input: IncomeEntryInput
): Promise<WriteResult<IncomeEntry>> {
	return guarded<IncomeEntry>(async () => {
		const title = requiredText(input.title, 'title', 200);
		const receivedOn = requiredDay(input.receivedOn, 'date');
		const expectedAmount = nonNegativeAmount(input.expectedAmount, 'expected amount');
		const actualAmount = nonNegativeAmount(input.actualAmount, 'actual amount');
		requireAnAmount(expectedAmount, actualAmount);

		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		const rows = await sql<IncomeEntryRow[]>`
			insert into ${sql(INCOME_ENTRIES)} (
				household_id, owner_user_id, visibility, title, source, type,
				expected_amount, actual_amount, received_on, currency, notes,
				created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title},
				${optionalText(input.source, 'source')}, ${optionalText(input.type, 'type')},
				${expectedAmount}::numeric, ${actualAmount}::numeric, ${receivedOn}::date,
				${currencyOf(input.currency, 'CAD')}, ${optionalText(input.notes, 'notes')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${incomeColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapIncomeEntry(row) };
	});
}

export function updateIncomeEntry(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: IncomeEntryInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<IncomeEntry>> {
	return guarded<IncomeEntry>(async () => {
		const current = await getIncomeEntry(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			title: patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 200)),
			source: patched(patch, 'source', current.source, (v) => optionalText(v, 'source')),
			type: patched(patch, 'type', current.type, (v) => optionalText(v, 'type')),
			expectedAmount: patched(patch, 'expectedAmount', current.expectedAmount, (v) =>
				nonNegativeAmount(v, 'expected amount')
			),
			actualAmount: patched(patch, 'actualAmount', current.actualAmount, (v) =>
				nonNegativeAmount(v, 'actual amount')
			),
			receivedOn: patched(patch, 'receivedOn', current.receivedOn, (v) => requiredDay(v, 'date')),
			currency: patched(patch, 'currency', current.currency, (v) =>
				currencyOf(v, current.currency)
			),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};
		requireAnAmount(next.expectedAmount, next.actualAmount);

		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<IncomeEntryRow, IncomeEntry>({
			sql,
			table: INCOME_ENTRIES,
			id,
			readScope: readableScope(sql, viewer, INCOME_ENTRIES),
			writeScope: writableScope(sql, viewer, INCOME_ENTRIES),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				title = ${next.title}, source = ${next.source}, type = ${next.type},
				expected_amount = ${next.expectedAmount}::numeric,
				actual_amount = ${next.actualAmount}::numeric,
				received_on = ${next.receivedOn}::date, currency = ${next.currency}, notes = ${next.notes},
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: incomeColumns(sql),
			map: mapIncomeEntry,
			mayWrite: writableBy(viewer)
		});
	});
}

/** "Delete": archived entries leave /finance but stay recoverable from the
 *  Archive, like everything else in LifeOS (base.ts's header). Hand-rolled
 *  rather than built on base.ts's `archiveScoped` because this table has no
 *  `updated_at` trigger — the same reason `setBillArchived` is hand-rolled. */
export function setIncomeEntryArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<IncomeEntry>> {
	return guarded<IncomeEntry>(async () =>
		writeScoped<IncomeEntryRow, IncomeEntry>({
			sql,
			table: INCOME_ENTRIES,
			id,
			readScope: readableScope(sql, viewer, INCOME_ENTRIES),
			writeScope: writableScope(sql, viewer, INCOME_ENTRIES),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: incomeColumns(sql),
			map: mapIncomeEntry,
			mayWrite: writableBy(viewer)
		})
	);
}

export interface IncomeMonthSummary {
	expectedTotal: number;
	actualTotal: number;
	currency: string;
	count: number;
}

/**
 * Expected vs. received for one calendar month, summed in SQL so the totals
 * are exact (base.ts rule 1; money is never added up in JS in this codebase).
 */
export async function incomeSummaryForMonth(
	sql: Queryable,
	viewer: Viewer,
	monthStart: string,
	monthEnd: string
): Promise<IncomeMonthSummary> {
	const rows = await sql<
		{ expected: string | null; actual: string | null; currency: string | null; total: number }[]
	>`
		select sum(expected_amount) as expected, sum(actual_amount) as actual,
		       min(currency) as currency, count(*)::int as total
		from ${sql(INCOME_ENTRIES)}
		where ${readableScope(sql, viewer, INCOME_ENTRIES)}
		  and archived_at is null
		  and received_on between ${monthStart}::date and ${monthEnd}::date
	`;
	const row = rows[0];
	return {
		expectedTotal: toNumberOrNull(row?.expected ?? null) ?? 0,
		actualTotal: toNumberOrNull(row?.actual ?? null) ?? 0,
		currency: row?.currency ?? 'CAD',
		count: row?.total ?? 0
	};
}
