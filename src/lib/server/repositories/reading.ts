import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate, toDateOrNull } from '../db/coerce';
import {
	InvalidInput,
	baseColumns,
	getScoped,
	guarded,
	householdScope,
	householdToday,
	isUniqueViolation,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toBool,
	toInt,
	toIntOrNull,
	toNumberOrNull,
	toDayOrNull,
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
import {
	oneOf,
	optionalBool,
	optionalDay,
	optionalInt,
	optionalNumber,
	optionalOneOf,
	optionalText,
	patched,
	requiredText
} from './validate';

/**
 * The Reading Tracker's book catalogue (Reading Tracker R1; migration 0030).
 *
 * `books` is a full domain record — owned, private-or-shared like everything
 * else in LifeOS. `authors`, `book_series` and `genres` are reference data
 * shaped like `tags` instead: household-scoped, with no owner of their own,
 * and found-or-created by name from the book form rather than managed on a
 * page of their own. A genuine unique, case-insensitive name is safe to
 * enforce for them at the database — unlike `ingredients` or `people`
 * (migration 0016), nothing but the household typing a name into a book ever
 * populates them, so there is no import history of duplicate labels to
 * protect.
 *
 * Two things build on this pack without being part of it: the reading log
 * (one row per read-through) and the TBR picker are R2; StoryGraph's CSV
 * import, challenges and insights are R3. Nothing here anticipates either.
 */

// TODO: base.ts exports this once the Finance PR lands; this copy should be
// deleted in favour of that one when it does.
/**
 * Runs `fn` as one transaction, or as a savepoint when `sql` is already a
 * transaction — so a book's row and its author/genre links commit or roll
 * back together, and still compose inside a caller's own transaction
 * (base.ts, rule 3). Copied from food.ts's private helper of the same name.
 */
function atomically<T>(sql: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
	return ('savepoint' in sql ? sql.savepoint(fn) : sql.begin(fn)) as Promise<T>;
}

// ─── pure helpers (unit tested directly) ───────────────────────────────────

/**
 * Cleans a `text[]` input — tropes, moods, tags, and the comma-separated
 * author/genre names the book form sends: trims each entry, drops blanks, and
 * dedupes case-insensitively while keeping the first spelling. "Slow burn"
 * and "slow burn" typed on two different books are the same trope, and
 * whichever spelling was typed first is the one that survives, so the tag
 * cloud does not fork on capitalisation.
 */
export function cleanTextArray(value: unknown): string[] {
	const items = Array.isArray(value)
		? value.map((v) => String(v))
		: typeof value === 'string'
			? value.split(',')
			: [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of items) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

/** `text[]` arrives as an array under this driver; anything else is empty. */
const toStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.map((v) => String(v)) : [];

/**
 * StoryGraph rates in quarter stars: 0, 0.25, 0.5, … 5. The table's own CHECK
 * is `rating * 4 = round(rating * 4)`; this mirrors it so a bad value is a
 * field-level error next to the Select rather than a raw constraint
 * violation surfacing as a 500.
 */
export function optionalQuarterRating(value: unknown, field = 'rating'): number | null {
	const n = optionalNumber(value, field, { min: 0, max: 5 });
	if (n === null) return null;
	const quarters = n * 4;
	if (Math.abs(quarters - Math.round(quarters)) > 1e-9) {
		throw new InvalidInput(`${field} must be in quarter-star steps`);
	}
	// Normalised through the same arithmetic the CHECK uses, so a value like
	// 2.7500000001 from a lossy client cannot slip through as "close enough".
	return Math.round(quarters) / 4;
}

/**
 * ISBN-10 or ISBN-13, stored as digits only. Hyphens and spaces are how both
 * are usually printed or copied, so stripping them is what "the same ISBN"
 * means to a household typing one in, not a second fact about the book. The
 * check digit is not verified — some of what lands here is copied off a
 * book's back cover with a typo already in it, and this repository is not
 * the place to catch that.
 */
export function optionalIsbn(value: unknown, field = 'ISBN'): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new InvalidInput(`${field} must be text`);
	const stripped = value.replace(/[-\s]/g, '');
	if (!stripped) return null;
	if (!/^\d{10}$|^\d{13}$/.test(stripped)) {
		throw new InvalidInput(`${field} must be 10 or 13 digits`);
	}
	return stripped;
}

/**
 * `optionalNumber` with an exclusive lower bound, for columns whose own CHECK
 * is `> 0` rather than `>= 0` (series_position) — mirrors the same guard in
 * health-measurements.ts's private `positive`, copied rather than shared
 * because that one is not exported.
 */
function positive(value: unknown, field: string): number | null {
	const n = optionalNumber(value, field);
	if (n !== null && n <= 0) throw new InvalidInput(`${field} must be greater than 0`);
	return n;
}

// ─── books ─────────────────────────────────────────────────────────────────

export const BOOK_STATUSES = ['tbr', 'reading', 'paused', 'read', 'dnf'] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];

export const BOOK_CATEGORIES = ['fiction', 'nonfiction'] as const;
export type BookCategory = (typeof BOOK_CATEGORIES)[number];

export const BOOK_AUDIENCES = ['adult', 'young_adult', 'middle_grade', 'children'] as const;
export type BookAudience = (typeof BOOK_AUDIENCES)[number];

export const BOOK_FORMATS = ['print', 'ebook', 'audiobook'] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

export const BOOK_PACES = ['slow', 'medium', 'fast'] as const;
export type BookPace = (typeof BOOK_PACES)[number];

