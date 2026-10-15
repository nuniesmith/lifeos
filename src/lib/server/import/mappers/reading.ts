import {
	archivedAt,
	bool,
	date,
	firstText,
	int,
	linkedPageIds,
	mapper,
	names,
	numeric,
	text,
	withBody,
	type Queryable,
	type StagedRow
} from './shared.ts';

/**
 * Reading Tracker databases -> the reading tables (migrations 0030, 0033,
 * 0035), first imported from the 2026-10-14 export.
 *
 * The tables were built for in-app entry and for the StoryGraph history
 * (storygraph.ts), and until this export Notion's reading databases were
 * empty or a single placeholder, so nothing mapped them. Now they hold the
 * household's books, authors, series, genres, reads and challenges.
 *
 * Order matters and promote.ts enforces it (see IMPORT_ORDER there): a read
 * needs its book's id, and a challenge prompt its challenge's, at insert time,
 * because those columns are NOT NULL; so those two look the related row up
 * here, in the first pass, by the Notion id in the relation cell. Every
 * nullable link -- a book's authors, genres and series -- waits for the second
 * pass like every other relation.
 *
 * Authors, genres and series have no Notion key column; each is unique by
 * name per household (a partial unique index), so they are found-or-created
 * by name, which a re-run finds again.
 */

/** Notion's "Status" on a book -> books.status. */
const BOOK_STATUS: Record<string, string> = {
	read: 'read',
	finished: 'read',
	'currently reading': 'reading',
	reading: 'reading',
	paused: 'paused',
	'on hold': 'paused',
	dnf: 'dnf',
	'did not finish': 'dnf',
	tbr: 'tbr',
	'to read': 'tbr',
	'want to read': 'tbr',
	// Not out yet: the only thing to do with it is want to read it.
	'not released': 'tbr',
	'pre-ordered': 'tbr'
};

/** Notion's "Status" on a reading-log entry -> book_reads.status. */
const READ_STATUS: Record<string, string> = {
	read: 'finished',
	finished: 'finished',
	dnf: 'dnf',
	'did not finish': 'dnf',
	'currently reading': 'reading',
	reading: 'reading',
	paused: 'paused',
	'on hold': 'paused'
};

export function readingFormat(value: string | null): string | null {
	const v = (value ?? '').toLowerCase();
	if (!v) return null;
	if (v.includes('audio')) return 'audiobook';
	if (v.includes('ebook') || v.includes('kindle') || v.includes('e-book')) return 'ebook';
	if (/paper|hard|print|physical/.test(v)) return 'print';
	return null;
}

export function audience(value: string | null): string | null {
	const v = (value ?? '').toLowerCase();
	if (!v) return null;
	if (v.includes('young adult') || v === 'ya') return 'young_adult';
	if (v.includes('middle grade')) return 'middle_grade';
	if (v.includes('child')) return 'children';
	// "Adult" and "New Adult": the schema's four audiences have no separate
	// new-adult band, and new adult is read on the adult shelf.
	if (v.includes('adult')) return 'adult';
	return null;
}

/** A 0-5 rating on the schema's quarter-star grid, or null. */
export function quarterStars(n: number | null): number | null {
	if (n === null || n < 0 || n > 5) return null;
	return Math.round(n * 4) / 4;
}

/** "🌶️🌶️" -> 2. */
export function chilliCount(value: string | null): number | null {
	if (!value) return null;
	const n = [...value.matchAll(/🌶/gu)].length;
	return n > 0 && n <= 5 ? n : null;
}

