import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate, toDateOrNull } from '../db/coerce';
import {
	InvalidInput,
	MAX_LIMIT,
	archiveScoped,
	atomically,
	baseColumns,
	getScoped,
	guarded,
	householdToday,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toInt,
	toIntOrNull,
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
import { BOOK_CATEGORIES, BOOK_FORMATS, type BookCategory, type BookFormat } from './reading';
import { compactPositions } from './routines';
import {
	oneOf,
	optionalId,
	optionalInt,
	optionalOneOf,
	optionalText,
	patched,
	requiredInt,
	requiredText
} from './validate';

/**
 * Reading challenges, their prompts, and the year-end Insights they sit
 * beside (Reading Tracker R3; migration 0035).
 *
 * A challenge is a personal goal that the household may still see: it
 * defaults to owned by whoever creates it (like `routines`, not like
 * `books`), because a `count` challenge's progress is specifically the
 * OWNER's own finished reads -- Kayla viewing the operator's "30 books in
 * 2026" sees the operator's count, never a blend with her own. That is also
 * why count progress is computed in SQL on every read rather than stored:
 * editing or backfilling a read must move the number without anything
 * remembering to update a counter.
 *
 * `reading_challenge_items` -- a prompts challenge's prompt sheet -- is
 * scoped through its challenge exactly the way `routine_steps` is scoped
 * through `routines` (that module's own header): no household_id, owner or
 * visibility of its own, unique live positions with the same negative-park
 * swap `moveStep` uses, and compacted on archive the same way. See that
 * module for the pattern this one is built to match, not reinvent.
 */

// ─── challenges ─────────────────────────────────────────────────────────────

export const CHALLENGE_KINDS = ['count', 'prompts'] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

export interface ReadingChallenge extends RecordBase {
	title: string;
	year: number;
	notes: string | null;
	kind: ChallengeKind;
	targetCount: number | null;
	category: BookCategory | null;
	format: BookFormat | null;
	genreId: string | null;
}

interface ReadingChallengeRow extends BaseRow {
	title: string;
	year: unknown;
	notes: string | null;
	kind: string;
	target_count: unknown;
	category: string | null;
	format: string | null;
	genre_id: string | null;
}

const READING_CHALLENGES = 'reading_challenges';

const challengeColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	title, year, notes, kind, target_count, category, format, genre_id`;

function mapChallenge(row: ReadingChallengeRow): ReadingChallenge {
	return {
		...mapBase(row),
		title: toText(row.title),
		year: toInt(row.year),
		notes: toTextOrNull(row.notes),
		kind: row.kind as ChallengeKind,
		targetCount: toIntOrNull(row.target_count),
		category: (row.category as BookCategory | null) ?? null,
		format: (row.format as BookFormat | null) ?? null,
		genreId: row.genre_id
	};
}

export interface ReadingChallengeInput extends OwnershipInput {
	title?: unknown;
	year?: unknown;
	notes?: unknown;
	kind?: unknown;
	targetCount?: unknown;
	category?: unknown;
	format?: unknown;
	genreId?: unknown;
}

/** Every field a challenge write can touch other than `title` and `year`
 *  (validated separately below, the same reason `bookFieldsFrom` excludes
 *  `title` -- see that comment in reading.ts). */
interface ChallengeFields {
	notes: string | null;
	kind: ChallengeKind;
	targetCount: number | null;
	category: BookCategory | null;
	format: BookFormat | null;
	genreId: string | null;
}

const NEW_CHALLENGE_DEFAULTS: ChallengeFields = {
	notes: null,
	kind: 'count',
	targetCount: null,
	category: null,
	format: null,
	genreId: null
};

/** Mirrors `validatedHabitId` in routines.ts: only the shape is checked here
 *  (an id that is not a well-formed uuid would otherwise reach the database
 *  as one and raise a raw driver error instead of a field-level message).
 *  Whether the genre actually exists is not checked -- an unmatched id
 *  simply narrows a count challenge's progress to nothing, the same laxity
 *  `listBooks`' own `genreId` filter already accepts. */
function validatedGenreId(value: unknown): string | null {
	const id = optionalId(value, 'genre');
	if (id !== null && !isUuid(id)) throw new InvalidInput('genre is not a valid id');
	return id;
}

/**
 * Resolves every {@link ChallengeFields} value from a patch against a
 * baseline, the same shape `bookFieldsFrom` follows. `target_count` and the
 * three count-only filters are forced to match `kind` here -- not merely
 * hoped for from the form -- because the table's own CHECK (migration 0035)
 * is the backstop for whatever reaches this far regardless, and a raw
 * constraint violation surfacing as a 500 is exactly what validating first
 * avoids everywhere else in this layer.
 */
function challengeFieldsFrom(
	patch: ReadingChallengeInput,
	current: ChallengeFields
): ChallengeFields {
	const kind = patched(patch, 'kind', current.kind, (v) => oneOf(v, 'kind', CHALLENGE_KINDS));
	const targetCount = patched(patch, 'targetCount', current.targetCount, (v) =>
		optionalInt(v, 'target', { min: 1 })
	);
	if (kind === 'count' && targetCount === null) {
		throw new InvalidInput('a count challenge needs a target');
	}
	const category = patched(patch, 'category', current.category, (v) =>
		optionalOneOf(v, 'category', BOOK_CATEGORIES)
	);
	const format = patched(patch, 'format', current.format, (v) =>
		optionalOneOf(v, 'format', BOOK_FORMATS)
	);
	const genreId = patched(patch, 'genreId', current.genreId, validatedGenreId);

	return {
		notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes', 20_000)),
		kind,
		targetCount: kind === 'count' ? targetCount : null,
		category: kind === 'count' ? category : null,
		format: kind === 'count' ? format : null,
		genreId: kind === 'count' ? genreId : null
	};
}

export interface ReadingChallengeListFilters extends PageOptions {
	includeArchived?: boolean;
}

export interface ChallengeProgress {
	/** Finished books toward `targetCount` for a `count` challenge, or filled
	 *  prompts for a `prompts` one. */
	done: number;
	/** `targetCount` for a `count` challenge, or the live prompt count for a
	 *  `prompts` one. */
	total: number;
}

export interface ReadingChallengeSummary extends ReadingChallenge {
	progress: ChallengeProgress;
}

interface ReadingChallengeSummaryRow extends ReadingChallengeRow {
	count_done: unknown;
	prompts_done: unknown;
	prompts_total: unknown;
}

/**
 * Every challenge the viewer may read, each with its own progress -- done and
 * total computed fresh in one correlated subquery per kind, the same style
 * `listBookSeries` already uses for `finishedCount` (reading.ts), rather than
 * a stored counter that could drift from the reads it describes.
 *
 * A `count` challenge's progress counts only its OWNER's finished reads
 * (hard rule 9: another member's reads never count toward it), narrowed by
 * whichever of its own category/format/genre filters are set, and only
 * among books the VIEWER asking may read -- so a challenge shared with the
 * household never discloses a book its owner keeps private, even as a bare
 * number. A `prompts` challenge's progress is simply its live items, filled
 * versus total.
 */
export async function listReadingChallenges(
	sql: Queryable,
	viewer: Viewer,
	filters: ReadingChallengeListFilters = {}
): Promise<ReadingChallengeSummary[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<ReadingChallengeSummaryRow[]>`
		select ${challengeColumns(sql)},
			(
				select count(*)::int from book_reads r
				join books b on b.id = r.book_id
				where r.reader_user_id = c.owner_user_id
				  and r.status = 'finished'
				  and r.finished_on is not null
				  and extract(year from r.finished_on)::int = c.year
				  and ${readableScope(sql, viewer, 'b')}
				  and (c.category is null or b.category = c.category)
				  and (c.format is null or coalesce(r.format, b.format) = c.format)
				  and (
				      c.genre_id is null or exists (
				          select 1 from book_genres bg
				          where bg.book_id = b.id and bg.genre_id = c.genre_id
				      )
				  )
			) as count_done,
			(
				select count(*)::int from reading_challenge_items i
				where i.challenge_id = c.id and i.archived_at is null
			) as prompts_total,
			(
				select count(*)::int from reading_challenge_items i
				where i.challenge_id = c.id and i.archived_at is null and i.book_id is not null
			) as prompts_done
		from reading_challenges c
		where ${readableScope(sql, viewer, 'c')}
		  and ${liveScope(sql, 'c', filters.includeArchived)}
		order by c.year desc, lower(c.title) asc
		limit ${limit} offset ${offset}
	`;
	return rows.map((row) => {
		const challenge = mapChallenge(row);
		const progress: ChallengeProgress =
			challenge.kind === 'count'
				? { done: toInt(row.count_done), total: challenge.targetCount ?? 0 }
				: { done: toInt(row.prompts_done), total: toInt(row.prompts_total) };
		return { ...challenge, progress };
	});
}

export async function getReadingChallenge(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<ReadingChallenge | null> {
	const row = await getScoped<ReadingChallengeRow>(
		sql,
		READING_CHALLENGES,
		id,
		readableScope(sql, viewer, READING_CHALLENGES),
		challengeColumns(sql)
	);
	return row ? mapChallenge(row) : null;
}

export function createReadingChallenge(
	sql: Queryable,
	viewer: Viewer,
	input: ReadingChallengeInput
): Promise<WriteResult<ReadingChallenge>> {
	return guarded<ReadingChallenge>(async () => {
		const title = requiredText(input.title, 'title', 200);
		const year = requiredInt(input.year, 'year', { min: 1900, max: 2200 });
		const fields = challengeFieldsFrom(input, NEW_CHALLENGE_DEFAULTS);
		// Owned by its creator by default -- like `routines`, not like `books` --
		// because "progress" only means something against one specific person's
		// reads (this module's header).
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'household'
		});

		const rows = await sql<ReadingChallengeRow[]>`
			insert into reading_challenges (
				household_id, owner_user_id, visibility, title, year, notes, kind,
				target_count, category, format, genre_id, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title}, ${year},
				${fields.notes}, ${fields.kind}, ${fields.targetCount}, ${fields.category}, ${fields.format},
				${fields.genreId}::uuid, ${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${challengeColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapChallenge(row) };
	});
}

