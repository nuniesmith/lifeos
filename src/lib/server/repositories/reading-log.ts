import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate } from '../db/coerce';
import {
	InvalidInput,
	MAX_LIMIT,
	atomically,
	getScoped,
	guarded,
	householdToday,
	isUuid,
	liveScope,
	readableScope,
	toBool,
	toDayOrNull,
	toInt,
	toIntOrNull,
	toNumberOrNull,
	toText,
	toTextOrNull,
	writableScope,
	writeScoped,
	type Queryable,
	type WriteResult
} from './base';
import { optionalDay, optionalInt, optionalOneOf, optionalText, patched } from './validate';
import {
	BOOK_FORMATS,
	getBook,
	listBooks,
	optionalQuarterRating,
	type BookFormat,
	type BookStatus,
	type BookSummary
} from './reading';

/**
 * The reading log: one row per read-through, per person (Reading Tracker R2;
 * migration 0033). See that migration's header for why `book_reads` carries
 * no household_id or visibility of its own, and no `archived_at`.
 *
 * Three things live in this module: the log itself (start a read, keep it
 * moving, finish or abandon it), the series hub's per-viewer progress, and
 * the TBR picker. All three are per-VIEWER — "how many times have I read
 * this", not "has this household read this" — because a re-read is a new
 * row scoped to one `reader_user_id`, and two people sharing a book build two
 * separate histories of it, the same way two people sharing a routine each
 * build their own completion history (routines.ts).
 */

// ─── reads ──────────────────────────────────────────────────────────────────

export const READ_STATUSES = ['reading', 'paused', 'finished', 'dnf'] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

export interface BookRead {
	id: string;
	bookId: string;
	readerUserId: string;
	status: ReadStatus;
	startedOn: string | null;
	finishedOn: string | null;
	format: BookFormat | null;
	progressPages: number | null;
	progressMinutes: number | null;
	rating: number | null;
	review: string | null;
	dnfReason: string | null;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string | null;
	updatedBy: string | null;
}

interface BookReadRow {
	id: string;
	book_id: string;
	reader_user_id: string;
	status: string;
	started_on: string | null;
	finished_on: string | null;
	format: string | null;
	progress_pages: unknown;
	progress_minutes: unknown;
	rating: unknown;
	review: string | null;
	dnf_reason: string | null;
	created_at: unknown;
	updated_at: unknown;
	created_by: string | null;
	updated_by: string | null;
}

const BOOK_READS = 'book_reads';

const bookReadColumns = (sql: Queryable): Fragment => sql`
	id, book_id, reader_user_id, status, started_on::text as started_on,
	finished_on::text as finished_on, format, progress_pages, progress_minutes,
	rating, review, dnf_reason, created_at, updated_at, created_by, updated_by`;

function mapBookRead(row: BookReadRow): BookRead {
	return {
		id: row.id,
		bookId: row.book_id,
		readerUserId: row.reader_user_id,
		status: row.status as ReadStatus,
		startedOn: toDayOrNull(row.started_on),
		finishedOn: toDayOrNull(row.finished_on),
		format: (row.format as BookFormat | null) ?? null,
		progressPages: toIntOrNull(row.progress_pages),
		progressMinutes: toIntOrNull(row.progress_minutes),
		rating: toNumberOrNull(row.rating),
		review: toTextOrNull(row.review),
		dnfReason: toTextOrNull(row.dnf_reason),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
		createdBy: row.created_by,
		updatedBy: row.updated_by
	};
}

/**
 * `book_reads` carries no household_id or visibility of its own (migration
 * 0033's header): it is readable exactly when its book is. Written as an
 * `exists` against the bare, unaliased column rather than a join, so the same
 * fragment drops into `getScoped`/`writeScoped`'s single-table queries as well
 * as the hand-written joins below.
 */
function readableThroughBook(sql: Queryable, viewer: Viewer): Fragment {
	return sql`exists (
		select 1 from books b where b.id = book_id and ${readableScope(sql, viewer, 'b')}
	)`;
}

/**
 * Narrower than the book itself: a read is visible to whoever can read the
 * book, but changeable only by the reader who logged it — unlike the book,
 * which either household member may edit when it is unowned.
 */