export interface Book extends RecordBase {
	title: string;
	subtitle: string | null;
	seriesId: string | null;
	seriesPosition: number | null;
	status: BookStatus;
	category: BookCategory | null;
	audience: BookAudience | null;
	format: BookFormat | null;
	owned: boolean;
	pages: number | null;
	audiobookMinutes: number | null;
	isbn: string | null;
	releaseDate: string | null;
	rating: number | null;
	favourite: boolean;
	spice: number | null;
	pace: BookPace | null;
	tropes: string[];
	moods: string[];
	tags: string[];
	contentWarnings: string | null;
	description: string | null;
	notes: string | null;
	storygraphUrl: string | null;
	recommendedBy: string | null;
	tbrAddedOn: string | null;
}

/** A catalogue row, with the two joins the list and home pages need to show
 *  without an N+1 query per book. */
export interface BookSummary extends Book {
	seriesName: string | null;
	/** "Ann Leckie, N.K. Jemisin" — in author-order, comma-joined. */
	authorNames: string | null;
}

interface BookRow extends BaseRow {
	title: string;
	subtitle: string | null;
	series_id: string | null;
	series_position: unknown;
	status: string;
	category: string | null;
	audience: string | null;
	format: string | null;
	owned: unknown;
	pages: unknown;
	audiobook_minutes: unknown;
	isbn: string | null;
	release_date: string | null;
	rating: unknown;
	favourite: unknown;
	spice: unknown;
	pace: string | null;
	tropes: unknown;
	moods: unknown;
	tags: unknown;
	content_warnings: string | null;
	description: string | null;
	notes: string | null;
	storygraph_url: string | null;
	recommended_by: string | null;
	tbr_added_on: string | null;
}

interface BookSummaryRow extends BookRow {
	series_name: string | null;
	author_names: string | null;
}

const BOOKS = 'books';

const bookColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	title, subtitle, series_id, series_position, status, category, audience, format, owned,
	pages, audiobook_minutes, isbn, release_date::text as release_date, rating, favourite, spice,
	pace, tropes, moods, tags, content_warnings, description, notes, storygraph_url,
	recommended_by, tbr_added_on::text as tbr_added_on`;

function mapBook(row: BookRow): Book {
	return {
		...mapBase(row),
		title: toText(row.title),
		subtitle: toTextOrNull(row.subtitle),
		seriesId: row.series_id,
		seriesPosition: toNumberOrNull(row.series_position),
		status: row.status as BookStatus,
		category: (row.category as BookCategory | null) ?? null,
		audience: (row.audience as BookAudience | null) ?? null,
		format: (row.format as BookFormat | null) ?? null,
		owned: toBool(row.owned),
		pages: toIntOrNull(row.pages),
		audiobookMinutes: toIntOrNull(row.audiobook_minutes),
		isbn: toTextOrNull(row.isbn),
		releaseDate: toDayOrNull(row.release_date),
		rating: toNumberOrNull(row.rating),
		favourite: toBool(row.favourite),
		spice: toIntOrNull(row.spice),
		pace: (row.pace as BookPace | null) ?? null,
		tropes: toStringArray(row.tropes),
		moods: toStringArray(row.moods),
		tags: toStringArray(row.tags),
		contentWarnings: toTextOrNull(row.content_warnings),
		description: toTextOrNull(row.description),
		notes: toTextOrNull(row.notes),
		storygraphUrl: toTextOrNull(row.storygraph_url),
		recommendedBy: toTextOrNull(row.recommended_by),
		tbrAddedOn: toDayOrNull(row.tbr_added_on)
	};
}

function mapBookSummary(row: BookSummaryRow): BookSummary {
	return {
		...mapBook(row),
		seriesName: toTextOrNull(row.series_name),
		authorNames: toTextOrNull(row.author_names)
	};
}

export interface BookFilters extends PageOptions {
	status?: BookStatus | readonly BookStatus[];
	authorId?: string;
	seriesId?: string;
	genreId?: string;
	owned?: boolean;
	favourite?: boolean;
	/** Matches against the title only. */
	search?: string;
	includeArchived?: boolean;
	order?: 'title' | 'tbr_added' | 'updated' | 'series_position';
}

/**
 * The catalogue, and every list on the Reading Tracker home page — they are
 * one query with a different filter and order, not three different shapes,
 * the same way Library/Reading/Knowledge Hub share `listLibrary`.
 */
export async function listBooks(
	sql: Queryable,
	viewer: Viewer,
	filters: BookFilters = {}
): Promise<BookSummary[]> {
	const { limit, offset } = pageOf(filters);
	const statuses =
		filters.status === undefined
			? null
			: Array.isArray(filters.status)
				? filters.status
				: [filters.status];
	const search = filters.search?.trim();

	const order =
		filters.order === 'tbr_added'
			? sql`b.tbr_added_on desc nulls last, lower(b.title) asc`
			: filters.order === 'updated'
				? sql`b.updated_at desc`
				: filters.order === 'series_position'
					? sql`b.series_position asc nulls last, lower(b.title) asc`
					: sql`lower(b.title) asc, b.id asc`;

	const rows = await sql<BookSummaryRow[]>`
		select ${bookColumns(sql)},
			(select bs.name from book_series bs where bs.id = b.series_id) as series_name,
			(
				select string_agg(a.name, ', ' order by coalesce(ba.position, 32767), lower(a.name))
				from book_authors ba join authors a on a.id = ba.author_id
				where ba.book_id = b.id
			) as author_names
		from books b
		where ${readableScope(sql, viewer, 'b')}
		  and ${liveScope(sql, 'b', filters.includeArchived)}
		  ${statuses ? sql`and b.status in ${sql(statuses)}` : sql``}
		  ${filters.owned !== undefined ? sql`and b.owned = ${filters.owned}` : sql``}
		  ${filters.favourite !== undefined ? sql`and b.favourite = ${filters.favourite}` : sql``}
		  ${filters.seriesId && isUuid(filters.seriesId) ? sql`and b.series_id = ${filters.seriesId}::uuid` : sql``}
		  ${search ? sql`and b.title ilike ${'%' + search + '%'}` : sql``}
		  ${
				filters.authorId && isUuid(filters.authorId)
					? sql`and exists (
					select 1 from book_authors ba
					where ba.book_id = b.id and ba.author_id = ${filters.authorId}::uuid
				)`
					: sql``
			}
		  ${
				filters.genreId && isUuid(filters.genreId)
					? sql`and exists (
					select 1 from book_genres bg
					where bg.book_id = b.id and bg.genre_id = ${filters.genreId}::uuid
				)`
					: sql``
			}
		order by ${order}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapBookSummary);
}

