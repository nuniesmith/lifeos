import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { DatePrecision } from '../../read-dates.ts';
import { parseCsvTable } from './csv.ts';
import { one } from '../db/scalar.ts';

/**
 * StoryGraph reading-history import (Reading Tracker R3b).
 *
 * The operator's StoryGraph export is brought in by a dedicated, operator-
 * only CLI (`scripts/import-storygraph.mjs`), never the Notion importer
 * (`run.ts`): that importer upserts by `notion_page_id`, and running it again
 * would overwrite the household's in-app edits on every table it covers.
 * This module only ever inserts into `books`, `authors` and `book_reads`,
 * and only for rows whose `storygraph_id` (migration 0037) is not already
 * present in the household, so re-running the same export is always safe.
 *
 * Two halves, deliberately separate:
 *  - {@link mapStorygraphRow} is pure -- one CSV row in, one book-plus-reads
 *    (or a row-level failure) out, no database. Every shape in the brief is
 *    exercised directly by the unit tests without a transaction to roll back.
 *  - {@link importStorygraph} is the database half: it reads what the pure
 *    half decided and writes it, one savepoint per row.
 *
 * Neither half imports `reading.ts` / `reading-log.ts`, even though several
 * rules here mirror theirs exactly (ISBN shape, quarter-star rounding, tag
 * cleaning, find-or-create-by-name). This file is executed directly by
 * plain Node with no build step, the same way `run.ts` already is (see that
 * file's own `DryRunComplete`): Node's strip-only TypeScript mode cannot
 * load `reading.ts`, which declares a constructor parameter property
 * (`BookWriteRefused`) that mode does not support. Every repository file in
 * `src/lib/server/import/` already avoids importing `repositories/*` for
 * the same reason -- this module keeps that boundary rather than being the
 * first to cross it.
 *
 * Mapping decisions worth stating up front:
 *  - StoryGraph dates are often partial: a year only ("2019") or a year and
 *    month ("2019/05") whenever the day was never entered, and in the
 *    operator's export these are most of the dated reads. They are kept, as
 *    the first day of the period plus a precision (migration 0037's
 *    `started_precision` / `finished_precision`), because dropping them
 *    would drop most of the reading history.
 *  - `to-read` produces no read at all. `did-not-finish` produces exactly
 *    one, dated the way the app's own "did not finish" dates one (the day
 *    reading stopped, as `finished_on`) when the export has a date for it.
 *    A `read` row always produces at least one finished read, undated if
 *    StoryGraph kept no usable date: the book was read either way.
 *  - `Star Rating` and `Review` land on the most recent read, by date, so a
 *    re-read's rating is never pinned to the first read-through.
 *  - An empty `Read Status` (StoryGraph lists a book that is only marked
 *    owned, for one) imports as `tbr`, the books table's own default, with a
 *    counted warning. A status this module does not recognise still refuses
 *    the row: guessing at a value nobody has seen would be worse.
 *  - A row with no `ISBN/UID` is keyed by its title and authors instead
 *    ({@link titleKey}), so a re-run still recognises it.
 *  - The five character-arc questions (`Character- or Plot-Driven?`,
 *    `Diverse Characters?`, `Flawed Characters?`, `Loveable Characters?`,
 *    `Strong Character Development?`) and `Contributors` are read by
 *    nothing here -- dropped on purpose, not missed. Notion's own three
 *    additions to this export (`Import Notes`, `Matched Book`,
 *    `Migration Status`) are likewise never referenced, which is also what
 *    lets a fresh StoryGraph export (without them) and Notion's copy (with
 *    them) both work: every cell below is read by header name, not position.
 */

// ─── value shapes (mirror reading.ts / reading-log.ts; see header above) ──

export const BOOK_STATUSES = ['tbr', 'reading', 'paused', 'read', 'dnf'] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];

export const BOOK_FORMATS = ['print', 'ebook', 'audiobook'] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

export const BOOK_PACES = ['slow', 'medium', 'fast'] as const;
export type BookPace = (typeof BOOK_PACES)[number];

export const READ_STATUSES = ['reading', 'paused', 'finished', 'dnf'] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