function writableThroughBook(sql: Queryable, viewer: Viewer): Fragment {
	return sql`${readableThroughBook(sql, viewer)} and reader_user_id = ${viewer.userId}::uuid`;
}

/** Re-checked in JS only to explain a refusal (forbidden vs. conflict) once
 *  `writeScoped`'s own UPDATE has already found no row to change — never to
 *  authorise one; see base.ts's `ScopedWrite.mayWrite`. */
const readerIs =
	(viewer: Viewer) =>
	(record: BookRead): boolean =>
		record.readerUserId === viewer.userId;

async function currentRead(sql: Queryable, viewer: Viewer, id: string): Promise<BookRead | null> {
	if (!isUuid(id)) return null;
	const row = await getScoped<BookReadRow>(
		sql,
		BOOK_READS,
		id,
		readableThroughBook(sql, viewer),
		bookReadColumns(sql)
	);
	return row ? mapBookRead(row) : null;
}

/** Mirrors the table's own CHECK (`finished_on >= started_on`), so a bad pair
 *  is a field-level error next to the date rather than a raw constraint
 *  violation surfacing as a 500 — the same discipline `optionalQuarterRating`
 *  (reading.ts) applies to `rating`'s CHECK. */
function checkDateOrder(startedOn: string | null, finishedOn: string | null): void {
	if (startedOn && finishedOn && finishedOn < startedOn) {
		throw new InvalidInput('finished on cannot be before started on');
	}
}

/**
 * Best-effort: moves the book's one shared `status` to `status`, but only
 * when it is currently tbr/reading/paused — not already `finished` or `dnf`
 * by a different read, possibly a different reader's. The household is two
 * people, and nothing stops both from reading the same book at once; without
 * this guard, a reader closing out their OWN read late (a pause, a finish, a
 * DNF logged well after the fact) could silently overwrite a conclusion the
 * OTHER reader's read already reached first. Affecting zero rows here is not
 * a failure to report to the caller — the read itself, the record the caller
 * actually asked to change, has already saved by the time this runs.
 *
 * `startRead` deliberately does not use this: picking a book up always
 * reclaims 'reading' unconditionally, including a reread of a book already
 * marked read, or one the other member marked DNF.
 */
async function setBookStatusIfOpen(
	sql: Queryable,
	viewer: Viewer,
	bookId: string,
	status: 'reading' | 'paused' | 'read' | 'dnf'
): Promise<void> {
	await sql`
		update books set status = ${status}, updated_at = now(), updated_by = ${viewer.userId}::uuid
		where id = ${bookId}::uuid and status in ('tbr', 'reading', 'paused')
		  and ${writableScope(sql, viewer, 'books')}
	`;
}

export interface StartReadInput {
	startedOn?: unknown;
	format?: unknown;
}

/**
 * Starts a read for the viewer, and in the same transaction (hard rule 4)
 * moves the book's status to `reading` — unconditionally; see
 * {@link setBookStatusIfOpen}'s own comment for why starting is the one
 * transition that never checks the book's prior status first.
 *
 * A second active read by the same reader is checked for and refused with a
 * specific message before the insert is attempted; the partial unique index
 * (migration 0033) is the real backstop against a genuine race, and a raw
 * violation from it still falls back to `guarded`'s generic "already exists"
 * message rather than a 500.
 */