export async function getBook(sql: Queryable, viewer: Viewer, id: string): Promise<Book | null> {
	const row = await getScoped<BookRow>(
		sql,
		BOOKS,
		id,
		readableScope(sql, viewer, BOOKS),
		bookColumns(sql)
	);
	return row ? mapBook(row) : null;
}

export interface BookInput extends OwnershipInput {
	title?: unknown;
	subtitle?: unknown;
	seriesName?: unknown;
	seriesPosition?: unknown;
	status?: unknown;
	category?: unknown;
	audience?: unknown;
	format?: unknown;
	owned?: unknown;
	pages?: unknown;
	audiobookMinutes?: unknown;
	isbn?: unknown;
	releaseDate?: unknown;
	rating?: unknown;
	favourite?: unknown;
	spice?: unknown;
	pace?: unknown;
	tropes?: unknown;
	moods?: unknown;
	tags?: unknown;
	contentWarnings?: unknown;
	description?: unknown;
	notes?: unknown;
	storygraphUrl?: unknown;
	recommendedBy?: unknown;
	tbrAddedOn?: unknown;
	/** Comma-separated names, resolved with find-or-create. */
	authorNames?: unknown;
	/** Comma-separated names, resolved with find-or-create. */
	genreNames?: unknown;
}

/** Every plain field a book write can touch, other than `title` (validated
 *  separately below — see the comment on {@link bookFieldsFrom}), the series
 *  (needs a query to resolve) and the author/genre links (need several). */
interface BookFields {
	subtitle: string | null;
	status: BookStatus;
	category: BookCategory | null;
	audience: BookAudience | null;
	format: BookFormat | null;
	owned: boolean;
	pages: number | null;
	audiobookMinutes: number | null;
	isbn: string | null;
	releaseDate: string | null;
	rating: number | null;
	favourite: boolean;
	spice: number | null;
	pace: BookPace | null;
	tropes: string[];
	moods: string[];
	tags: string[];
	contentWarnings: string | null;
	description: string | null;
	notes: string | null;
	storygraphUrl: string | null;
	recommendedBy: string | null;
}

const NEW_BOOK_DEFAULTS: BookFields = {
	subtitle: null,
	status: 'tbr',
	category: null,
	audience: null,
	format: null,
	owned: false,
	pages: null,
	audiobookMinutes: null,
	isbn: null,
	releaseDate: null,
	rating: null,
	favourite: false,
	spice: null,
	pace: null,
	tropes: [],
	moods: [],
	tags: [],
	contentWarnings: null,
	description: null,
	notes: null,
	storygraphUrl: null,
	recommendedBy: null
};

/**
 * Resolves every {@link BookFields} value from a patch against a baseline —
 * the record being edited, or {@link NEW_BOOK_DEFAULTS} for a new one. Shared
 * by create and update so the two cannot drift on what a field means or how
 * it is bounded.
 *
 * `title` is deliberately not here: `patched` returning the baseline when a
 * key is absent is correct for every field above, but title has no sensible
 * baseline for a *new* book, and skipping its `requiredText` check for one
 * that omitted the key entirely would let an empty title reach the insert and
 * fail as a raw constraint violation instead of a field error. Each caller
 * validates it directly instead.
 */