/**
 * ISBN-10 (an X check character allowed) or ISBN-13, stripped of hyphens and
 * spaces -- the exact rule `optionalIsbn` enforces in reading.ts. Returns
 * null rather than throwing: an invalid value here is never fatal to the row
 * (the brief's own "never fail the row for it"), so the caller decides what
 * null means -- in {@link mapStorygraphRow} it is a warning, not a stop.
 */
export function parseIsbn(raw: string): string | null {
	const stripped = raw.replace(/[-\s]/g, '').toUpperCase();
	if (!stripped) return null;
	return /^\d{9}[\dX]$|^\d{13}$/.test(stripped) ? stripped : null;
}

/**
 * StoryGraph rates in quarter stars; mirrors `optionalQuarterRating` in
 * reading.ts, which mirrors the table's own CHECK (`rating * 4 = round(rating
 * * 4)`). Returns null for anything out of range or off the quarter-step
 * grid rather than throwing, for the same reason {@link parseIsbn} does.
 */
export function parseQuarterRating(raw: string): number | null {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || n > 5) return null;
	const quarters = n * 4;
	if (Math.abs(quarters - Math.round(quarters)) > 1e-9) return null;
	return Math.round(quarters) / 4;
}

/**
 * Trims, drops blanks, and dedupes case-insensitively keeping the first
 * spelling -- the exact rule `cleanTextArray` enforces in reading.ts for
 * moods/tags/the author list, restricted to the one shape a CSV cell can
 * ever be (a comma-separated string, never an array).
 */
export function cleanTextArray(value: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of value.split(',')) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

const SG_PARTIAL_DATE = /^(\d{4})(?:\/(\d{2})(?:\/(\d{2}))?)?$/;

/** A StoryGraph date as the first day of the period it names, and how much
 *  of that day is real: `2019` is `2019-01-01` to the year. */
export interface PartialDate {
	day: string;
	precision: DatePrecision;
}

/** True for a day that exists, so `2019/02/30` is refused here as a warning
 *  rather than failing the whole row when PostgreSQL refuses it at insert.
 *  The `Date` only checks the calendar; it never reaches SQL (hard rule 2). */
