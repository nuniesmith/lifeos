import type { Sql, TransactionSql } from 'postgres';
import { parseCsvTable } from './csv.ts';
import { one } from '../db/scalar.ts';

type Queryable = Sql | TransactionSql;

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
 * Mapping decisions worth stating up front, because the brief states them as
 * terse bullets and the code below follows them literally:
 *  - `to-read` produces no read at all; `did-not-finish` produces exactly
 *    one, with no dates of its own -- StoryGraph's `Dates Read` and
 *    `Last Date Read` are mined for `read`/`currently-reading`/`paused` rows
 *    only, never for a dnf one.
 *  - `Star Rating` and `Review` land on whichever read this row builds last.
 *    `Dates Read` ranges are StoryGraph's own chronological list, oldest
 *    first, so "last built" is "most recent" without any date comparison.
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

const SG_DATE = /^(\d{4})\/(\d{2})\/(\d{2})$/;

/**
 * Converts StoryGraph's own `YYYY/MM/DD` to the `YYYY-MM-DD` this app's
 * `date` columns use everywhere (hard rule 2) -- a plain day string, never a
 * JS `Date`, which would have to pick a timezone to read the day back out of
 * that is not this household's to pick.
 */
export function parseStorygraphDate(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const m = SG_DATE.exec(trimmed);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const SG_RANGE = /^(\d{4}\/\d{2}\/\d{2})\s*-\s*(\d{4}\/\d{2}\/\d{2})$/;

interface DatesReadEntry {
	/** Null for a lone date -- see {@link buildReads}, the one place that
	 *  decides what a lone date means for a given Read Status. */
	first: string | null;
	second: string;
}

/**
 * Splits `Dates Read` on its commas and parses each entry as a range or a
 * lone date. An entry that is neither comes back as null so the caller can
 * warn about it and move on, rather than this function guessing.
 */
function parseDatesReadEntries(value: string): (DatesReadEntry | null)[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	return trimmed.split(',').map((part) => {
		const p = part.trim();
		if (!p) return null;
		const range = SG_RANGE.exec(p);
		if (range) {
			const first = parseStorygraphDate(range[1]!);
			const second = parseStorygraphDate(range[2]!);
			return first && second ? { first, second } : null;
		}
		const lone = parseStorygraphDate(p);
		return lone ? { first: null, second: lone } : null;
	});
}

export interface RowWarning {
	row: number;
	field: string;
	message: string;
}

export interface ParsedRead {
	status: ReadStatus;
	startedOn: string | null;
	finishedOn: string | null;
	rating: number | null;
	review: string | null;
}

const newRead = (
	status: ReadStatus,
	startedOn: string | null,
	finishedOn: string | null
): ParsedRead => ({
	status,
	startedOn,
	finishedOn,
	rating: null,
	review: null
});

/**
 * Builds the reads one row implies, following the brief's per-status rules
 * literally (see this module's header for the dnf/to-read decisions). Takes
 * `Last Date Read` as an already-parsed fallback rather than the raw cell,
 * so this function has one job -- deciding how many reads and which dates --
 * instead of also re-deriving a date it is handed either way.
 */
function buildReads(
	row: number,
	status: BookStatus,
	datesReadRaw: string,
	lastDateRead: string | null
): { reads: ParsedRead[]; warnings: RowWarning[] } {
	const warnings: RowWarning[] = [];
	const entries = parseDatesReadEntries(datesReadRaw);
	const valid: DatesReadEntry[] = [];
	for (const entry of entries) {
		if (entry) valid.push(entry);
		else
			warnings.push({
				row,
				field: 'Dates Read',
				message: 'an entry could not be parsed and was skipped'
			});
	}

	if (status === 'read') {
		const reads: ParsedRead[] = [];
		for (const entry of valid) {
			if (entry.first && entry.first > entry.second) {
				// The table's own CHECK (finished_on >= started_on) would refuse
				// this outright; catching it here keeps it a counted warning on
				// one range instead of failing the whole row (the brief's rule 9).
				warnings.push({
					row,
					field: 'Dates Read',
					message: 'a range ends before it starts and was skipped'
				});
				continue;
			}
			reads.push(newRead('finished', entry.first, entry.second));
		}
		// "No ranges but status read": one finished read, dated from Last Date
		// Read when StoryGraph gives nothing more specific. Only when the cell
		// was genuinely empty (`entries.length === 0`) -- ranges that were
		// present but all invalid already earned their own warning above, and
		// manufacturing a dateless read on top of that would hide the problem
		// rather than report it.
		if (reads.length === 0 && entries.length === 0) {
			reads.push(newRead('finished', null, lastDateRead));
		}
		return { reads, warnings };
	}

	if (status === 'dnf') {
		// "did-not-finish: one dnf read" -- no date source is named for this
		// status (unlike the two below), so none is mined here either.
		return { reads: [newRead('dnf', null, null)], warnings };
	}

	if (status === 'reading' || status === 'paused') {
		// "One open read of that status (started_on from its range if any)":
		// only the first entry is consulted, and only for a start -- an open
		// read can never carry finished_on (the table's own CHECK forbids it
		// outside finished/dnf), so a range's second half is never read here.
		const first = valid[0] ?? null;
		const startedOn = first ? (first.first ?? first.second) : null;
		return { reads: [newRead(status, startedOn, null)], warnings };
	}

	// 'tbr': no read at all.
	return { reads: [], warnings };
}

export interface ParsedBook {
	title: string;
	authorNames: string[];
	isbn: string | null;
	storygraphId: string | null;
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
	const status = READ_STATUS_TO_BOOK_STATUS[statusRaw];
	if (!status) {
		warnings.push({
			row,
			field: 'Read Status',
			message: 'not a recognised value; the row was not imported'
		});
		return { book: null, warnings };
	}

	const authorNames = cleanTextArray(cells['Authors'] ?? '');

	// StoryGraph's own UID is sometimes an internal id with no ISBN shape at
	// all, so it is always kept verbatim as storygraph_id (migration
	// 0037 -- what makes a re-run idempotent) even on rows where it is not
	// also a valid ISBN.
	const uidRaw = (cells['ISBN/UID'] ?? '').trim();
	const storygraphId = uidRaw || null;
	const isbn = uidRaw ? parseIsbn(uidRaw) : null;
	if (uidRaw && isbn === null) {
		warnings.push({
			row,
			field: 'ISBN/UID',
			message: 'not a valid ISBN; kept only as the StoryGraph id'
		});
	}

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
	const lastDateRead = lastDateReadRaw ? parseStorygraphDate(lastDateReadRaw) : null;
	if (lastDateReadRaw && lastDateRead === null) {
		warnings.push({ row, field: 'Last Date Read', message: 'not a recognised date; ignored' });
	}

	const built = buildReads(row, status, cells['Dates Read'] ?? '', lastDateRead);
	warnings.push(...built.warnings);
	const reads = built.reads;

	// "Star Rating and Review go on the MOST RECENT read only": Dates Read's
	// ranges are StoryGraph's own chronological list, oldest first, so the
	// last read built above is the most recent one without comparing dates.
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
 * Finds a live author by case-insensitive name, or creates one -- the same
 * rule `findOrCreateAuthor` applies in reading.ts, reimplemented here rather
 * than imported (see this module's header). The retry after a unique
 * violation matters even for a one-shot import: two rows several hundred
 * apart can name the same new author, and nothing serialises one row's
 * insert against the next row's find without it.
 */
async function findOrCreateAuthorId(
	sql: Queryable,
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
		const inserted = await sql<{ id: string }[]>`
			insert into authors (household_id, name, created_by, updated_by)
			values (${householdId}::uuid, ${name}, ${userId}::uuid, ${userId}::uuid)
			returning id
		`;
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
	authorsCreated: number;
	readsByStatus: Record<ReadStatus, number>;
	/** Capped at `maxWarnings`; never carries a title or any other cell
	 *  content (hard rule 1) -- only the row number and the field name. */
	warnings: RowWarning[];
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
			let authorsCreated = 0;
			const readsByStatus: Record<ReadStatus, number> = {
				reading: 0,
				paused: 0,
				finished: 0,
				dnf: 0
			};
			const warnings: RowWarning[] = [];
			const warn = (w: RowWarning) => {
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
					await tx.savepoint(async (row) => {
						if (book.storygraphId) {
							const existing = await row<{ id: string }[]>`
								select id from books
								where household_id = ${householdId}::uuid
								  and storygraph_id = ${book.storygraphId}
								limit 1
							`;
							if (existing[0]) {
								booksSkipped++;
								return;
							}
						}

						const authorIds: string[] = [];
						for (const name of book.authorNames) {
							const found = await findOrCreateAuthorId(row, householdId, userId, name);
							if (found.created) authorsCreated++;
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
									book_id, reader_user_id, status, started_on, finished_on, rating,
									review, created_by, updated_by
								) values (
									${bookId}::uuid, ${userId}::uuid, ${read.status}, ${read.startedOn}::date,
									${read.finishedOn}::date, ${read.rating}, ${read.review},
									${userId}::uuid, ${userId}::uuid
								)
							`;
							readsByStatus[read.status]++;
						}

						booksCreated++;
					});
				} catch (err) {
					booksFailed++;
					warn({
						row: rowsRead,
						field: 'row',
						message: err instanceof Error ? err.message : 'could not be imported'
					});
				}
			}

			const summary: StorygraphImportSummary = {
				dryRun,
				rowsRead,
				booksCreated,
				booksSkipped,
				booksFailed,
				authorsCreated,
				readsByStatus,
				warnings
			};

			if (dryRun) throw new DryRunComplete(summary);
			return summary;
		})
		.catch((err: unknown) => {
			if (err instanceof DryRunComplete) return err.summary;
			throw err;
		});
}