function bookFieldsFrom(patch: BookInput, current: BookFields): BookFields {
	return {
		subtitle: patched(patch, 'subtitle', current.subtitle, (v) => optionalText(v, 'subtitle', 300)),
		status: patched(patch, 'status', current.status, (v) => oneOf(v, 'status', BOOK_STATUSES)),
		category: patched(patch, 'category', current.category, (v) =>
			optionalOneOf(v, 'category', BOOK_CATEGORIES)
		),
		audience: patched(patch, 'audience', current.audience, (v) =>
			optionalOneOf(v, 'audience', BOOK_AUDIENCES)
		),
		format: patched(patch, 'format', current.format, (v) =>
			optionalOneOf(v, 'format', BOOK_FORMATS)
		),
		owned: patched(patch, 'owned', current.owned, (v) => optionalBool(v, 'owned') ?? false),
		pages: patched(patch, 'pages', current.pages, (v) => optionalInt(v, 'pages', { min: 1 })),
		audiobookMinutes: patched(patch, 'audiobookMinutes', current.audiobookMinutes, (v) =>
			optionalInt(v, 'audiobook length', { min: 1 })
		),
		isbn: patched(patch, 'isbn', current.isbn, (v) => optionalIsbn(v)),
		releaseDate: patched(patch, 'releaseDate', current.releaseDate, (v) =>
			optionalDay(v, 'release date')
		),
		rating: patched(patch, 'rating', current.rating, (v) => optionalQuarterRating(v)),
		favourite: patched(
			patch,
			'favourite',
			current.favourite,
			(v) => optionalBool(v, 'favourite') ?? false
		),
		spice: patched(patch, 'spice', current.spice, (v) =>
			optionalInt(v, 'spice', { min: 0, max: 5 })
		),
		pace: patched(patch, 'pace', current.pace, (v) => optionalOneOf(v, 'pace', BOOK_PACES)),
		tropes: patched(patch, 'tropes', current.tropes, cleanTextArray),
		moods: patched(patch, 'moods', current.moods, cleanTextArray),
		tags: patched(patch, 'tags', current.tags, cleanTextArray),
		contentWarnings: patched(patch, 'contentWarnings', current.contentWarnings, (v) =>
			optionalText(v, 'content warnings', 2000)
		),
		description: patched(patch, 'description', current.description, (v) =>
			optionalText(v, 'description', 100_000)
		),
		notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes', 100_000)),
		storygraphUrl: patched(patch, 'storygraphUrl', current.storygraphUrl, (v) =>
			optionalText(v, 'StoryGraph link', 2000)
		),
		recommendedBy: patched(patch, 'recommendedBy', current.recommendedBy, (v) =>
			optionalText(v, 'recommended by', 200)
		)
	};
}

/**
 * Resolves a book's series from a name plus a position — one unit on the
 * form, so both arrive together. A blank name always means "no series",
 * which forces the position to null too: a position with no series is not a
 * fact this schema can express, and silently keeping a stale one would be
 * worse than dropping it.
 */
async function resolveSeries(
	sql: Queryable,
	viewer: Viewer,
	seriesName: unknown,
	seriesPositionInput: unknown
): Promise<{ seriesId: string | null; seriesPosition: number | null }> {
	const name = optionalText(seriesName, 'series', 200);
	if (name === null) return { seriesId: null, seriesPosition: null };
	const found = await findOrCreateBookSeries(sql, viewer, name);
	if (!found.ok) throw new InvalidInput(found.message ?? 'could not use that series');
	return {
		seriesId: found.record.id,
		seriesPosition: positive(seriesPositionInput, 'series position')
	};
}

/**
 * Sets a book's authors from a comma-separated list of names, replacing
 * whatever was linked before, in the same transaction as the rest of the
 * write. `undefined` means the caller's form did not carry this field at all
 * and leaves the links untouched; an explicit blank clears every author, the
 * way clearing any other optional field does.
 */
async function replaceBookAuthors(
	sql: Queryable,
	viewer: Viewer,
	bookId: string,
	namesInput: unknown
): Promise<void> {
	if (namesInput === undefined) return;
	const names = cleanTextArray(namesInput);
	const authorIds: string[] = [];
	for (const name of names) {
		const found = await findOrCreateAuthor(sql, viewer, name);
		if (!found.ok) throw new InvalidInput(found.message ?? `could not use the author "${name}"`);
		authorIds.push(found.record.id);
	}
	await sql`delete from book_authors where book_id = ${bookId}::uuid`;
	for (const [index, authorId] of authorIds.entries()) {
		await sql`
			insert into book_authors (book_id, author_id, position)
			values (${bookId}::uuid, ${authorId}::uuid, ${index})
		`;
	}
}

/** The genre half of {@link replaceBookAuthors}; genres carry no order. */
async function replaceBookGenres(
	sql: Queryable,
	viewer: Viewer,
	bookId: string,
	namesInput: unknown
): Promise<void> {
	if (namesInput === undefined) return;
	const names = cleanTextArray(namesInput);
	const genreIds: string[] = [];
	for (const name of names) {
		const found = await findOrCreateGenre(sql, viewer, name);
		if (!found.ok) throw new InvalidInput(found.message ?? `could not use the genre "${name}"`);
		genreIds.push(found.record.id);
	}
	await sql`delete from book_genres where book_id = ${bookId}::uuid`;
	for (const genreId of genreIds) {
		await sql`insert into book_genres (book_id, genre_id) values (${bookId}::uuid, ${genreId}::uuid)`;
	}
}