function isCalendarDay(year: number, month: number, day: number): boolean {
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

/**
 * Reads StoryGraph's `YYYY/MM/DD`, `YYYY/MM` or `YYYY` as the `YYYY-MM-DD`
 * day string this app's `date` columns use everywhere (hard rule 2), padded
 * to the first day of the period, with the precision that says so.
 */
export function parseStorygraphPartialDate(value: string): PartialDate | null {
	const m = SG_PARTIAL_DATE.exec(value.trim());
	if (!m) return null;
	const [, year, month, day] = m;
	if (!isCalendarDay(Number(year), Number(month ?? '01'), Number(day ?? '01'))) return null;
	return {
		day: `${year}-${month ?? '01'}-${day ?? '01'}`,
		precision: day ? 'day' : month ? 'month' : 'year'
	};
}

/**
 * A whole StoryGraph day (`YYYY/MM/DD`) as `YYYY-MM-DD`, or null. For a
 * column with no precision of its own (`books.tbr_added_on`), where a
 * year-only value has nowhere to say it is one.
 */
export function parseStorygraphDate(value: string): string | null {
	const parsed = parseStorygraphPartialDate(value);
	return parsed?.precision === 'day' ? parsed.day : null;
}

/** The last day of a partial date's period: `2019` ends on `2019-12-31`. */
function periodEnd(date: PartialDate): string {
	if (date.precision === 'day') return date.day;
	const [year, month] = date.day.split('-').map(Number) as [number, number];
	// Day 0 of the following month is the last day of this one.
	const end =
		date.precision === 'year'
			? new Date(Date.UTC(year, 11, 31))
			: new Date(Date.UTC(year, month, 0));
	return end.toISOString().slice(0, 10);
}

const SG_PART = String.raw`\d{4}(?:\/\d{2}(?:\/\d{2})?)?`;
const SG_RANGE = new RegExp(String.raw`^(${SG_PART})\s*-\s*(${SG_PART})$`);

interface DatesReadEntry {
	/** Null for a lone date -- see {@link buildReads}, the one place that
	 *  decides what a lone date means for a given Read Status. */
	start: PartialDate | null;
	end: PartialDate;
}

/**
 * Splits `Dates Read` on its commas and parses each entry as a range or a
 * lone date, either side of a range as precise as StoryGraph kept it. An
 * entry that is neither comes back as null so the caller can warn about it
 * and move on, rather than this function guessing.
 */
function parseDatesReadEntries(value: string): (DatesReadEntry | null)[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	return trimmed.split(',').map((part) => {
		const p = part.trim();
		if (!p) return null;
		const range = SG_RANGE.exec(p);
		if (range) {
			const start = parseStorygraphPartialDate(range[1]!);
			const end = parseStorygraphPartialDate(range[2]!);
			return start && end ? { start, end } : null;
		}
		const lone = parseStorygraphPartialDate(p);
		return lone ? { start: null, end: lone } : null;
	});
}

export interface RowWarning {
	row: number;
	field: string;
	message: string;
}

/** A read's two dates as they will be stored: see migration 0037 for why a
 *  partial date is its period's first day plus a precision. */
interface ReadDates {
	startedOn: string | null;
	startedPrecision: DatePrecision;
	finishedOn: string | null;
	finishedPrecision: DatePrecision;
}

export interface ParsedRead extends ReadDates {
	status: ReadStatus;
	rating: number | null;
	review: string | null;
}

const UNDATED: ReadDates = {
	startedOn: null,
	startedPrecision: 'day',
	finishedOn: null,
	finishedPrecision: 'day'
};

const newRead = (status: ReadStatus, dates: ReadDates): ParsedRead => ({
	status,
	...dates,
	rating: null,
	review: null
});

/**
 * One `Dates Read` entry as a read's dates, or null when it ends before it
 * starts. Both dates are stored as the first day of their period, so a start
 * inside a coarser end's period ("2019/05/20-2019/05") would sit after that
 * end's first day and break the table's finished-after-started CHECK. The
 * finish then takes the start's day instead: still inside its own period, so
 * its precision stays true.
 */
function entryDates(entry: DatesReadEntry): ReadDates | null {
	const { start, end } = entry;
	if (!start) {
		return { ...UNDATED, finishedOn: end.day, finishedPrecision: end.precision };
	}
	if (start.day > periodEnd(end)) return null;
	return {
		startedOn: start.day,
		startedPrecision: start.precision,
		finishedOn: start.day > end.day ? start.day : end.day,
		finishedPrecision: end.precision
	};
}

/** Oldest first; an undated read sorts before every dated one. Day strings
 *  compare correctly as text because they are all `YYYY-MM-DD`. */
const byFinish = (a: ReadDates, b: ReadDates): number => {
	const x = a.finishedOn ?? '';
	const y = b.finishedOn ?? '';
	return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Builds the reads one row implies, following the per-status rules in this
 * module's header. Takes `Last Date Read` already parsed, as the fallback
 * date when `Dates Read` offers nothing usable, so this function has one
 * job: deciding how many reads and which dates. Returns them oldest first,
 * which is what lets the caller put the rating on the most recent.
 */
function buildReads(
	row: number,
	status: BookStatus,
	datesReadRaw: string,
	lastDateRead: PartialDate | null
): { reads: ParsedRead[]; warnings: RowWarning[] } {
	const warnings: RowWarning[] = [];
	const dated: ReadDates[] = [];
	for (const entry of parseDatesReadEntries(datesReadRaw)) {
		const dates = entry ? entryDates(entry) : null;
		if (dates) dated.push(dates);
		else
			warnings.push({
				row,
				field: 'Dates Read',
				message: entry
					? 'a range ends before it starts and was skipped'
					: 'an entry could not be parsed and was skipped'
			});
	}
	// Sorted rather than trusted to arrive in order, so "most recent" means
	// the latest date whatever order the export listed the entries in. The
	// sort is stable, so equal dates keep the export's order.
	dated.sort(byFinish);
	const latest = dated[dated.length - 1] ?? null;
	const fallback: ReadDates = lastDateRead
		? { ...UNDATED, finishedOn: lastDateRead.day, finishedPrecision: lastDateRead.precision }
		: UNDATED;

	if (status === 'read') {
		const reads = dated.map((dates) => newRead('finished', dates));
		return { reads: reads.length > 0 ? reads : [newRead('finished', fallback)], warnings };
	}

	if (status === 'dnf') {
		// Dated like the app's own `dnfRead` (reading-log.ts), which records the
		// day reading stopped as `finished_on`: the latest entry, else Last
		// Date Read, else no date at all.
		return { reads: [newRead('dnf', latest ?? fallback)], warnings };
	}

	if (status === 'reading' || status === 'paused') {
		// An open read can never carry `finished_on` (migration 0033's CHECK
		// allows it only on finished and dnf reads), so only a start is taken:
		// the latest entry's start, or its one date when StoryGraph kept only
		// one, which for a book still being read is when it began.
		const startedOn = latest ? (latest.startedOn ?? latest.finishedOn) : null;
		const startedPrecision = latest?.startedOn
			? latest.startedPrecision
			: (latest?.finishedPrecision ?? 'day');
		return {
			reads: [newRead(status, { ...UNDATED, startedOn, startedPrecision })],
			warnings
		};
	}

	// 'tbr': no read at all.
	return { reads: [], warnings };
}

export interface ParsedBook {
	title: string;
	authorNames: string[];
	isbn: string | null;
	/** Never null: the row's `ISBN/UID`, or {@link titleKey} without one. */
	storygraphId: string;
	format: BookFormat | null;
	status: BookStatus;
	tbrAddedOn: string | null;
	rating: number | null;
	moods: string[];
	tags: string[];
	pace: BookPace | null;
	contentWarnings: string | null;
	owned: boolean;
	reads: ParsedRead[];
}

export interface MappedRow {
	/** Null means the row could not be mapped at all (see `warnings` for
	 *  why) -- a row-level failure, counted by the caller as a failure
	 *  rather than attempted. */
	book: ParsedBook | null;
	warnings: RowWarning[];
}

const READ_STATUS_TO_BOOK_STATUS: Readonly<Record<string, BookStatus>> = {
	read: 'read',
	'currently-reading': 'reading',
	'to-read': 'tbr',
	'did-not-finish': 'dnf',
	paused: 'paused'
};

const SG_FORMAT_TO_BOOK_FORMAT: Readonly<Record<string, BookFormat>> = {
	digital: 'ebook',
	audio: 'audiobook',
	paperback: 'print',
	hardcover: 'print',
	// Not one of StoryGraph's own options (its export uses "paperback" and
	// "hardcover"), but accepted too: the brief's mapping names it alongside
	// them explicitly, and it costs nothing to recognise a synonym no export
	// has used yet.
	print: 'print'
};

function joinContentWarnings(
	warnings: string | undefined,
	description: string | undefined
): string | null {
	const parts = [warnings, description].map((v) => (v ?? '').trim()).filter((v) => v.length > 0);
	return parts.length > 0 ? parts.join('\n\n') : null;
}

const TITLE_KEY_PREFIX = 'title:';

/**
 * The identity of a row with no `ISBN/UID` (about one in six in the
 * operator's export): a digest of its title and authors, so a re-run still
 * recognises it. Title alone is not a key -- two books can share one -- but
 * title and authors together named no two rows of that export. The prefix
 * keeps it apart from every real ISBN, ASIN and StoryGraph id.
 */
export function titleKey(title: string, authorNames: string[]): string {
	const basis = [title, ...authorNames].map((part) => part.trim().toLowerCase()).join('\u0000');
	return `${TITLE_KEY_PREFIX}${createHash('sha256').update(basis).digest('hex')}`;
}

/**
 * Maps one StoryGraph CSV row (already parsed to a header-keyed record --
 * `parseCsvTable` in csv.ts) to the book and reads it describes, or to a
 * row-level failure. Pure, so every case in the brief's own list is
 * exercised directly by the unit tests with no database involved.
 *
 * `row` is 1-based and counts only data rows -- what a household member
 * opening the CSV in a spreadsheet would call "row 2" for the first book --
 * so a warning naming it matches what they would see on screen.
 */
export function mapStorygraphRow(cells: Record<string, string>, row: number): MappedRow {
	const warnings: RowWarning[] = [];

	const title = (cells['Title'] ?? '').trim();
	if (!title) {
		warnings.push({ row, field: 'Title', message: 'missing; the row was not imported' });
		return { book: null, warnings };
	}

	const statusRaw = (cells['Read Status'] ?? '').trim().toLowerCase();
	const status = statusRaw ? READ_STATUS_TO_BOOK_STATUS[statusRaw] : 'tbr';
	if (!status) {
		warnings.push({
			row,
			field: 'Read Status',
			message: 'not a recognised value; the row was not imported'
		});
		return { book: null, warnings };
	}
	if (!statusRaw) {
		warnings.push({ row, field: 'Read Status', message: 'empty; imported as tbr' });
	}

	const authorNames = cleanTextArray(cells['Authors'] ?? '');

	// `ISBN/UID` is an ISBN-13, an ISBN-10 or an ASIN (a Kindle edition's
	// Amazon id). Whatever it is, it is kept verbatim as storygraph_id
	// (migration 0037 -- what makes a re-run idempotent), and also as the
	// ISBN when it is one. An ASIN is expected, so it earns no warning.
	const uidRaw = (cells['ISBN/UID'] ?? '').trim();
	const storygraphId = uidRaw || titleKey(title, authorNames);
	const isbn = uidRaw ? parseIsbn(uidRaw) : null;

	const formatRaw = (cells['Format'] ?? '').trim().toLowerCase();
	const format = SG_FORMAT_TO_BOOK_FORMAT[formatRaw] ?? null;

	const dateAddedRaw = (cells['Date Added'] ?? '').trim();
	const tbrAddedOn = dateAddedRaw ? parseStorygraphDate(dateAddedRaw) : null;
	if (dateAddedRaw && tbrAddedOn === null) {
		warnings.push({ row, field: 'Date Added', message: 'not a recognised date; left blank' });
	}

	const ratingRaw = (cells['Star Rating'] ?? '').trim();
	const rating = ratingRaw ? parseQuarterRating(ratingRaw) : null;
	if (ratingRaw && rating === null) {
		warnings.push({ row, field: 'Star Rating', message: 'not a quarter-star value; left blank' });
	}

	const moods = cleanTextArray(cells['Moods'] ?? '');
	const tags = cleanTextArray(cells['Tags'] ?? '');

	const paceRaw = (cells['Pace'] ?? '').trim().toLowerCase();
	const pace = (BOOK_PACES as readonly string[]).includes(paceRaw) ? (paceRaw as BookPace) : null;

	const contentWarnings = joinContentWarnings(
		cells['Content Warnings'],
		cells['Content Warning Description']
	);
	const owned = (cells['Owned?'] ?? '').trim().toLowerCase() === 'yes';

	const lastDateReadRaw = (cells['Last Date Read'] ?? '').trim();
	const lastDateRead = lastDateReadRaw ? parseStorygraphPartialDate(lastDateReadRaw) : null;
	if (lastDateReadRaw && lastDateRead === null) {
		warnings.push({ row, field: 'Last Date Read', message: 'not a recognised date; ignored' });
	}

	const built = buildReads(row, status, cells['Dates Read'] ?? '', lastDateRead);
	warnings.push(...built.warnings);
	const reads = built.reads;

	// The rating and review belong to the most recent read only, and
	// buildReads returns its reads oldest first, by date.
	const review = (cells['Review'] ?? '').trim() || null;
	const mostRecent = reads[reads.length - 1];
	if (mostRecent) {
		mostRecent.rating = rating;
		mostRecent.review = review;
	}

	const book: ParsedBook = {
		title,
		authorNames,
		isbn,
		storygraphId,
		format,
		status,
		tbrAddedOn,
		rating,
		moods,
		tags,
		pace,
		contentWarnings,
		owned,
		reads
	};
	return { book, warnings };
}

// ─── the database half ─────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
	return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

/**
 * A database error by its code and constraint only. PostgreSQL's own message
 * can quote the offending value ("invalid input syntax for type date:
 * ..."), and this report must never carry cell content (hard rule 1).
 */
function describeDbError(err: unknown): string {
	if (typeof err !== 'object' || err === null) return 'unexpected error';
	const { code, constraint_name: constraint } = err as {
		code?: unknown;
		constraint_name?: unknown;
	};
	const parts = [code, constraint].filter((part): part is string => typeof part === 'string');
	return parts.length > 0 ? parts.join(' ') : 'unexpected error';
}

/**
 * Finds a live author by case-insensitive name, or creates one -- the same
 * rule `findOrCreateAuthor` applies in reading.ts, reimplemented here rather
 * than imported (see this module's header). Rows of this import share one
 * transaction, so a later row's find already sees an earlier row's new
 * author; the retry is for someone adding the same author in the app while
 * the import runs, whose insert this one's unique index then refuses.
 */
async function findOrCreateAuthorId(
	sql: TransactionSql,
	householdId: string,
	userId: string,
	name: string
): Promise<{ id: string; created: boolean }> {
	const find = () => sql<{ id: string }[]>`
		select id from authors
		where household_id = ${householdId}::uuid and lower(trim(name)) = lower(trim(${name}))
		  and archived_at is null
		limit 1
	`;
	const existing = await find();
	if (existing[0]) return { id: existing[0].id, created: false };
	try {
		// A savepoint of its own: a unique violation aborts the savepoint it
		// happens in, and without this one that would be the row's, leaving
		// the retry below nothing to run in.
		const inserted = await sql.savepoint(
			(sp) => sp<{ id: string }[]>`
				insert into authors (household_id, name, created_by, updated_by)
				values (${householdId}::uuid, ${name}, ${userId}::uuid, ${userId}::uuid)
				returning id
			`
		);
		return { id: one(inserted, 'inserted author').id, created: true };
	} catch (err) {
		if (isUniqueViolation(err)) {
			const retry = await find();
			if (retry[0]) return { id: retry[0].id, created: false };
		}
		throw err;
	}
}

export interface StorygraphImportOptions {
	householdId: string;
	/** The operator: every book this import creates is owned by them, and
	 *  every read it creates is logged as theirs (the brief's "imported as
	 *  the operator's"). */
	userId: string;
	dryRun?: boolean;
	/** How many row-level warnings the summary keeps. The CLI's report is a
	 *  terminal line per entry, and a 2,288-row export could in principle
	 *  produce thousands; the brief asks only for "the first few". */
	maxWarnings?: number;
}

export interface StorygraphImportSummary {
	dryRun: boolean;
	rowsRead: number;
	booksCreated: number;
	/** Already imported: a live row in this household already carries this
	 *  storygraph_id (migration 0037), so nothing was read from this row at
	 *  all -- not even to check whether it agrees. */
	booksSkipped: number;
	booksFailed: number;
	/** Created books with no `ISBN/UID`, recognised on a re-run by
	 *  {@link titleKey} instead. */
	booksKeyedByTitle: number;
	authorsCreated: number;
	readsByStatus: Record<ReadStatus, number>;
	/** Capped at `maxWarnings`; never carries a title or any other cell
	 *  content (hard rule 1) -- only the row number and the field name. */
	warnings: RowWarning[];
	/** Every warning, counted by field and message, so the report shows the
	 *  whole picture where `warnings` shows only the first few rows. */
	warningCounts: Record<string, number>;
}

/** Carries a dry run's result out through the rollback -- the same device
 *  `run.ts` uses for the Notion importer's own dry run. */
class DryRunComplete extends Error {
	readonly summary: StorygraphImportSummary;
	constructor(summary: StorygraphImportSummary) {
		super('dry run complete');
		this.name = 'DryRunComplete';
		this.summary = summary;
	}
}

/**
 * Imports a StoryGraph export: one transaction for the whole run, rolled
 * back on a dry run (the same "dry run is a transaction that is rolled
 * back" rule `run.ts` documents) and one savepoint per row otherwise, so a
 * single bad row is a counted failure rather than losing the rest of the
 * file (hard rule 4).
 */
export async function importStorygraph(
	sql: Sql,
	csvText: string,
	options: StorygraphImportOptions
): Promise<StorygraphImportSummary> {
	const dryRun = options.dryRun ?? true;
	const maxWarnings = options.maxWarnings ?? 20;
	const { householdId, userId } = options;
	const table = parseCsvTable(csvText);

	return sql
		.begin(async (tx) => {
			let booksCreated = 0;
			let booksSkipped = 0;
			let booksFailed = 0;
			let booksKeyedByTitle = 0;
			let authorsCreated = 0;
			const readsByStatus: Record<ReadStatus, number> = {
				reading: 0,
				paused: 0,
				finished: 0,
				dnf: 0
			};
			const warnings: RowWarning[] = [];
			const warningCounts: Record<string, number> = {};
			const warn = (w: RowWarning) => {
				const key = `${w.field}: ${w.message}`;
				warningCounts[key] = (warningCounts[key] ?? 0) + 1;
				if (warnings.length < maxWarnings) warnings.push(w);
			};

			let rowsRead = 0;
			for (const cells of table.rows) {
				rowsRead++;
				const mapped = mapStorygraphRow(cells, rowsRead);
				for (const w of mapped.warnings) warn(w);
				const book = mapped.book;
				if (!book) {
					booksFailed++;
					continue;
				}

				try {
					// The row's own counts come back out of its savepoint and are only
					// added once it has committed, so a row that fails halfway (and
					// rolls back its new author with it) is not counted as having
					// created anything.
					const outcome = await tx.savepoint(async (row) => {
						const existing = await row<{ id: string }[]>`
							select id from books
							where household_id = ${householdId}::uuid
							  and storygraph_id = ${book.storygraphId}
							limit 1
						`;
						if (existing[0]) return { skipped: true, authorsCreated: 0 };

						let rowAuthorsCreated = 0;
						const authorIds: string[] = [];
						for (const name of book.authorNames) {
							const found = await findOrCreateAuthorId(row, householdId, userId, name);
							if (found.created) rowAuthorsCreated++;
							authorIds.push(found.id);
						}

						const insertedBook = await row<{ id: string }[]>`
							insert into books (
								household_id, owner_user_id, visibility, title, status, format, owned,
								isbn, rating, pace, moods, tags, content_warnings, tbr_added_on,
								storygraph_id, created_by, updated_by
							) values (
								${householdId}::uuid, ${userId}::uuid, 'household', ${book.title},
								${book.status}, ${book.format}, ${book.owned}, ${book.isbn}, ${book.rating},
								${book.pace}, ${book.moods}::text[], ${book.tags}::text[],
								${book.contentWarnings}, ${book.tbrAddedOn}::date, ${book.storygraphId},
								${userId}::uuid, ${userId}::uuid
							)
							returning id
						`;
						const bookId = one(insertedBook, 'inserted book').id;

						for (const [index, authorId] of authorIds.entries()) {
							await row`
								insert into book_authors (book_id, author_id, position)
								values (${bookId}::uuid, ${authorId}::uuid, ${index})
							`;
						}

						for (const read of book.reads) {
							await row`
								insert into book_reads (
									book_id, reader_user_id, status, started_on, started_precision,
									finished_on, finished_precision, rating, review, created_by, updated_by
								) values (
									${bookId}::uuid, ${userId}::uuid, ${read.status}, ${read.startedOn}::date,
									${read.startedPrecision}, ${read.finishedOn}::date,
									${read.finishedPrecision}, ${read.rating}, ${read.review},
									${userId}::uuid, ${userId}::uuid
								)
							`;
						}

						return { skipped: false, authorsCreated: rowAuthorsCreated };
					});

					if (outcome.skipped) {
						booksSkipped++;
						continue;
					}
					booksCreated++;
					if (book.storygraphId.startsWith(TITLE_KEY_PREFIX)) booksKeyedByTitle++;
					authorsCreated += outcome.authorsCreated;
					for (const read of book.reads) readsByStatus[read.status]++;
				} catch (err) {
					booksFailed++;
					warn({
						row: rowsRead,
						field: 'row',
						message: `could not be imported (${describeDbError(err)})`
					});
				}
			}

			const summary: StorygraphImportSummary = {
				dryRun,
				rowsRead,
				booksCreated,
				booksSkipped,
				booksFailed,
				booksKeyedByTitle,
				authorsCreated,
				readsByStatus,
				warnings,
				warningCounts
			};

			if (dryRun) throw new DryRunComplete(summary);
			return summary;
		})
		.catch((err: unknown) => {
			if (err instanceof DryRunComplete) return err.summary;
			throw err;
		});
}