export function updateReadingChallenge(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: ReadingChallengeInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<ReadingChallenge>> {
	return guarded<ReadingChallenge>(async () => {
		const current = await getReadingChallenge(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const title = patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 200));
		const year = patched(patch, 'year', current.year, (v) =>
			requiredInt(v, 'year', { min: 1900, max: 2200 })
		);
		const fields = challengeFieldsFrom(patch, current);
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<ReadingChallengeRow, ReadingChallenge>({
			sql,
			table: READING_CHALLENGES,
			id,
			readScope: readableScope(sql, viewer, READING_CHALLENGES),
			writeScope: writableScope(sql, viewer, READING_CHALLENGES),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			// Not a migration-0004 table, so nothing sets updated_at for this write
			// unless this does (base.ts's header rule 3).
			assignments: sql`
				title = ${title}, year = ${year}, notes = ${fields.notes}, kind = ${fields.kind},
				target_count = ${fields.targetCount}, category = ${fields.category}, format = ${fields.format},
				genre_id = ${fields.genreId}::uuid,
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: challengeColumns(sql),
			map: mapChallenge,
			mayWrite: writableBy(viewer)
		});
	});
}

export const setReadingChallengeArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<ReadingChallenge>> =>
	archiveScoped<ReadingChallengeRow, ReadingChallenge>({
		sql,
		table: READING_CHALLENGES,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: challengeColumns(sql),
		map: mapChallenge
	});

// ─── count challenges: the books that count ────────────────────────────────

export interface ChallengeCountBook {
	id: string;
	title: string;
	finishedOn: string | null;
}

/**
 * The OWNER's finished books that count toward a `count` challenge, newest
 * finish first -- the same predicate `listReadingChallenges` uses for its
 * `count_done` subquery, written out here because the detail page needs the
 * actual books, not only how many. See that function's own comment for why
 * this is the owner's reads, scoped to what the VIEWER may read.
 */
export async function countChallengeBooks(
	sql: Queryable,
	viewer: Viewer,
	challenge: ReadingChallenge
): Promise<ChallengeCountBook[]> {
	const rows = await sql<{ id: string; title: string; finished_on: string | null }[]>`
		select b.id, b.title, r.finished_on::text as finished_on
		from book_reads r
		join books b on b.id = r.book_id
		where r.reader_user_id = ${challenge.ownerUserId}::uuid
		  and r.status = 'finished'
		  and r.finished_on is not null
		  and extract(year from r.finished_on)::int = ${challenge.year}
		  and ${readableScope(sql, viewer, 'b')}
		  ${challenge.category ? sql`and b.category = ${challenge.category}` : sql``}
		  ${challenge.format ? sql`and coalesce(r.format, b.format) = ${challenge.format}` : sql``}
		  ${
				challenge.genreId
					? sql`and exists (
						select 1 from book_genres bg
						where bg.book_id = b.id and bg.genre_id = ${challenge.genreId}::uuid
					)`
					: sql``
			}
		order by r.finished_on desc nulls last, lower(b.title) asc
	`;
	return rows.map((row) => ({
		id: row.id,
		title: toText(row.title),
		finishedOn: row.finished_on
	}));
}

// ─── reading_challenge_items: the prompts of a prompts challenge ───────────
//
// Scoped through `reading_challenges` the way `routine_steps` is scoped
// through `routines`: no household_id, owner or visibility of its own, so
// every function below reaches its scope by joining the challenge.

const MOVE_DIRECTIONS = ['up', 'down'] as const;

export interface ReadingChallengeItem {
	id: string;
	challengeId: string;
	position: number;
	prompt: string;
	bookId: string | null;
	completedOn: string | null;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string | null;
	updatedBy: string | null;
}

/** A prompt with its filling book's title joined in, for the challenge
 *  detail page's list -- never stored on the item itself. */
export interface ReadingChallengeItemWithBook extends ReadingChallengeItem {
	bookTitle: string | null;
}

interface ReadingChallengeItemRow {
	id: string;
	challenge_id: string;
	position: unknown;
	prompt: string;
	book_id: string | null;
	completed_on: string | null;
	archived_at: unknown;
	created_at: unknown;
	updated_at: unknown;
	created_by: string | null;
	updated_by: string | null;
}

const itemColumns = (sql: Queryable): Fragment => sql`
	i.id, i.challenge_id, i.position, i.prompt, i.book_id,
	i.completed_on::text as completed_on, i.archived_at,
	i.created_at, i.updated_at, i.created_by, i.updated_by`;

function mapItem(row: ReadingChallengeItemRow): ReadingChallengeItem {
	return {
		id: row.id,
		challengeId: row.challenge_id,
		position: toInt(row.position),
		prompt: toText(row.prompt),
		bookId: row.book_id,
		completedOn: row.completed_on,
		archivedAt: toDateOrNull(row.archived_at),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
		createdBy: row.created_by,
		updatedBy: row.updated_by
	};
}

/** Reads an item through its challenge's readable scope, for defaults and
 *  for functions that authorize the actual write themselves -- the same
 *  role `getStepScoped` plays in routines.ts. Not exported. */
async function getItemScoped(
	sql: Queryable,
	viewer: Viewer,
	itemId: string
): Promise<ReadingChallengeItem | null> {
	if (!isUuid(itemId)) return null;
	const rows = await sql<ReadingChallengeItemRow[]>`
		select ${itemColumns(sql)} from reading_challenge_items i
		join reading_challenges c on c.id = i.challenge_id
		where i.id = ${itemId}::uuid and ${readableScope(sql, viewer, 'c')}
	`;
	return rows[0] ? mapItem(rows[0]) : null;
}

/** A challenge's live prompts, in position order, each with its filling
 *  book's title -- readable is enough (like `listRoutineSteps`): whoever can
 *  see a household-shared challenge sees its prompt list, whichever member
 *  owns it. */
export async function listChallengeItems(
	sql: Queryable,
	viewer: Viewer,
	challengeId: string
): Promise<ReadingChallengeItemWithBook[]> {
	if (!isUuid(challengeId)) return [];
	const rows = await sql<(ReadingChallengeItemRow & { book_title: string | null })[]>`
		select ${itemColumns(sql)}, bk.title as book_title
		from reading_challenge_items i
		join reading_challenges c on c.id = i.challenge_id
		left join books bk on bk.id = i.book_id and ${readableScope(sql, viewer, 'bk')}
		where i.challenge_id = ${challengeId}::uuid and i.archived_at is null
		  and ${readableScope(sql, viewer, 'c')}
		order by i.position asc
	`;
	return rows.map((row) => ({ ...mapItem(row), bookTitle: toTextOrNull(row.book_title) }));
}

export interface ChallengeItemInput {
	prompt?: unknown;
}

/**
 * Adds a prompt at the end of a challenge. The challenge must be the
 * writer's -- the same `writableScope` gate `addStep` puts on its routine.
 */
export function addChallengeItem(
	sql: Queryable,
	viewer: Viewer,
	challengeId: string,
	input: ChallengeItemInput
): Promise<WriteResult<ReadingChallengeItem>> {
	if (!isUuid(challengeId)) return Promise.resolve({ ok: false, reason: 'not_found' });

	return guarded<ReadingChallengeItem>(async () => {
		const prompt = requiredText(input.prompt, 'prompt', 500);

		const rows = await sql<ReadingChallengeItemRow[]>`
			insert into reading_challenge_items as i (
				challenge_id, position, prompt, created_by, updated_by
			)
			select c.id,
			       coalesce(
			           (select max(ri.position) from reading_challenge_items ri
			            where ri.challenge_id = c.id and ri.archived_at is null),
			           0
			       ) + 1,
			       ${prompt}, ${viewer.userId}::uuid, ${viewer.userId}::uuid
			from reading_challenges c
			where c.id = ${challengeId}::uuid and ${writableScope(sql, viewer, 'c')}
			returning ${itemColumns(sql)}
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'not_found' };
		return { ok: true, record: mapItem(row) };
	});
}

export function updateChallengeItem(
	sql: Queryable,
	viewer: Viewer,
	itemId: string,
	patch: ChallengeItemInput
): Promise<WriteResult<ReadingChallengeItem>> {
	return guarded<ReadingChallengeItem>(async () => {
		const current = await getItemScoped(sql, viewer, itemId);
		if (!current) return { ok: false, reason: 'not_found' };
		const prompt = patched(patch, 'prompt', current.prompt, (v) => requiredText(v, 'prompt', 500));

		const rows = await sql<ReadingChallengeItemRow[]>`
			update reading_challenge_items as i set
				prompt = ${prompt}, updated_at = now(), updated_by = ${viewer.userId}::uuid
			from reading_challenges c
			where i.id = ${itemId}::uuid and i.challenge_id = c.id and ${writableScope(sql, viewer, 'c')}
			returning ${itemColumns(sql)}
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'not_found' };
		return { ok: true, record: mapItem(row) };
	});
}

/**
 * Swaps a prompt with its live neighbour. Identical to routines.ts's
 * `moveStep`, including the negative-position park that avoids the unique
 * index's write-order hazard -- see that function's own comment; reinventing
 * it here would only be a second place for the same bug to reappear.
 */
export function moveChallengeItem(
	sql: Queryable,
	viewer: Viewer,
	itemId: string,
	direction: string
): Promise<WriteResult<ReadingChallengeItem>> {
	const dir = oneOf(direction, 'direction', MOVE_DIRECTIONS);

	return guarded<ReadingChallengeItem>(() =>
		atomically(sql, async (tx): Promise<WriteResult<ReadingChallengeItem>> => {
			const current = await getItemScoped(tx, viewer, itemId);
			if (!current) return { ok: false, reason: 'not_found' };

			const neighbourPosition = dir === 'up' ? current.position - 1 : current.position + 1;
			const [neighbour] = await tx<{ id: string }[]>`
				select i.id from reading_challenge_items i
				join reading_challenges c on c.id = i.challenge_id
				where i.challenge_id = ${current.challengeId}::uuid and i.archived_at is null
				  and i.position = ${neighbourPosition}::int and ${writableScope(tx, viewer, 'c')}
			`;
			// Already first (moving up) or last (moving down): a no-op success,
			// not an error -- the button that asked for this is disabled the
			// moment the page re-reads the list.
			if (!neighbour) return { ok: true, record: current };

			const parked = await tx<{ id: string }[]>`
				update reading_challenge_items i set position = -i.position
				from reading_challenges c
				where i.id = ${itemId}::uuid and i.challenge_id = c.id and ${writableScope(tx, viewer, 'c')}
				returning i.id
			`;
			if (parked.length === 0) return { ok: false, reason: 'not_found' };

			await tx`
				update reading_challenge_items set position = ${current.position}::int
				where id = ${neighbour.id}::uuid
			`;
			const rows = await tx<ReadingChallengeItemRow[]>`
				update reading_challenge_items as i
				set position = ${neighbourPosition}::int, updated_at = now(),
					updated_by = ${viewer.userId}::uuid
				where i.id = ${itemId}::uuid
				returning ${itemColumns(tx)}
			`;
			const row = rows[0];
			if (!row) throw new Error('item vanished mid-move');
			return { ok: true, record: mapItem(row) };
		})
	);
}

/**
 * Archives or restores a prompt, compacting the remaining live positions on
 * archive and appending on restore -- identical in shape to routines.ts's
 * `setStepArchived`; see that function for why restoring appends rather than
 * reclaiming the old slot. There is no page that restores one prompt by
 * itself (archive.ts's `NOT_IN_THE_ARCHIVE`, the same reason `routine_steps`
 * is there), but this stays symmetric regardless.
 */
export function setChallengeItemArchived(
	sql: Queryable,
	viewer: Viewer,
	itemId: string,
	archived: boolean
): Promise<WriteResult<ReadingChallengeItem>> {
	return guarded<ReadingChallengeItem>(() =>
		atomically(sql, async (tx): Promise<WriteResult<ReadingChallengeItem>> => {
			const current = await getItemScoped(tx, viewer, itemId);
			if (!current) return { ok: false, reason: 'not_found' };
			if (Boolean(current.archivedAt) === archived) return { ok: true, record: current };

			if (archived) {
				const rows = await tx<ReadingChallengeItemRow[]>`
					update reading_challenge_items as i set archived_at = now(),
						updated_at = now(), updated_by = ${viewer.userId}::uuid
					from reading_challenges c
					where i.id = ${itemId}::uuid and i.challenge_id = c.id
					  and ${writableScope(tx, viewer, 'c')}
					returning ${itemColumns(tx)}
				`;
				const row = rows[0];
				if (!row) return { ok: false, reason: 'not_found' };

				const remaining = await tx<{ id: string; position: number }[]>`
					select i.id, i.position::int from reading_challenge_items i
					where i.challenge_id = ${current.challengeId}::uuid and i.archived_at is null
					order by i.position asc
				`;
				for (const target of compactPositions(remaining)) {
					await tx`
						update reading_challenge_items set position = ${target.position}::int
						where id = ${target.id}::uuid
					`;
				}
				return { ok: true, record: mapItem(row) };
			}

			const rows = await tx<ReadingChallengeItemRow[]>`
				update reading_challenge_items as i set archived_at = null,
					position = coalesce(
					    (select max(ri.position) from reading_challenge_items ri
					     where ri.challenge_id = i.challenge_id and ri.archived_at is null),
					    0
					) + 1,
					updated_at = now(), updated_by = ${viewer.userId}::uuid
				from reading_challenges c
				where i.id = ${itemId}::uuid and i.challenge_id = c.id
				  and ${writableScope(tx, viewer, 'c')}
				returning ${itemColumns(tx)}
			`;
			const row = rows[0];
			if (!row) return { ok: false, reason: 'not_found' };
			return { ok: true, record: mapItem(row) };
		})
	);
}

/**
 * Fills a prompt with a book, setting `completed_on` to the household's own
 * today -- the same reasoning `books.tbr_added_on` follows (base.ts's
 * `householdToday`; "today" depends on the household's timezone, which a
 * column default cannot see). The book's readability is checked in this same
 * UPDATE (hard rule 9), not in a separate lookup first: a single statement
 * that only matches when both the challenge is writable and the book is
 * readable cannot have one check quietly skipped by a race, and there is
 * nothing written yet for a later failure to have to roll back (unlike
 * `attachNewIngredientToRecipe`'s `AttachFailure`, there is no first write
 * here that a refusal would need to undo).
 */
export function fillChallengeItem(
	sql: Queryable,
	viewer: Viewer,
	itemId: string,
	bookId: string
): Promise<WriteResult<ReadingChallengeItem>> {
	if (!isUuid(itemId) || !isUuid(bookId))
		return Promise.resolve({ ok: false, reason: 'not_found' });

	return guarded<ReadingChallengeItem>(async () => {
		const today = await householdToday(sql, viewer.householdId);

		const rows = await sql<ReadingChallengeItemRow[]>`
			update reading_challenge_items as i
			set book_id = bk.id, completed_on = ${today}::date,
				updated_at = now(), updated_by = ${viewer.userId}::uuid
			from reading_challenges c, books bk
			where i.id = ${itemId}::uuid and i.challenge_id = c.id and ${writableScope(sql, viewer, 'c')}
			  and i.archived_at is null
			  and bk.id = ${bookId}::uuid and ${readableScope(sql, viewer, 'bk')}
			returning ${itemColumns(sql)}
		`;
		const row = rows[0];
		if (!row) {
			return { ok: false, reason: 'not_found', message: 'could not find that prompt or book' };
		}
		return { ok: true, record: mapItem(row) };
	});
}

/** Clears a prompt's book, and its `completed_on` with it -- a date with no
 *  book behind it is not a state this schema can express (migration 0035's
 *  own CHECK). */
export function clearChallengeItem(
	sql: Queryable,
	viewer: Viewer,
	itemId: string
): Promise<WriteResult<ReadingChallengeItem>> {
	if (!isUuid(itemId)) return Promise.resolve({ ok: false, reason: 'not_found' });

	return guarded<ReadingChallengeItem>(async () => {
		const rows = await sql<ReadingChallengeItemRow[]>`
			update reading_challenge_items as i
			set book_id = null, completed_on = null,
				updated_at = now(), updated_by = ${viewer.userId}::uuid
			from reading_challenges c
			where i.id = ${itemId}::uuid and i.challenge_id = c.id and ${writableScope(sql, viewer, 'c')}
			returning ${itemColumns(sql)}
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'not_found' };
		return { ok: true, record: mapItem(row) };
	});
}

