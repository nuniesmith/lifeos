/**
 * CSV parsing for the Notion export (IMP-002).
 *
 * Hand-written rather than pulled from a dependency: the parsing rules needed
 * here are narrow, the whole corpus is 436 rows, and every hazard is already
 * characterised (plan §7). The relation-cell grammar below is specific to this
 * export and no general parser would handle it anyway.
 */

/** Strips a UTF-8 BOM. Every first column in this export carries one. */
export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * RFC 4180 parse. Handles quoted fields containing commas, newlines, and
 * escaped double quotes — all three occur in this export, which is why row
 * counts must never come from counting lines.
 */
export function parseCsv(input: string): string[][] {
	const text = stripBom(input);
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	let i = 0;

	const endField = () => {
		row.push(field);
		field = '';
	};
	const endRow = () => {
		endField();
		rows.push(row);
		row = [];
	};

	while (i < text.length) {
		const c = text[i]!;

		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}

		if (c === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (c === ',') {
			endField();
			i++;
			continue;
		}
		if (c === '\r') {
			// Normalise CRLF and a bare CR.
			if (text[i + 1] === '\n') i++;
			endRow();
			i++;
			continue;
		}
		if (c === '\n') {
			endRow();
			i++;
			continue;
		}
		field += c;
		i++;
	}

	// A trailing newline must not produce a phantom final row.
	if (field.length > 0 || row.length > 0) endRow();

	return rows;
}

export interface CsvTable {
	headers: string[];
	rows: Record<string, string>[];
}

/** Parses into records keyed by header. Duplicate headers keep the first. */
export function parseCsvTable(input: string): CsvTable {
	const raw = parseCsv(input);
	if (raw.length === 0) return { headers: [], rows: [] };

	const headers = (raw[0] ?? []).map((h) => h.trim());
	const rows = raw.slice(1).map((cells) => {
		const record: Record<string, string> = {};
		headers.forEach((h, idx) => {
			if (!(h in record)) record[h] = cells[idx] ?? '';
		});
		return record;
	});
	return { headers, rows };
}

// ─── relation cells ────────────────────────────────────────────────────────

/**
 * A 32-hex Notion id, anchored so it cannot start mid-run.
 *
 * The lookarounds are load-bearing. Percent-encoding digits are themselves
 * valid hex, so in `Sweet%20Potato%203c8879a5…` an unanchored match starts at
 * the `20` of `%20` and returns a 32-character id that is off by two.
 */
const NOTION_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/;

export interface RelationRef {
	/** Display text. Not a key — this export has duplicate titles. */
	title: string;
	/** The 32-hex Notion id, the only reliable identifier. */
	notionId: string;
	/** The percent-decoded path, retained for provenance. */
	path: string;
}

/**
 * Parses a relation cell.
 *
 * The grammar is `Title (Percent%20Encoded%20Path/Name%20<32hex>.csv)`, joined
 * by `, ` when multi-valued. Splitting on `, ` is wrong: 32 titles in this
 * export contain commas ("Mira Castellan, NP", "@August 9, 2026"). Matching the
 * parenthesised group instead makes the separator irrelevant.
 */