export function startRead(
	sql: Queryable,
	viewer: Viewer,
	bookId: string,
	input: StartReadInput = {}
): Promise<WriteResult<BookRead>> {
	if (!isUuid(bookId)) return Promise.resolve({ ok: false, reason: 'not_found' });

	return guarded<BookRead>(() =>
		atomically(sql, async (tx) => {
			const book = await getBook(tx, viewer, bookId);
			if (!book) return { ok: false, reason: 'not_found' };

			const active = await tx<{ id: string }[]>`
				select id from book_reads
				where book_id = ${bookId}::uuid and reader_user_id = ${viewer.userId}::uuid
				  and status in ('reading', 'paused')
				limit 1
			`;
			if (active[0]) {
				throw new InvalidInput(
					'You already have an active read of this book — finish, pause, or delete it first.'
				);
			}

			const startedOn =
				optionalDay(input.startedOn, 'started on') ??
				(await householdToday(tx, viewer.householdId));
			// Undefined (the key was not sent at all) falls back to the book's own
			// format; an explicit value, blank included, is the reader's to set —
			// see migration 0033's column comment.
			const format =
				input.format === undefined
					? book.format
					: optionalOneOf(input.format, 'format', BOOK_FORMATS);

			const rows = await tx<BookReadRow[]>`
				insert into book_reads (
					book_id, reader_user_id, status, started_on, format, created_by, updated_by
				) values (
					${bookId}::uuid, ${viewer.userId}::uuid, 'reading', ${startedOn}::date, ${format},
					${viewer.userId}::uuid, ${viewer.userId}::uuid
				)
				returning ${bookReadColumns(tx)}
			`;
			const row = rows[0];
			if (!row) throw new Error('insert returned no row');

			await tx`
				update books set status = 'reading', updated_at = now(), updated_by = ${viewer.userId}::uuid
				where id = ${bookId}::uuid and ${writableScope(tx, viewer, 'books')}
			`;

			return { ok: true, record: mapBookRead(row) };
		})
	);
}

export interface UpdateReadProgressInput {
	progressPages?: unknown;
	progressMinutes?: unknown;
}

/** Progress alone, patched (hard rule: only a key the caller actually sent is
 *  touched) — an audiobook's minutes must not be zeroed by a print edit that
 *  only ever sends pages, and vice versa. No book-status side effect: the
 *  book is already `reading`. */