export function createBook(
	sql: Queryable,
	viewer: Viewer,
	input: BookInput
): Promise<WriteResult<Book>> {
	return guarded<Book>(() =>
		atomically(sql, async (tx) => {
			const title = requiredText(input.title, 'title', 300);
			const fields = bookFieldsFrom(input, NEW_BOOK_DEFAULTS);
			const series = await resolveSeries(tx, viewer, input.seriesName, input.seriesPosition);
			// Only a book actually starting life on the TBR gets today for free —
			// one added straight as "reading" or backfilled as "read" was never
			// really added to a to-be-read pile at all.
			const tbrAddedOn =
				fields.status === 'tbr'
					? (optionalDay(input.tbrAddedOn, 'added to TBR') ??
						(await householdToday(tx, viewer.householdId)))
					: optionalDay(input.tbrAddedOn, 'added to TBR');
			const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
				ownerUserId: null,
				visibility: 'household'
			});

			const rows = await tx<BookRow[]>`
				insert into books (
					household_id, owner_user_id, visibility, title, subtitle,
					series_id, series_position, status, category, audience, format, owned,
					pages, audiobook_minutes, isbn, release_date, rating, favourite, spice, pace,
					tropes, moods, tags, content_warnings, description, notes, storygraph_url,
					recommended_by, tbr_added_on, created_by, updated_by
				) values (
					${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility},
					${title}, ${fields.subtitle},
					${series.seriesId}::uuid, ${series.seriesPosition}, ${fields.status}, ${fields.category},
					${fields.audience}, ${fields.format}, ${fields.owned}, ${fields.pages},
					${fields.audiobookMinutes}, ${fields.isbn}, ${fields.releaseDate}, ${fields.rating},
					${fields.favourite}, ${fields.spice}, ${fields.pace}, ${fields.tropes}::text[],
					${fields.moods}::text[], ${fields.tags}::text[], ${fields.contentWarnings},
					${fields.description}, ${fields.notes}, ${fields.storygraphUrl}, ${fields.recommendedBy},
					${tbrAddedOn}, ${viewer.userId}::uuid, ${viewer.userId}::uuid
				)
				returning ${bookColumns(tx)}
			`;
			const row = rows[0];
			if (!row) throw new Error('insert returned no row');

			await replaceBookAuthors(tx, viewer, row.id, input.authorNames);
			await replaceBookGenres(tx, viewer, row.id, input.genreNames);
			return { ok: true, record: mapBook(row) };
		})
	);
}

export function updateBook(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: BookInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Book>> {
	return guarded<Book>(() =>
		atomically(sql, async (tx) => {
			const current = await getBook(tx, viewer, id);
			if (!current) return { ok: false, reason: 'not_found' };

			const title = patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 300));
			const fields = bookFieldsFrom(patch, current);
			const series =
				'seriesName' in patch && patch.seriesName !== undefined
					? await resolveSeries(tx, viewer, patch.seriesName, patch.seriesPosition)
					: { seriesId: current.seriesId, seriesPosition: current.seriesPosition };
			const tbrAddedOn = patched(patch, 'tbrAddedOn', current.tbrAddedOn, (v) =>
				optionalDay(v, 'added to TBR')
			);
			const ownership = resolveOwnership(viewer, patch, {
				ownerUserId: current.ownerUserId,
				visibility: current.visibility
			});

			const result = await writeScoped<BookRow, Book>({
				sql: tx,
				table: BOOKS,
				id,
				readScope: readableScope(tx, viewer, BOOKS),
				writeScope: writableScope(tx, viewer, BOOKS),
				...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
				assignments: tx`
					title = ${title}, subtitle = ${fields.subtitle},
					series_id = ${series.seriesId}::uuid, series_position = ${series.seriesPosition},
					status = ${fields.status}, category = ${fields.category}, audience = ${fields.audience},
					format = ${fields.format}, owned = ${fields.owned}, pages = ${fields.pages},
					audiobook_minutes = ${fields.audiobookMinutes}, isbn = ${fields.isbn},
					release_date = ${fields.releaseDate}, rating = ${fields.rating},
					favourite = ${fields.favourite}, spice = ${fields.spice}, pace = ${fields.pace},
					tropes = ${fields.tropes}::text[], moods = ${fields.moods}::text[],
					tags = ${fields.tags}::text[], content_warnings = ${fields.contentWarnings},
					description = ${fields.description}, notes = ${fields.notes},
					storygraph_url = ${fields.storygraphUrl}, recommended_by = ${fields.recommendedBy},
					tbr_added_on = ${tbrAddedOn},
					owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
					updated_at = now(), updated_by = ${viewer.userId}::uuid`,
				columns: bookColumns(tx),
				map: mapBook,
				mayWrite: writableBy(viewer)
			});
			if (!result.ok) return result;

			if ('authorNames' in patch) await replaceBookAuthors(tx, viewer, id, patch.authorNames);
			if ('genreNames' in patch) await replaceBookGenres(tx, viewer, id, patch.genreNames);
			return result;
		})
	);
}

export function setBookArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Book>> {
	return writeScoped<BookRow, Book>({
		sql,
		table: BOOKS,
		id,
		readScope: readableScope(sql, viewer, BOOKS),
		writeScope: writableScope(sql, viewer, BOOKS),
		...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
		assignments: sql`
			archived_at = case when ${archived}::boolean then now() else null end,
			updated_at = now(), updated_by = ${viewer.userId}::uuid`,
		columns: bookColumns(sql),
		map: mapBook,
		mayWrite: writableBy(viewer)
	});
}

// ─── author / series / genre links, read side ──────────────────────────────

export interface BookAuthorRef {
	id: string;
	name: string;
	position: number | null;
}

/** A book's authors in cover order, for the edit form's comma-separated
 *  field and for the detail page's byline. */
export async function listAuthorsForBook(
	sql: Queryable,
	viewer: Viewer,
	bookId: string
): Promise<BookAuthorRef[]> {
	if (!isUuid(bookId)) return [];
	const rows = await sql<{ id: string; name: string; position: unknown }[]>`
		select a.id, a.name, ba.position
		from book_authors ba
		join authors a on a.id = ba.author_id
		where ba.book_id = ${bookId}::uuid and ${householdScope(sql, viewer, 'a')}
		order by coalesce(ba.position, 32767), lower(a.name)
	`;
	return rows.map((row) => ({
		id: row.id,
		name: toText(row.name),
		position: toIntOrNull(row.position)
	}));
}