export interface ChallengeFillOption {
	id: string;
	title: string;
}

/**
 * Every book the viewer may read, most recently finished (by them) first --
 * the "Fill" picker's own order. Filling a prompt usually follows finishing a
 * book, so the one just closed is the one most likely wanted next; a book
 * never finished sorts after every finished one, oldest-unfinished-title
 * order among themselves.
 */
export async function booksForChallengeFill(
	sql: Queryable,
	viewer: Viewer
): Promise<ChallengeFillOption[]> {
	const rows = await sql<{ id: string; title: string }[]>`
		select b.id, b.title
		from books b
		left join lateral (
			select max(r.finished_on) as last_finished
			from book_reads r
			where r.book_id = b.id and r.reader_user_id = ${viewer.userId}::uuid and r.status = 'finished'
		) f on true
		where ${readableScope(sql, viewer, 'b')} and ${liveScope(sql, 'b')}
		order by f.last_finished desc nulls last, lower(b.title) asc
		limit ${MAX_LIMIT}
	`;
	return rows.map((row) => ({ id: row.id, title: toText(row.title) }));
}

// ─── Reading Insights ───────────────────────────────────────────────────────

export interface FormatCount {
	format: BookFormat | null;
	count: number;
}

export interface CategoryCount {
	category: BookCategory | null;
	count: number;
}