export function updateReadProgress(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	input: UpdateReadProgressInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<BookRead>> {
	return guarded<BookRead>(async () => {
		const current = await currentRead(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const progressPages = patched(input, 'progressPages', current.progressPages, (v) =>
			optionalInt(v, 'pages read', { min: 0 })
		);
		const progressMinutes = patched(input, 'progressMinutes', current.progressMinutes, (v) =>
			optionalInt(v, 'minutes listened', { min: 0 })
		);

		return writeScoped<BookReadRow, BookRead>({
			sql,
			table: BOOK_READS,
			id,
			readScope: readableThroughBook(sql, viewer),
			writeScope: writableThroughBook(sql, viewer),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				progress_pages = ${progressPages}, progress_minutes = ${progressMinutes},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: bookReadColumns(sql),
			map: mapBookRead,
			mayWrite: readerIs(viewer)
		});
	});
}

function pauseOrResume(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	readStatus: 'paused' | 'reading',
	bookStatus: 'paused' | 'reading',
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<BookRead>> {
	return guarded<BookRead>(() =>
		atomically(sql, async (tx) => {
			const result = await writeScoped<BookReadRow, BookRead>({
				sql: tx,
				table: BOOK_READS,
				id,
				readScope: readableThroughBook(tx, viewer),
				writeScope: writableThroughBook(tx, viewer),
				...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
				assignments: tx`status = ${readStatus}, updated_at = now(), updated_by = ${viewer.userId}::uuid`,
				columns: bookReadColumns(tx),
				map: mapBookRead,
				mayWrite: readerIs(viewer)
			});
			if (!result.ok) return result;
			await setBookStatusIfOpen(tx, viewer, result.record.bookId, bookStatus);
			return result;
		})
	);
}

/** Pauses the viewer's read, and (guarded — see {@link setBookStatusIfOpen})
 *  the book's status along with it. */
export const pauseRead = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<BookRead>> =>
	pauseOrResume(sql, viewer, id, 'paused', 'paused', expectedUpdatedAt);

/** Resumes a paused read back to `reading`, and the book's status with it. */
export const resumeRead = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<BookRead>> =>
	pauseOrResume(sql, viewer, id, 'reading', 'reading', expectedUpdatedAt);

export interface FinishReadInput {
	finishedOn?: unknown;
	rating?: unknown;
	review?: unknown;
}

/**
 * Finishes a read: sets this read's own `finished_on`/`rating`/`review`,
 * moves the book's status to `read` (guarded), and — only when the book
 * carries no rating of its own yet — copies this read's rating onto the
 * book, so a first read rates the catalogue entry without a second or third
 * read's own rating ever overwriting what is already there.
 */
export function finishRead(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	input: FinishReadInput = {},
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<BookRead>> {
	return guarded<BookRead>(() =>
		atomically(sql, async (tx) => {
			const current = await currentRead(tx, viewer, id);
			if (!current) return { ok: false, reason: 'not_found' };

			const finishedOn =
				optionalDay(input.finishedOn, 'finished on') ??
				(await householdToday(tx, viewer.householdId));
			checkDateOrder(current.startedOn, finishedOn);
			const rating = patched(input, 'rating', current.rating, (v) => optionalQuarterRating(v));
			const review = patched(input, 'review', current.review, (v) =>
				optionalText(v, 'review', 100_000)
			);

			const result = await writeScoped<BookReadRow, BookRead>({
				sql: tx,
				table: BOOK_READS,
				id,
				readScope: readableThroughBook(tx, viewer),
				writeScope: writableThroughBook(tx, viewer),
				...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
				assignments: tx`
					status = 'finished', finished_on = ${finishedOn}::date,
					rating = ${rating}, review = ${review},
					updated_at = now(), updated_by = ${viewer.userId}::uuid`,
				columns: bookReadColumns(tx),
				map: mapBookRead,
				mayWrite: readerIs(viewer)
			});
			if (!result.ok) return result;

			await setBookStatusIfOpen(tx, viewer, result.record.bookId, 'read');
			if (result.record.rating !== null) {
				await tx`
					update books set rating = ${result.record.rating}, updated_at = now(),
						updated_by = ${viewer.userId}::uuid
					where id = ${result.record.bookId}::uuid and rating is null
					  and ${writableScope(tx, viewer, 'books')}
				`;
			}
			return result;
		})
	);
}

export interface DnfReadInput {
	reason?: unknown;
}

/** Abandons a read as of today (the signature this pack specifies carries no
 *  date of its own — see migration 0033's header for `finished_on`), and
 *  moves the book's status to `dnf` (guarded). */
export function dnfRead(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	input: DnfReadInput = {},
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<BookRead>> {
	return guarded<BookRead>(() =>
		atomically(sql, async (tx) => {
			const current = await currentRead(tx, viewer, id);
			if (!current) return { ok: false, reason: 'not_found' };

			const finishedOn = await householdToday(tx, viewer.householdId);
			checkDateOrder(current.startedOn, finishedOn);
			const reason = optionalText(input.reason, 'reason', 2000);

			const result = await writeScoped<BookReadRow, BookRead>({
				sql: tx,
				table: BOOK_READS,
				id,
				readScope: readableThroughBook(tx, viewer),
				writeScope: writableThroughBook(tx, viewer),
				...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
				assignments: tx`
					status = 'dnf', finished_on = ${finishedOn}::date, dnf_reason = ${reason},
					updated_at = now(), updated_by = ${viewer.userId}::uuid`,
				columns: bookReadColumns(tx),
				map: mapBookRead,
				mayWrite: readerIs(viewer)
			});
			if (!result.ok) return result;

			await setBookStatusIfOpen(tx, viewer, result.record.bookId, 'dnf');
			return result;
		})
	);
}

export interface UpdateReadInput {
	startedOn?: unknown;
	finishedOn?: unknown;
	format?: unknown;
	rating?: unknown;
	review?: unknown;
}

/**
 * Corrects a logged read after the fact — dates, format, rating, review —
 * with no effect on the book's own status: that is what the dedicated
 * start/pause/resume/finish/dnf actions are for. Optimistic concurrency via
 * `expectedUpdatedAt`, the same as every other editable record.
 */
export function updateRead(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: UpdateReadInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<BookRead>> {
	return guarded<BookRead>(async () => {
		const current = await currentRead(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const startedOn = patched(patch, 'startedOn', current.startedOn, (v) =>
			optionalDay(v, 'started on')
		);
		const finishedOn = patched(patch, 'finishedOn', current.finishedOn, (v) =>
			optionalDay(v, 'finished on')
		);
		checkDateOrder(startedOn, finishedOn);
		const format = patched(patch, 'format', current.format, (v) =>
			optionalOneOf(v, 'format', BOOK_FORMATS)
		);
		const rating = patched(patch, 'rating', current.rating, (v) => optionalQuarterRating(v));
		const review = patched(patch, 'review', current.review, (v) =>
			optionalText(v, 'review', 100_000)
		);

		return writeScoped<BookReadRow, BookRead>({
			sql,
			table: BOOK_READS,
			id,
			readScope: readableThroughBook(sql, viewer),
			writeScope: writableThroughBook(sql, viewer),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				started_on = ${startedOn}::date, finished_on = ${finishedOn}::date, format = ${format},
				rating = ${rating}, review = ${review},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: bookReadColumns(sql),
			map: mapBookRead,
			mayWrite: readerIs(viewer)
		});
	});
}

/**
 * Deletes a read outright (migration 0033: no archived_at, like a habit
 * check-in). `not_found` covers both a malformed id and a book the viewer
 * cannot see; a read that belongs to a different reader of a visible book is
 * `forbidden` — the two are told apart deliberately (hard rule 8), and the
 * authorization is carried into the DELETE's own WHERE as well as the
 * preceding check, not only the preceding check.
 */
export async function deleteRead(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<WriteResult<{ id: string }>> {
	if (!isUuid(id)) return { ok: false, reason: 'not_found' };
	const row = await getScoped<BookReadRow>(
		sql,
		BOOK_READS,
		id,
		readableThroughBook(sql, viewer),
		bookReadColumns(sql)
	);
	if (!row) return { ok: false, reason: 'not_found' };
	const record = mapBookRead(row);
	if (record.readerUserId !== viewer.userId) return { ok: false, reason: 'forbidden' };

	await sql`delete from book_reads where id = ${id}::uuid and reader_user_id = ${viewer.userId}::uuid`;
	return { ok: true, record: { id } };
}

// ─── reading, by book or by viewer ─────────────────────────────────────────

export interface BookReadWithReader extends BookRead {
	/** `users.display_name` — whoever logged this read, for the book page's
	 *  shared history (every reader's reads show there, not only the viewer's). */
	readerName: string;
}

/** A book's whole read history, every reader's, newest read first — for
 *  `/reading/books/[id]`'s "Reading" section. Visible whenever the book is;
 *  editing any one row is still gated to its own reader (hard rule 8). */
export async function listReadsForBook(
	sql: Queryable,
	viewer: Viewer,
	bookId: string
): Promise<BookReadWithReader[]> {
	if (!isUuid(bookId)) return [];
	const rows = await sql<(BookReadRow & { reader_name: string })[]>`
		select r.id, r.book_id, r.reader_user_id, r.status,
			r.started_on::text as started_on, r.finished_on::text as finished_on,
			r.format, r.progress_pages, r.progress_minutes, r.rating, r.review, r.dnf_reason,
			r.created_at, r.updated_at, r.created_by, r.updated_by,
			u.display_name as reader_name
		from book_reads r
		join users u on u.id = r.reader_user_id
		where r.book_id = ${bookId}::uuid
		  and exists (select 1 from books b where b.id = r.book_id and ${readableScope(sql, viewer, 'b')})
		order by coalesce(r.started_on, r.created_at::date) desc, r.created_at desc
	`;
	return rows.map((row) => ({ ...mapBookRead(row), readerName: toText(row.reader_name) }));
}

export interface ActiveRead {
	id: string;
	bookId: string;
	bookTitle: string;
	authorNames: string | null;
	status: 'reading' | 'paused';
	format: BookFormat | null;
	progressPages: number | null;
	progressMinutes: number | null;
	/** The book's own totals, for "123 of 400 pages" — null when the
	 *  catalogue entry does not carry one. */
	pages: number | null;
	audiobookMinutes: number | null;
	startedOn: string | null;
	updatedAt: Date;
}

interface ActiveReadRow {
	id: string;
	book_id: string;
	book_title: string;
	author_names: string | null;
	status: string;
	format: string | null;
	progress_pages: unknown;
	progress_minutes: unknown;
	pages: unknown;
	audiobook_minutes: unknown;
	started_on: string | null;
	updated_at: unknown;
}

/** The viewer's own reading/paused reads, across every book — the Reading
 *  Tracker home page's "Currently reading" (Reading Tracker R2 replaces R1's
 *  book-status-only version of this list with this one). */
export async function activeReads(sql: Queryable, viewer: Viewer): Promise<ActiveRead[]> {
	const rows = await sql<ActiveReadRow[]>`
		select r.id, r.book_id, b.title as book_title,
			(
				select string_agg(a.name, ', ' order by coalesce(ba.position, 32767), lower(a.name))
				from book_authors ba join authors a on a.id = ba.author_id
				where ba.book_id = b.id
			) as author_names,
			r.status, r.format, r.progress_pages, r.progress_minutes,
			b.pages, b.audiobook_minutes, r.started_on::text as started_on, r.updated_at
		from book_reads r
		join books b on b.id = r.book_id
		where r.reader_user_id = ${viewer.userId}::uuid
		  and r.status in ('reading', 'paused')
		  and ${readableScope(sql, viewer, 'b')}
		order by r.updated_at desc
	`;
	return rows.map((row) => ({
		id: row.id,
		bookId: row.book_id,
		bookTitle: toText(row.book_title),
		authorNames: toTextOrNull(row.author_names),
		status: row.status as ActiveRead['status'],
		format: (row.format as BookFormat | null) ?? null,
		progressPages: toIntOrNull(row.progress_pages),
		progressMinutes: toIntOrNull(row.progress_minutes),
		pages: toIntOrNull(row.pages),
		audiobookMinutes: toIntOrNull(row.audiobook_minutes),
		startedOn: toDayOrNull(row.started_on),
		updatedAt: toDate(row.updated_at)
	}));
}

/** The shape `BookList` ($lib/components) already renders, so the Reading
 *  Tracker home page's "Recently read" can reuse it exactly the way it
 *  already reuses `BookList` for "Currently reading" and "Up next". */
export interface RecentlyReadBook {
	id: string;
	title: string;
	authorNames: string | null;
	seriesName: string | null;
	seriesPosition: number | null;
	status: BookStatus;
	favourite: boolean;
}

interface RecentlyReadRow {
	id: string;
	title: string;
	status: string;
	favourite: unknown;
	series_name: string | null;
	series_position: unknown;
	author_names: string | null;
	finished_on: string | null;
}

/**
 * Books the VIEWER has personally finished, most recently finished first —
 * Reading Tracker R2's replacement for R1's "every book the household marked
 * read" (this pack's header). A rereads' book appears once, at its most
 * recent finish: the inner query keeps one row per book (`distinct on`,
 * itself ordered newest-finish-first so that is the row it keeps), and the
 * outer query re-sorts that already-deduplicated set and applies the limit.
 */
export async function recentlyRead(
	sql: Queryable,
	viewer: Viewer,
	limit = 10
): Promise<RecentlyReadBook[]> {
	const rows = await sql<RecentlyReadRow[]>`
		select * from (
			select distinct on (b.id)
				b.id, b.title, b.status, b.favourite, b.series_position,
				(select bs.name from book_series bs where bs.id = b.series_id) as series_name,
				(
					select string_agg(a.name, ', ' order by coalesce(ba.position, 32767), lower(a.name))
					from book_authors ba join authors a on a.id = ba.author_id
					where ba.book_id = b.id
				) as author_names,
				r.finished_on::text as finished_on, r.created_at as read_created_at
			from book_reads r
			join books b on b.id = r.book_id
			where r.reader_user_id = ${viewer.userId}::uuid and r.status = 'finished'
			  and ${readableScope(sql, viewer, 'b')} and ${liveScope(sql, 'b')}
			order by b.id, r.finished_on desc nulls last, r.created_at desc
		) recent
		order by recent.finished_on desc nulls last, recent.read_created_at desc
		limit ${limit}
	`;
	return rows.map((row) => ({
		id: row.id,
		title: toText(row.title),
		authorNames: toTextOrNull(row.author_names),
		seriesName: toTextOrNull(row.series_name),
		seriesPosition: toNumberOrNull(row.series_position),
		status: row.status as BookStatus,
		favourite: toBool(row.favourite)
	}));
}

/** How many times the VIEWER has finished this book — "Read N times" on the
 *  book page. A re-read is a new row (migration 0033's header), so this is
 *  `count(*)`, never a number stored anywhere; a DNF does not count. */
export async function readCount(sql: Queryable, viewer: Viewer, bookId: string): Promise<number> {
	if (!isUuid(bookId)) return 0;
	const rows = await sql<{ count: unknown }[]>`
		select count(*)::int as count from book_reads
		where book_id = ${bookId}::uuid and reader_user_id = ${viewer.userId}::uuid
		  and status = 'finished'
	`;
	return toInt(rows[0]?.count ?? 0);
}

// ─── series hub ─────────────────────────────────────────────────────────────

export interface SeriesProgressBook {
	id: string;
	title: string;
	seriesPosition: number | null;
	/** Whether the VIEWER — not the household — has finished this book at
	 *  least once. */
	finished: boolean;
}

export interface SeriesProgress {
	books: SeriesProgressBook[];
	/** The first book in position order the viewer has not finished, or null
	 *  when every visible book in the series is finished (or the series is
	 *  empty). */
	nextUpId: string | null;
}

/** Per-viewer progress through a series, in position order, for
 *  `/reading/series/[id]`'s checkmarks and "Next up". */
export async function seriesProgress(
	sql: Queryable,
	viewer: Viewer,
	seriesId: string
): Promise<SeriesProgress> {
	if (!isUuid(seriesId)) return { books: [], nextUpId: null };
	const rows = await sql<
		{ id: string; title: string; series_position: unknown; finished: unknown }[]
	>`
		select b.id, b.title, b.series_position,
			exists (
				select 1 from book_reads r
				where r.book_id = b.id and r.reader_user_id = ${viewer.userId}::uuid
				  and r.status = 'finished'
			) as finished
		from books b
		where b.series_id = ${seriesId}::uuid and b.archived_at is null
		  and ${readableScope(sql, viewer, 'b')}
		order by b.series_position asc nulls last, lower(b.title) asc
	`;
	const books = rows.map((row) => ({
		id: row.id,
		title: toText(row.title),
		seriesPosition: toNumberOrNull(row.series_position),
		finished: toBool(row.finished)
	}));
	const nextUp = books.find((b) => !b.finished) ?? null;
	return { books, nextUpId: nextUp?.id ?? null };
}

// ─── TBR picker ─────────────────────────────────────────────────────────────

export interface TbrPickerFilters {
	genreId?: string;
	format?: BookFormat;
	owned?: boolean;
	maxPages?: number;
	excludeIds?: readonly string[];
}

/**
 * A random TBR book the viewer can read, filtered the same way
 * `/reading/tbr`'s own filters are — the same pattern as `pickMediaToWatch`
 * in collections.ts (see `/entertainment/pick`): the pick happens in JS over
 * every matching row rather than `order by random() limit 1`, so a test can
 * pin `random` and know exactly which book comes back. Unlike
 * `pickMediaToWatch`, this reuses `listBooks` (reading.ts) rather than a
 * second hand-written query — `listBooks` already is "one query, every
 * Reading Tracker list" (its own doc comment), and `format`/`maxPages`/
 * `excludeIds` were added to `BookFilters` for exactly this caller.
 */
export async function pickTbr(
	sql: Queryable,
	viewer: Viewer,
	filters: TbrPickerFilters = {},
	random: () => number = Math.random
): Promise<BookSummary | null> {
	const candidates = await listBooks(sql, viewer, {
		status: 'tbr',
		...(filters.genreId !== undefined ? { genreId: filters.genreId } : {}),
		...(filters.format !== undefined ? { format: filters.format } : {}),
		...(filters.owned !== undefined ? { owned: filters.owned } : {}),
		...(filters.maxPages !== undefined ? { maxPages: filters.maxPages } : {}),
		...(filters.excludeIds !== undefined ? { excludeIds: filters.excludeIds } : {}),
		limit: MAX_LIMIT
	});
	if (candidates.length === 0) return null;
	const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
	return candidates[index]!;
}