export interface BookGenreRef {
	id: string;
	name: string;
}

export async function listGenresForBook(
	sql: Queryable,
	viewer: Viewer,
	bookId: string
): Promise<BookGenreRef[]> {
	if (!isUuid(bookId)) return [];
	const rows = await sql<{ id: string; name: string }[]>`
		select g.id, g.name
		from book_genres bg
		join genres g on g.id = bg.genre_id
		where bg.book_id = ${bookId}::uuid and ${householdScope(sql, viewer, 'g')}
		order by lower(g.name)
	`;
	return rows.map((row) => ({ id: row.id, name: toText(row.name) }));
}

// ─── shared reference-data filters ─────────────────────────────────────────

export interface ReferenceFilters extends PageOptions {
	search?: string;
	includeArchived?: boolean;
}

/**
 * Finds a live row by case-insensitive name, or creates one — the shared
 * shape behind `findOrCreateAuthor`, `findOrCreateBookSeries` and
 * `findOrCreateGenre`. The retry after a unique-violation is what makes two
 * household members typing the same new name at the same moment land on one
 * row rather than one of them failing outright; on a two-person household
 * this is a rare race, not a load-bearing one, but it costs nothing to close.
 */
async function findOrCreateByName<Row extends { id: string }, Rec>(
	sql: Queryable,
	viewer: Viewer,
	table: string,
	rawName: unknown,
	field: string,
	maxLength: number,
	columns: Fragment,
	map: (row: Row) => Rec
): Promise<WriteResult<Rec>> {
	return guarded<Rec>(async () => {
		const name = requiredText(rawName, field, maxLength);
		const find = () => sql<Row[]>`
			select ${columns} from ${sql(table)}
			where ${householdScope(sql, viewer, table)}
			  and lower(trim(name)) = lower(trim(${name}))
			  and archived_at is null
			limit 1
		`;
		const existing = await find();
		if (existing[0]) return { ok: true, record: map(existing[0]) };
		try {
			const rows = await sql<Row[]>`
				insert into ${sql(table)} (household_id, name, created_by, updated_by)
				values (${viewer.householdId}::uuid, ${name}, ${viewer.userId}::uuid, ${viewer.userId}::uuid)
				returning ${columns}
			`;
			const row = rows[0];
			if (!row) throw new Error('insert returned no row');
			return { ok: true, record: map(row) };
		} catch (err) {
			if (isUniqueViolation(err)) {
				const retry = await find();
				if (retry[0]) return { ok: true, record: map(retry[0]) };
			}
			throw err;
		}
	});
}

// ─── authors ────────────────────────────────────────────────────────────────

export interface Author {
	id: string;
	householdId: string;
	name: string;
	notes: string | null;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string | null;
	updatedBy: string | null;
	archivedAt: Date | null;
}

export interface AuthorWithCount extends Author {
	bookCount: number;
}

interface AuthorRow {
	id: string;
	household_id: string;
	name: string;
	notes: string | null;
	created_at: unknown;
	updated_at: unknown;
	created_by: string | null;
	updated_by: string | null;
	archived_at: unknown;
}

const AUTHORS = 'authors';

const authorColumns = (sql: Queryable): Fragment => sql`
	id, household_id, name, notes, created_at, updated_at, created_by, updated_by, archived_at`;

function mapAuthor(row: AuthorRow): Author {
	return {
		id: row.id,
		householdId: row.household_id,
		name: toText(row.name),
		notes: toTextOrNull(row.notes),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		archivedAt: toDateOrNull(row.archived_at)
	};
}

export async function listAuthors(
	sql: Queryable,
	viewer: Viewer,
	filters: ReferenceFilters = {}
): Promise<AuthorWithCount[]> {
	const { limit, offset } = pageOf(filters);
	const search = filters.search?.trim();
	const rows = await sql<(AuthorRow & { book_count: unknown })[]>`
		select ${authorColumns(sql)},
			(
				select count(*)::int from book_authors ba
				join books b on b.id = ba.book_id
				where ba.author_id = authors.id and b.archived_at is null
				  and ${readableScope(sql, viewer, 'b')}
			) as book_count
		from authors
		where ${householdScope(sql, viewer, AUTHORS)}
		  and ${liveScope(sql, AUTHORS, filters.includeArchived)}
		  ${search ? sql`and name ilike ${'%' + search + '%'}` : sql``}
		order by lower(name) asc
		limit ${limit} offset ${offset}
	`;
	return rows.map((row) => ({ ...mapAuthor(row), bookCount: toInt(row.book_count) }));
}

export async function getAuthor(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<Author | null> {
	const row = await getScoped<AuthorRow>(
		sql,
		AUTHORS,
		id,
		householdScope(sql, viewer, AUTHORS),
		authorColumns(sql)
	);
	return row ? mapAuthor(row) : null;
}

export interface AuthorInput {
	name?: unknown;
	notes?: unknown;
}

export function createAuthor(
	sql: Queryable,
	viewer: Viewer,
	input: AuthorInput
): Promise<WriteResult<Author>> {
	return guarded<Author>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const notes = optionalText(input.notes, 'notes');
		const rows = await sql<AuthorRow[]>`
			insert into authors (household_id, name, notes, created_by, updated_by)
			values (${viewer.householdId}::uuid, ${name}, ${notes}, ${viewer.userId}::uuid, ${viewer.userId}::uuid)
			returning ${authorColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapAuthor(row) };
	});
}

export function updateAuthor(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: AuthorInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Author>> {
	return guarded<Author>(async () => {
		const current = await getAuthor(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };
		const name = patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200));
		const notes = patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'));

		return writeScoped<AuthorRow, Author>({
			sql,
			table: AUTHORS,
			id,
			readScope: householdScope(sql, viewer, AUTHORS),
			writeScope: householdScope(sql, viewer, AUTHORS),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			// Not a migration-0004 table, so nothing sets updated_at for this
			// write unless this does (base.ts's header rule 3).
			assignments: sql`name = ${name}, notes = ${notes},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: authorColumns(sql),
			map: mapAuthor,
			// No owner: a name is either household member's to correct.
			mayWrite: () => true
		});
	});
}

