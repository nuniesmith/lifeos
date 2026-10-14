import type { Sql, TransactionSql } from 'postgres';
import { parseSourceBoolean, parseSourceDate } from '../csv.ts';
import type { PromoteOptions } from '../promote.ts';

/**
 * Row-reading helpers shared by the mapper files added for the 2026-10-14
 * export (reading.ts, routines.ts, life-admin.ts).
 *
 * labs-visits.ts and medications.ts each keep a private copy of the same
 * helpers, for the reason their headers give: promote.ts imports the mapper
 * files, so a mapper importing a VALUE back from promote.ts would be circular.
 * This file imports nothing at runtime from promote.ts (the PromoteOptions
 * import is type-only and erased), so the newer mappers share one copy here
 * instead of adding a third and fourth.
 */

export type Queryable = Sql | TransactionSql;

export interface StagedRow {
	id: string;
	notion_page_id: string | null;
	database_name: string;
	database_notion_id: string | null;
	title: string | null;
	raw: Record<string, string>;
	body: string | null;
}

export type MapFn = (
	sql: Queryable,
	row: StagedRow,
	options: PromoteOptions
) => Promise<string | null>;
export type Mapper = MapFn & { table: string };

/** Tags a mapping function with the table it writes to, as promote.ts's own. */
export function mapper(table: string, fn: MapFn): Mapper {
	return Object.assign(fn, { table });
}

export const text = (row: StagedRow, column: string): string | null => {
	const v = row.raw[column];
	return v && v.trim() ? v.trim() : null;
};

/** The first column of several that has a value -- for a column Notion renamed. */
export const firstText = (row: StagedRow, ...columns: string[]): string | null => {
	for (const column of columns) {
		const v = text(row, column);
		if (v) return v;
	}
	return null;
};

export const date = (row: StagedRow, column: string): string | null =>
	parseSourceDate(row.raw[column] ?? '')?.date ?? null;

export const bool = (row: StagedRow, column: string): boolean =>
	parseSourceBoolean(row.raw[column] ?? '') === true;

/** Decimal readings; `CA$12.50` and `7.1%` keep their number. */
export const numeric = (row: StagedRow, column: string): number | null => {
	const raw = (row.raw[column] ?? '')
		.replace(/^[A-Z]{0,3}\$/, '')
		.replace(/[,%]/g, '')
		.trim();
	if (!raw) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
};

export const int = (row: StagedRow, column: string): number | null => {
	const n = numeric(row, column);
	return n === null ? null : Math.round(n);
};

/** The body is the richer content and goes first, but the column is kept when both exist. */
export const withBody = (row: StagedRow, column: string | null): string | null => {
	const columnValue = column ? text(row, column) : null;
	if (row.body && columnValue) return `${row.body}\n\n---\n\n${columnValue}`;
	return row.body ?? columnValue;
};

/**
 * A multi-select or relation cell as its display names.
 *
 * A relation cell reads `Name (path/Name <id>.md), Other (path/...)`: the
 * link targets are dropped first, since a title may itself contain a comma
 * but a link target never sits outside its parentheses.
 */
export const names = (row: StagedRow, column: string): string[] => {
	const raw = text(row, column);
	if (!raw) return [];
	const stripped = raw.replace(/\s*\([^()]*\.(?:md|csv)\)/g, '');
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of stripped.split(',')) {
		const name = part.trim();
		if (!name || seen.has(name.toLowerCase())) continue;
		seen.add(name.toLowerCase());
		out.push(name);
	}
	return out;
};

const NOTION_ID = /(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])/g;

/**
 * The Notion page ids a relation cell links to, in order, as uuids.
 *
 * For the few mappers that need a related row's id in the FIRST pass, because
 * the column it fills is NOT NULL (a read's book, a step's routine). Every
 * other relation waits for promote.ts's second pass. The cell is URL-decoded
 * first: an id written after `%20` would otherwise read as `20` plus thirty
 * hex digits of the id.
 */
export const linkedPageIds = (row: StagedRow, column: string): string[] => {
	const raw = row.raw[column];
	if (!raw) return [];
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		// A stray `%` in a title: read the cell as written.
	}
	const ids: string[] = [];
	for (const m of decoded.matchAll(NOTION_ID)) {
		const h = m[1] ?? '';
		const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
		if (!ids.includes(uuid)) ids.push(uuid);
	}
	return ids;
};

/** Archive checkboxes are spelled three ways across the workspace. */
export const archivedAt = (row: StagedRow): string | null =>
	bool(row, 'Archive') || bool(row, 'Archive?') || bool(row, 'Archive Item')
		? new Date().toISOString()
		: null;