export function parseRelationCell(value: string): RelationRef[] {
	if (!value || !value.includes('(')) return [];

	const refs: RelationRef[] = [];
	let i = 0;
	let titleStart = 0;

	while (i < value.length) {
		if (value[i] !== '(') {
			i++;
			continue;
		}

		// Scan to the matching close paren, tracking depth. A regex cannot do
		// this: paths in this export contain parentheses of their own, e.g.
		// "Tags & Topics (Resources) Database". Matching to the first `)`
		// dropped every tag relation — 19 cells — without any error.
		let depth = 0;
		let j = i;
		for (; j < value.length; j++) {
			if (value[j] === '(') depth++;
			else if (value[j] === ')') {
				depth--;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) break; // unbalanced; stop rather than guess

		const rawPath = value.slice(i + 1, j);
		const rawTitle = value
			.slice(titleStart, i)
			.replace(/^[\s,]+/, '')
			.trim();

		// Decode before extracting the id: percent-escapes are hex too, so
		// matching against the encoded form finds an id shifted by two.
		let path = rawPath;
		try {
			path = decodeURIComponent(rawPath);
		} catch {
			// Leave it encoded rather than dropping the reference.
		}

		const id = NOTION_ID.exec(path)?.[0] ?? NOTION_ID.exec(rawPath)?.[0];
		// A parenthetical without a Notion id is ordinary text, not a relation.
		if (id) refs.push({ title: rawTitle, notionId: id, path });

		i = j + 1;
		titleStart = i;
	}

	return refs;
}

/** True when a cell looks like a relation rather than plain text. */
export function isRelationCell(value: string): boolean {
	return parseRelationCell(value).length > 0;
}

/** Formats a 32-hex Notion id as a UUID so it can be stored in a uuid column. */
export function notionIdToUuid(id: string): string {
	if (!/^[0-9a-f]{32}$/.test(id)) throw new TypeError(`not a Notion id: ${id}`);
	return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join(
		'-'
	);
}

/** Extracts the Notion id from an export filename, when present. */
export function notionIdFromFilename(name: string): string | null {
	return NOTION_ID.exec(name)?.[0] ?? null;
}

// ─── scalar values ─────────────────────────────────────────────────────────

/**
 * Parses the human-formatted dates this export uses, e.g.
 * "July 30, 2026 2:57 PM" and "August 31, 2026". There is no timezone in the
 * source, so the caller supplies the household one rather than letting the
 * host's locale decide.
 */
export function parseSourceDate(value: string): { date: string; hasTime: boolean } | null {
	const text = value.trim();
	if (!text) return null;

	const parsed = Date.parse(text);
	if (Number.isNaN(parsed)) return null;

	const d = new Date(parsed);
	const iso = [
		d.getFullYear(),
		String(d.getMonth() + 1).padStart(2, '0'),
		String(d.getDate()).padStart(2, '0')
	].join('-');

	return { date: iso, hasTime: /\d:\d/.test(text) };
}

/** Notion writes checkboxes as Yes/No. Anything else is treated as unset. */
export function parseSourceBoolean(value: string): boolean | null {
	const v = value.trim().toLowerCase();
	if (v === 'yes' || v === 'true' || v === 'checked') return true;
	if (v === 'no' || v === 'false' || v === 'unchecked') return false;
	return null;
}

/**
 * A Notion review cadence, which is sometimes a number and sometimes a word.
 *
 * Goals and projects store "Set Review Frequency" / "Review Frequency in Days"
 * as an integer, but areas use a select whose options are words — Month,
 * Quarter, 6 Months, Year. `parseInt('Month')` is NaN, so reading all three as
 * integers silently dropped the cadence from every one of the fifteen areas in
 * the export and left the review page with nothing to compute from.
 *
 * The day counts approximate calendar arithmetic: Notion adds a month, so an
 * area reviewed 1 August next falls due 1 September where 30 days lands on
 * 31 August. See migration 0009 for why a day of drift is acceptable here.
 */
const CADENCE_DAYS: Record<string, number> = {
	day: 1,
	daily: 1,
	week: 7,
	weekly: 7,
	fortnight: 14,
	'2 weeks': 14,
	month: 30,
	monthly: 30,
	'3 months': 91,
	quarter: 91,
	quarterly: 91,
	'6 months': 182,
	'half year': 182,
	year: 365,
	yearly: 365,
	annually: 365
};

export function parseReviewCadence(value: string): number | null {
	const raw = value.trim();
	if (!raw) return null;

	// A bare number wins, so "30" keeps meaning thirty days.
	if (/^\d+\s*(days?)?$/i.test(raw)) {
		const n = Number.parseInt(raw, 10);
		if (Number.isFinite(n) && n > 0) return n;
	}

	return CADENCE_DAYS[raw.toLowerCase()] ?? null;
}

/**
 * A Notion date-range property, such as `Jul 30 \u2192 Aug 12`.
 *
 * The year is omitted whenever the range sits in the current year, which makes
 * each half unparseable alone — `Date.parse('Jul 30')` lands in 2001. The
 * caller supplies the year from the row's own `Year` relation, falling back to
 * its created timestamp. A range that already names its years is left alone.
 */
export function parseSourceRange(
	value: string | null,
	fallbackYear: number | null
): { start: string | null; end: string | null } {
	if (!value) return { start: null, end: null };
	const [rawStart, rawEnd] = value.split(/\s*(?:\u2192|->|\u2013|\u2014)\s*/, 2);

	const one = (part: string | undefined): string | null => {
		if (!part?.trim()) return null;
		if (/\d{4}/.test(part)) return parseSourceDate(part)?.date ?? null;

		// No year in the text and none to supply: refuse. Handing the bare
		// fragment to Date.parse looks like it works and quietly returns 2001,
		// which is worse than admitting the date is unknown.
		if (!fallbackYear) return null;
		return parseSourceDate(`${part.trim()}, ${fallbackYear}`)?.date ?? null;
	};

	return { start: one(rawStart), end: one(rawEnd) };
}