export interface NamedCount {
	id: string;
	name: string;
	count: number;
}

export interface InsightBook {
	id: string;
	title: string;
	pages: number;
}

export interface ReadingInsights {
	year: number;
	finishedCount: number;
	dnfCount: number;
	pagesRead: number;
	pagesUnknownCount: number;
	audiobookHours: number;
	audiobookUnknownCount: number;
	averageRating: number | null;
	/** Index 0 is January. Zero-filled: a month with nothing finished is 0,
	 *  never a missing entry. */
	finishedPerMonth: number[];
	byFormat: FormatCount[];
	byCategory: CategoryCount[];
	topGenres: NamedCount[];
	topAuthors: NamedCount[];
	longestBook: InsightBook | null;
	shortestBook: InsightBook | null;
}

/**
 * The viewer's own finished-or-dnf reads in a year, joined to their books and
 * scoped to what the viewer may read. The shared predicate behind every
 * `readingInsights` query below (hard rule 9: private books the viewer
 * cannot read are never counted, even as a bare number) -- assumes aliases
 * `r` (book_reads) and `b` (books) are in scope, so every caller supplies its
 * own `from book_reads r join books b on b.id = r.book_id`.
 */
function readerReadsInYear(sql: Queryable, viewer: Viewer, year: number): Fragment {
	return sql`
		r.reader_user_id = ${viewer.userId}::uuid
		  and r.status in ('finished', 'dnf')
		  and r.finished_on is not null
		  and extract(year from r.finished_on)::int = ${year}
		  and ${readableScope(sql, viewer, 'b')}
	`;
}