export function setAuthorArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Author>> {
	return writeScoped<AuthorRow, Author>({
		sql,
		table: AUTHORS,
		id,
		readScope: householdScope(sql, viewer, AUTHORS),
		writeScope: householdScope(sql, viewer, AUTHORS),
		...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
		assignments: sql`archived_at = case when ${archived}::boolean then now() else null end,
			updated_at = now(), updated_by = ${viewer.userId}::uuid`,
		columns: authorColumns(sql),
		map: mapAuthor,
		mayWrite: () => true
	});
}

export const findOrCreateAuthor = (
	sql: Queryable,
	viewer: Viewer,
	name: unknown
): Promise<WriteResult<Author>> =>
	findOrCreateByName<AuthorRow, Author>(
		sql,
		viewer,
		AUTHORS,
		name,
		'author',
		200,
		authorColumns(sql),
		mapAuthor
	);

// ─── series ────────────────────────────────────────────────────────────────

export interface BookSeries {
	id: string;
	householdId: string;
	name: string;
	notes: string | null;
	plannedCount: number | null;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string | null;
	updatedBy: string | null;
	archivedAt: Date | null;
}

export interface BookSeriesWithCount extends BookSeries {
	bookCount: number;
}

interface BookSeriesRow {
	id: string;
	household_id: string;
	name: string;
	notes: string | null;
	planned_count: unknown;
	created_at: unknown;
	updated_at: unknown;
	created_by: string | null;
	updated_by: string | null;
	archived_at: unknown;
}

const BOOK_SERIES = 'book_series';

const bookSeriesColumns = (sql: Queryable): Fragment => sql`
	id, household_id, name, notes, planned_count,
	created_at, updated_at, created_by, updated_by, archived_at`;

function mapBookSeries(row: BookSeriesRow): BookSeries {
	return {
		id: row.id,
		householdId: row.household_id,
		name: toText(row.name),
		notes: toTextOrNull(row.notes),
		plannedCount: toIntOrNull(row.planned_count),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		archivedAt: toDateOrNull(row.archived_at)
	};
}

export async function listBookSeries(
	sql: Queryable,
	viewer: Viewer,
	filters: ReferenceFilters = {}
): Promise<BookSeriesWithCount[]> {
	const { limit, offset } = pageOf(filters);
	const search = filters.search?.trim();
	const rows = await sql<(BookSeriesRow & { book_count: unknown })[]>`
		select ${bookSeriesColumns(sql)},
			(
				select count(*)::int from books b
				where b.series_id = book_series.id and b.archived_at is null
				  and ${readableScope(sql, viewer, 'b')}
			) as book_count
		from book_series
		where ${householdScope(sql, viewer, BOOK_SERIES)}
		  and ${liveScope(sql, BOOK_SERIES, filters.includeArchived)}
		  ${search ? sql`and name ilike ${'%' + search + '%'}` : sql``}
		order by lower(name) asc
		limit ${limit} offset ${offset}
	`;
	return rows.map((row) => ({ ...mapBookSeries(row), bookCount: toInt(row.book_count) }));
}

export async function getBookSeries(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<BookSeries | null> {
	const row = await getScoped<BookSeriesRow>(
		sql,
		BOOK_SERIES,
		id,
		householdScope(sql, viewer, BOOK_SERIES),
		bookSeriesColumns(sql)
	);
	return row ? mapBookSeries(row) : null;
}

export interface BookSeriesInput {
	name?: unknown;
	notes?: unknown;
	plannedCount?: unknown;
}

export function createBookSeries(
	sql: Queryable,
	viewer: Viewer,
	input: BookSeriesInput
): Promise<WriteResult<BookSeries>> {
	return guarded<BookSeries>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const notes = optionalText(input.notes, 'notes');
		const plannedCount = optionalInt(input.plannedCount, 'planned count', { min: 1 });
		const rows = await sql<BookSeriesRow[]>`
			insert into book_series (household_id, name, notes, planned_count, created_by, updated_by)
			values (
				${viewer.householdId}::uuid, ${name}, ${notes}, ${plannedCount},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${bookSeriesColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapBookSeries(row) };
	});
}

export function updateBookSeries(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: BookSeriesInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<BookSeries>> {
	return guarded<BookSeries>(async () => {
		const current = await getBookSeries(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };
		const name = patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200));
		const notes = patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'));
		const plannedCount = patched(patch, 'plannedCount', current.plannedCount, (v) =>
			optionalInt(v, 'planned count', { min: 1 })
		);

		return writeScoped<BookSeriesRow, BookSeries>({
			sql,
			table: BOOK_SERIES,
			id,
			readScope: householdScope(sql, viewer, BOOK_SERIES),
			writeScope: householdScope(sql, viewer, BOOK_SERIES),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`name = ${name}, notes = ${notes}, planned_count = ${plannedCount},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: bookSeriesColumns(sql),
			map: mapBookSeries,
			mayWrite: () => true
		});
	});
}