/** Digits and a trailing X, accepted only in the two shapes the schema allows. */
export function cleanIsbn(value: string | null): string | null {
	const v = (value ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
	return /^[0-9]{9}[0-9X]$|^[0-9]{13}$/.test(v) ? v : null;
}

const positive = (n: number | null): number | null => (n !== null && n > 0 ? n : null);

/**
 * Find-or-create by name, for the three name-keyed reading tables.
 *
 * Only an unarchived row counts, because that is what the unique index
 * covers: an archived "Fantasy" does not stop a live one existing.
 */
async function findOrCreateByName(
	sql: Queryable,
	table: 'authors' | 'genres' | 'book_series',
	householdId: string,
	name: string,
	createdBy: string | null
): Promise<string> {
	const [found] = await sql<{ id: string }[]>`
		select id from ${sql(table)}
		where household_id = ${householdId} and archived_at is null
		  and lower(trim(name)) = lower(trim(${name}))
		limit 1
	`;
	if (found) return found.id;
	const [made] = await sql<{ id: string }[]>`
		insert into ${sql(table)} (household_id, name, created_by)
		values (${householdId}, ${name.trim().slice(0, 200)}, ${createdBy})
		returning id
	`;
	if (!made) throw new Error(`could not create ${table} row "${name}"`);
	return made.id;
}

export const mapAuthor = mapper('authors', async (sql, row, o) => {
	const name = row.title?.trim();
	if (!name) return null;
	const id = await findOrCreateByName(sql, 'authors', o.householdId, name, o.createdBy);
	// Notes only fill a gap: an author's notes written in the app are not
	// overwritten by an export that has none.
	const notes = withBody(row, null);
	if (notes) await sql`update authors set notes = coalesce(notes, ${notes}) where id = ${id}`;
	return id;
});

export const mapGenre = mapper('genres', async (sql, row, o) => {
	const name = row.title?.trim();
	if (!name) return null;
	return findOrCreateByName(sql, 'genres', o.householdId, name.slice(0, 100), o.createdBy);
});

export const mapSeries = mapper('book_series', async (sql, row, o) => {
	const name = row.title?.trim();
	if (!name) return null;
	const id = await findOrCreateByName(sql, 'book_series', o.householdId, name, o.createdBy);
	const planned = positive(int(row, 'Total Planned Books in Series'));
	const notes = withBody(row, 'Notes');
	await sql`
		update book_series
		set planned_count = coalesce(${planned}::integer, planned_count),
		    notes = coalesce(notes, ${notes})
		where id = ${id}
	`;
	return id;
});

/**
 * Book Database -> books.
 *
 * Most of the database's ~110 columns are formulas, rollups and dashboard
 * displays (Picker Score, Report Card, Days to Read, Spent on Unread...) and
 * are recomputed rather than imported. What is kept is what was entered.
 *
 * A book already in the household from the StoryGraph import, which has no
 * Notion id, is adopted rather than duplicated: same ISBN, or failing that the
 * only unclaimed book with the same title.
 */
export const mapBook = mapper('books', async (sql, row, o) => {
	const title = row.title?.trim();
	if (!title || !row.notion_page_id) return null;

	const isbn = cleanIsbn(text(row, 'ISBN'));
	const status = BOOK_STATUS[(text(row, 'Status') ?? '').toLowerCase()] ?? 'tbr';
	const pages =
		positive(int(row, 'eBook Page Count')) ?? positive(int(row, 'Paperback Page Count'));
	const fiction = (text(row, 'Fiction/Non-Fiction') ?? '').toLowerCase();
	const category = fiction.startsWith('non') ? 'nonfiction' : fiction ? 'fiction' : null;
	const pace = (text(row, 'Pace') ?? '').toLowerCase();

	const values = {
		title: title.slice(0, 300),
		status: bool(row, 'On Hold?') && status === 'reading' ? 'paused' : status,
		series_position: positive(numeric(row, 'Series Position')),
		category,
		audience: audience(text(row, 'Audience')),
		format: readingFormat(firstText(row, 'Current Reading Format', 'Format Borrowed')),
		owned: bool(row, 'Owned?'),
		pages,
		isbn,
		release_date: date(row, 'Release Date'),
		rating: quarterStars(numeric(row, 'Rating')),
		favourite: bool(row, 'Favourite?'),
		spice: chilliCount(text(row, 'Spice Rating')),
		pace: ['slow', 'medium', 'fast'].includes(pace) ? pace : null,
		tropes: names(row, 'Tropes'),
		moods: names(row, 'Tone'),
		tags: names(row, 'Book Tags'),
		content_warnings: text(row, 'Content Warnings'),
		description: text(row, 'Description'),
		notes: withBody(row, '1 Sentence Review'),
		storygraph_url: text(row, 'Storygraph Link'),
		archived_at: archivedAt(row)
	};

	// Adopt a StoryGraph-imported copy before creating a second one.
	const [existing] = await sql<{ id: string }[]>`
		select id from books
		where household_id = ${o.householdId} and notion_page_id is null
		  and (
		    (${isbn}::text is not null and isbn = ${isbn})
		    or (lower(trim(title)) = lower(${values.title})
		        and (select count(*) from books b2
		             where b2.household_id = ${o.householdId} and b2.notion_page_id is null
		               and lower(trim(b2.title)) = lower(${values.title})) = 1)
		  )
		order by (isbn = ${isbn}) desc nulls last
		limit 1
	`;
	if (existing) {
		await sql`update books set notion_page_id = ${row.notion_page_id} where id = ${existing.id}`;
	}

	const [r] = await sql<{ id: string }[]>`
		insert into books (household_id, owner_user_id, title, status, series_position, category,
		                   audience, format, owned, pages, isbn, release_date, rating, favourite,
		                   spice, pace, tropes, moods, tags, content_warnings, description, notes,
		                   storygraph_url, notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${values.title}, ${values.status},
		        ${values.series_position}, ${values.category}, ${values.audience}, ${values.format},
		        ${values.owned}, ${values.pages}, ${values.isbn}, ${values.release_date},
		        ${values.rating}, ${values.favourite}, ${values.spice}, ${values.pace},
		        ${values.tropes}::text[], ${values.moods}::text[], ${values.tags}::text[],
		        ${values.content_warnings}, ${values.description}, ${values.notes},
		        ${values.storygraph_url}, ${row.notion_page_id}, ${row.id}, ${o.createdBy},
		        ${values.archived_at}::timestamptz)
		on conflict (notion_page_id) do update set
			title = excluded.title, status = excluded.status,
			series_position = excluded.series_position, category = excluded.category,
			audience = excluded.audience, format = coalesce(excluded.format, books.format),
			owned = excluded.owned, pages = coalesce(excluded.pages, books.pages),
			isbn = coalesce(excluded.isbn, books.isbn),
			release_date = coalesce(excluded.release_date, books.release_date),
			rating = coalesce(excluded.rating, books.rating), favourite = excluded.favourite,
			spice = coalesce(excluded.spice, books.spice), pace = coalesce(excluded.pace, books.pace),
			tropes = case when cardinality(excluded.tropes) > 0 then excluded.tropes else books.tropes end,
			moods = case when cardinality(excluded.moods) > 0 then excluded.moods else books.moods end,
			tags = case when cardinality(excluded.tags) > 0 then excluded.tags else books.tags end,
			content_warnings = coalesce(excluded.content_warnings, books.content_warnings),
			description = coalesce(excluded.description, books.description),
			notes = coalesce(excluded.notes, books.notes),
			storygraph_url = coalesce(excluded.storygraph_url, books.storygraph_url),
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

/** The person a personal log belongs to: the import's --log-as, else its owner. */
const logUser = (o: { logUserId?: string | null; ownerUserId: string | null }) =>
	o.logUserId ?? o.ownerUserId;

async function idByPage(sql: Queryable, table: string, pageIds: string[]): Promise<string | null> {
	if (pageIds.length === 0) return null;
	const [r] = await sql<{ id: string }[]>`
		select id from ${sql(table)} where notion_page_id = any(${pageIds}::uuid[]) limit 1
	`;
	return r?.id ?? null;
}

/**
 * Reading Log Database -> book_reads, one row per read.
 *
 * Each read is somebody's: book_reads.reader_user_id is NOT NULL. The source
 * does not say whose, so it is the import's --log-as user (scripts/import.mjs),
 * or the owner when none is given; with neither there is nobody to log it as
 * and the row is refused rather than guessed.
 */
export const mapRead = mapper('book_reads', async (sql, row, o) => {
	const reader = logUser(o);
	if (!reader || !row.notion_page_id) return null;
	const bookId = await idByPage(sql, 'books', linkedPageIds(row, 'Book'));
	if (!bookId) return null;

	const status = READ_STATUS[(text(row, 'Status') ?? '').toLowerCase()] ?? 'finished';
	const ended = status === 'finished' || status === 'dnf';
	let started = date(row, 'Date Started');
	const finished = ended ? date(row, 'Date Finished') : null;
	if (started && finished && finished < started) started = null;
	const active = status === 'reading' || status === 'paused';

	// One open read per book and reader (an index): an open read started in
	// the app is the same read, and takes this page's key instead of
	// colliding with it.
	if (active) {
		await sql`
			update book_reads set notion_page_id = ${row.notion_page_id}
			where book_id = ${bookId} and reader_user_id = ${reader}
			  and status in ('reading', 'paused') and notion_page_id is null
		`;
	}

	const [r] = await sql<{ id: string }[]>`
		insert into book_reads (book_id, reader_user_id, status, started_on, finished_on, format,
		                        progress_pages, rating, review, dnf_reason, notion_page_id,
		                        created_by)
		values (${bookId}, ${reader}, ${status}, ${started}, ${finished},
		        ${readingFormat(text(row, 'Format Read'))},
		        ${active ? int(row, 'Pages Read') : null},
		        ${quarterStars(numeric(row, 'Rating This Read'))}, ${withBody(row, null)},
		        ${status === 'dnf' ? text(row, 'DNF Reason') : null},
		        ${row.notion_page_id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			book_id = excluded.book_id, status = excluded.status,
			started_on = excluded.started_on, finished_on = excluded.finished_on,
			format = coalesce(excluded.format, book_reads.format),
			progress_pages = excluded.progress_pages,
			rating = coalesce(excluded.rating, book_reads.rating),
			review = coalesce(excluded.review, book_reads.review),
			dnf_reason = excluded.dnf_reason
		returning id
	`;
	return r?.id ?? null;
});

/** "2026 (Time Databases/...)" or a window "January 1, 2026 → ..." -> 2026. */
function challengeYear(row: StagedRow): number | null {
	for (const column of ['Year', 'Challenge Window', 'Created time']) {
		const m = /\b(19|20|21)\d{2}\b/.exec(row.raw[column] ?? '');
		if (m) return Number(m[0]);
	}
	return null;
}

/**
 * Reading Challenges Database -> reading_challenges.
 *
 * "Prompt List" challenges are a list of prompts (kind 'prompts'); anything
 * else with a total is a count goal. A count needs its target (a check), so a
 * challenge with neither style nor total is read as a prompt list, which is
 * what every challenge in the 2026-10-14 export is.
 */
export const mapChallenge = mapper('reading_challenges', async (sql, row, o) => {
	const title = row.title?.trim();
	const year = challengeYear(row);
	if (!title || !year || !row.notion_page_id) return null;
	const style = (text(row, 'Challenge Style') ?? '').toLowerCase();
	const target = positive(int(row, 'Total Items'));
	const kind = style.includes('prompt') || !target ? 'prompts' : 'count';

	const [r] = await sql<{ id: string }[]>`
		insert into reading_challenges (household_id, owner_user_id, title, year, notes, kind,
		                                target_count, notion_page_id, source_record_id,
		                                created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${title.slice(0, 200)}, ${year},
		        ${withBody(row, null)}, ${kind}, ${kind === 'count' ? target : null},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy}, ${archivedAt(row)}::timestamptz)
		on conflict (notion_page_id) do update set
			title = excluded.title, year = excluded.year,
			notes = coalesce(excluded.notes, reading_challenges.notes),
			kind = excluded.kind, target_count = excluded.target_count,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

/**
 * Reading Challenge Items Database -> reading_challenge_items.
 *
 * A prompt is completed by a READ ("Completed with" links the Reading Log),
 * and the schema records the book: so the book is the one that read was of.
 * A completion date is only kept with a book (a check).
 */
export const mapChallengeItem = mapper('reading_challenge_items', async (sql, row, o) => {
	const prompt = row.title?.trim();
	if (!prompt || !row.notion_page_id) return null;
	const challengeId = await idByPage(
		sql,
		'reading_challenges',
		linkedPageIds(row, 'Reading Challenge')
	);
	if (!challengeId) return null;

	const readIds = linkedPageIds(row, 'Completed with');
	const [read] = readIds.length
		? await sql<{ book_id: string }[]>`
				select book_id from book_reads where notion_page_id = any(${readIds}::uuid[]) limit 1
			`
		: [];
	const bookId = read?.book_id ?? null;
	const completedOn = bookId ? date(row, 'Completed Date') : null;

	// Positions are unique per challenge; one the export repeats, or one an
	// in-app prompt already holds, moves to the end instead of failing the
	// whole import.
	const wanted = positive(int(row, 'Position'));
	const [slot] = await sql<{ position: number }[]>`
		select case
		  when ${wanted}::integer is not null and not exists (
		    select 1 from reading_challenge_items
		    where challenge_id = ${challengeId} and position = ${wanted}::integer
		      and archived_at is null and notion_page_id is distinct from ${row.notion_page_id}
		  ) then ${wanted}::integer
		  else coalesce((select max(position) from reading_challenge_items
		                 where challenge_id = ${challengeId}), 0) + 1
		end as position
	`;

	const [r] = await sql<{ id: string }[]>`
		insert into reading_challenge_items (challenge_id, position, prompt, book_id, completed_on,
		                                     notion_page_id, created_by)
		values (${challengeId}, ${slot?.position ?? 1}, ${prompt.slice(0, 500)}, ${bookId}, ${completedOn},
		        ${row.notion_page_id}, ${o.createdBy})
		on conflict (notion_page_id) do update set
			challenge_id = excluded.challenge_id, position = excluded.position,
			prompt = excluded.prompt, book_id = excluded.book_id,
			completed_on = excluded.completed_on
		returning id
	`;
	return r?.id ?? null;
});