/**
 * The year's reading, all computed fresh (nothing here is stored): finished
 * and DNF counts, pages/audiobook hours with their own "length unknown"
 * counts, average rating, a zero-filled month breakdown, format and category
 * splits, the top five genres and authors by finished count, and the
 * longest/shortest book finished by pages. Every query below scopes to the
 * VIEWER's own reads -- this is "how did MY year go", not the household's.
 */
export async function readingInsights(
	sql: Queryable,
	viewer: Viewer,
	year: number
): Promise<ReadingInsights> {
	const [
		totalsRows,
		monthRows,
		formatRows,
		categoryRows,
		genreRows,
		authorRows,
		longestRows,
		shortestRows
	] = await Promise.all([
		sql<
			{
				finished_count: unknown;
				dnf_count: unknown;
				pages_read: unknown;
				pages_unknown: unknown;
				audiobook_minutes: unknown;
				audiobook_unknown: unknown;
				average_rating: unknown;
			}[]
		>`
				select
					count(*) filter (where r.status = 'finished')::int as finished_count,
					count(*) filter (where r.status = 'dnf')::int as dnf_count,
					-- How a read is measured: by its own format, else the book's,
					-- else as print. A read with no format anywhere used to fall
					-- into neither total NOR either unknown tally, so it simply
					-- vanished from the year's stats.
					coalesce(sum(b.pages) filter (
						where r.status = 'finished' and coalesce(r.format, b.format, 'print') <> 'audiobook'
						  and b.pages is not null
					), 0)::int as pages_read,
					count(*) filter (
						where r.status = 'finished' and coalesce(r.format, b.format, 'print') <> 'audiobook'
						  and b.pages is null
					)::int as pages_unknown,
					coalesce(sum(b.audiobook_minutes) filter (
						where r.status = 'finished' and coalesce(r.format, b.format) = 'audiobook'
						  and b.audiobook_minutes is not null
					), 0)::numeric as audiobook_minutes,
					count(*) filter (
						where r.status = 'finished' and coalesce(r.format, b.format) = 'audiobook'
						  and b.audiobook_minutes is null
					)::int as audiobook_unknown,
					avg(r.rating) filter (where r.status = 'finished' and r.rating is not null) as average_rating
				from book_reads r join books b on b.id = r.book_id
				where ${readerReadsInYear(sql, viewer, year)}
			`,
		sql<{ month: unknown; count: unknown }[]>`
				select extract(month from r.finished_on)::int as month, count(*)::int as count
				from book_reads r join books b on b.id = r.book_id
				where ${readerReadsInYear(sql, viewer, year)} and r.status = 'finished'
				group by month
			`,
		sql<{ format: string | null; count: unknown }[]>`
				select coalesce(r.format, b.format) as format, count(*)::int as count
				from book_reads r join books b on b.id = r.book_id
				where ${readerReadsInYear(sql, viewer, year)} and r.status = 'finished'
				group by 1
				order by count desc, 1 asc nulls last
			`,
		sql<{ category: string | null; count: unknown }[]>`
				select b.category, count(*)::int as count
				from book_reads r join books b on b.id = r.book_id
				where ${readerReadsInYear(sql, viewer, year)} and r.status = 'finished'
				group by b.category
				order by count desc, b.category asc nulls last
			`,
		sql<{ id: string; name: string; count: unknown }[]>`
				select g.id, g.name, count(*)::int as count
				from book_reads r
				join books b on b.id = r.book_id
				join book_genres bg on bg.book_id = b.id
				join genres g on g.id = bg.genre_id
				where ${readerReadsInYear(sql, viewer, year)} and r.status = 'finished'
				group by g.id, g.name
				order by count desc, lower(g.name) asc
				limit 5
			`,
		sql<{ id: string; name: string; count: unknown }[]>`
				select a.id, a.name, count(*)::int as count
				from book_reads r
				join books b on b.id = r.book_id
				join book_authors ba on ba.book_id = b.id
				join authors a on a.id = ba.author_id
				where ${readerReadsInYear(sql, viewer, year)} and r.status = 'finished'
				group by a.id, a.name
				order by count desc, lower(a.name) asc
				limit 5
			`,
		sql<{ id: string; title: string; pages: unknown }[]>`
				select b.id, b.title, b.pages
				from book_reads r join books b on b.id = r.book_id
				where ${readerReadsInYear(sql, viewer, year)} and r.status = 'finished' and b.pages is not null
				order by b.pages desc, lower(b.title) asc
				limit 1
			`,
		sql<{ id: string; title: string; pages: unknown }[]>`
				select b.id, b.title, b.pages
				from book_reads r join books b on b.id = r.book_id
				where ${readerReadsInYear(sql, viewer, year)} and r.status = 'finished' and b.pages is not null
				order by b.pages asc, lower(b.title) asc
				limit 1
			`
	]);

	const totals = totalsRows[0];
	const finishedPerMonth = Array.from({ length: 12 }, (_, index) => {
		const row = monthRows.find((m) => toInt(m.month) === index + 1);
		return row ? toInt(row.count) : 0;
	});
	const audiobookMinutes = toNumberOrNull(totals?.audiobook_minutes) ?? 0;
	const longest = longestRows[0];
	const shortest = shortestRows[0];

	return {
		year,
		finishedCount: toInt(totals?.finished_count ?? 0),
		dnfCount: toInt(totals?.dnf_count ?? 0),
		pagesRead: toInt(totals?.pages_read ?? 0),
		pagesUnknownCount: toInt(totals?.pages_unknown ?? 0),
		audiobookHours: audiobookMinutes / 60,
		audiobookUnknownCount: toInt(totals?.audiobook_unknown ?? 0),
		averageRating: toNumberOrNull(totals?.average_rating ?? null),
		finishedPerMonth,
		byFormat: formatRows.map((row) => ({
			format: (row.format as BookFormat | null) ?? null,
			count: toInt(row.count)
		})),
		byCategory: categoryRows.map((row) => ({
			category: (row.category as BookCategory | null) ?? null,
			count: toInt(row.count)
		})),
		topGenres: genreRows.map((row) => ({
			id: row.id,
			name: toText(row.name),
			count: toInt(row.count)
		})),
		topAuthors: authorRows.map((row) => ({
			id: row.id,
			name: toText(row.name),
			count: toInt(row.count)
		})),
		longestBook: longest
			? { id: longest.id, title: toText(longest.title), pages: toInt(longest.pages) }
			: null,
		shortestBook: shortest
			? { id: shortest.id, title: toText(shortest.title), pages: toInt(shortest.pages) }
			: null
	};
}

/** The years that have any of the viewer's own finished reads, newest first
 *  -- `/reading/insights`'s year picker. */
export async function insightYears(sql: Queryable, viewer: Viewer): Promise<number[]> {
	const rows = await sql<{ year: unknown }[]>`
		select distinct extract(year from r.finished_on)::int as year
		from book_reads r join books b on b.id = r.book_id
		where r.reader_user_id = ${viewer.userId}::uuid and r.status = 'finished'
		  and r.finished_on is not null
		  and ${readableScope(sql, viewer, 'b')}
		order by year desc
	`;
	return rows.map((row) => toInt(row.year));
}