export function setBookSeriesArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<BookSeries>> {
	return writeScoped<BookSeriesRow, BookSeries>({
		sql,
		table: BOOK_SERIES,
		id,
		readScope: householdScope(sql, viewer, BOOK_SERIES),
		writeScope: householdScope(sql, viewer, BOOK_SERIES),
		...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
		assignments: sql`archived_at = case when ${archived}::boolean then now() else null end,
			updated_at = now(), updated_by = ${viewer.userId}::uuid`,
		columns: bookSeriesColumns(sql),
		map: mapBookSeries,
		mayWrite: () => true
	});
}

export const findOrCreateBookSeries = (
	sql: Queryable,
	viewer: Viewer,
	name: unknown
): Promise<WriteResult<BookSeries>> =>
	findOrCreateByName<BookSeriesRow, BookSeries>(
		sql,
		viewer,
		BOOK_SERIES,
		name,
		'series',
		200,
		bookSeriesColumns(sql),
		mapBookSeries
	);

// ─── genres ────────────────────────────────────────────────────────────────

export interface Genre {
	id: string;
	householdId: string;
	name: string;
	notes: string | null;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string | null;
	updatedBy: string | null;
	archivedAt: Date | null;
}

export interface GenreWithCount extends Genre {
	bookCount: number;
}

interface GenreRow {
	id: string;
	household_id: string;
	name: string;
	notes: string | null;
	created_at: unknown;
	updated_at: unknown;
	created_by: string | null;
	updated_by: string | null;
	archived_at: unknown;
}

const GENRES = 'genres';

const genreColumns = (sql: Queryable): Fragment => sql`
	id, household_id, name, notes, created_at, updated_at, created_by, updated_by, archived_at`;

function mapGenre(row: GenreRow): Genre {
	return {
		id: row.id,
		householdId: row.household_id,
		name: toText(row.name),
		notes: toTextOrNull(row.notes),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		archivedAt: toDateOrNull(row.archived_at)
	};
}

export async function listGenres(
	sql: Queryable,
	viewer: Viewer,
	filters: ReferenceFilters = {}
): Promise<GenreWithCount[]> {
	const { limit, offset } = pageOf(filters);
	const search = filters.search?.trim();
	const rows = await sql<(GenreRow & { book_count: unknown })[]>`
		select ${genreColumns(sql)},
			(
				select count(*)::int from book_genres bg
				join books b on b.id = bg.book_id
				where bg.genre_id = genres.id and b.archived_at is null
				  and ${readableScope(sql, viewer, 'b')}
			) as book_count
		from genres
		where ${householdScope(sql, viewer, GENRES)}
		  and ${liveScope(sql, GENRES, filters.includeArchived)}
		  ${search ? sql`and name ilike ${'%' + search + '%'}` : sql``}
		order by lower(name) asc
		limit ${limit} offset ${offset}
	`;
	return rows.map((row) => ({ ...mapGenre(row), bookCount: toInt(row.book_count) }));
}

export async function getGenre(sql: Queryable, viewer: Viewer, id: string): Promise<Genre | null> {
	const row = await getScoped<GenreRow>(
		sql,
		GENRES,
		id,
		householdScope(sql, viewer, GENRES),
		genreColumns(sql)
	);
	return row ? mapGenre(row) : null;
}

export interface GenreInput {
	name?: unknown;
	notes?: unknown;
}

export function createGenre(
	sql: Queryable,
	viewer: Viewer,
	input: GenreInput
): Promise<WriteResult<Genre>> {
	return guarded<Genre>(async () => {
		const name = requiredText(input.name, 'name', 100);
		const notes = optionalText(input.notes, 'notes');
		const rows = await sql<GenreRow[]>`
			insert into genres (household_id, name, notes, created_by, updated_by)
			values (${viewer.householdId}::uuid, ${name}, ${notes}, ${viewer.userId}::uuid, ${viewer.userId}::uuid)
			returning ${genreColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapGenre(row) };
	});
}

export function updateGenre(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: GenreInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Genre>> {
	return guarded<Genre>(async () => {
		const current = await getGenre(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };
		const name = patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 100));
		const notes = patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'));

		return writeScoped<GenreRow, Genre>({
			sql,
			table: GENRES,
			id,
			readScope: householdScope(sql, viewer, GENRES),
			writeScope: householdScope(sql, viewer, GENRES),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`name = ${name}, notes = ${notes},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: genreColumns(sql),
			map: mapGenre,
			mayWrite: () => true
		});
	});
}

export function setGenreArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Genre>> {
	return writeScoped<GenreRow, Genre>({
		sql,
		table: GENRES,
		id,
		readScope: householdScope(sql, viewer, GENRES),
		writeScope: householdScope(sql, viewer, GENRES),
		...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
		assignments: sql`archived_at = case when ${archived}::boolean then now() else null end,
			updated_at = now(), updated_by = ${viewer.userId}::uuid`,
		columns: genreColumns(sql),
		map: mapGenre,
		mayWrite: () => true
	});
}

export const findOrCreateGenre = (
	sql: Queryable,
	viewer: Viewer,
	name: unknown
): Promise<WriteResult<Genre>> =>
	findOrCreateByName<GenreRow, Genre>(
		sql,
		viewer,
		GENRES,
		name,
		'genre',
		100,
		genreColumns(sql),
		mapGenre
	);
