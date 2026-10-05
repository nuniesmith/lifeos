import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addChallengeItem,
	booksForChallengeFill,
	clearChallengeItem,
	countChallengeBooks,
	createBook,
	createGenre,
	createReadingChallenge,
	fillChallengeItem,
	getReadingChallenge,
	insightYears,
	listChallengeItems,
	listReadingChallenges,
	moveChallengeItem,
	readingInsights,
	setChallengeItemArchived,
	setReadingChallengeArchived,
	updateChallengeItem,
	updateReadingChallenge,
	type Book
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Reading challenges, their prompts, and Reading Insights (Reading Tracker R3;
 * migration 0035).
 *
 * All test data is invented: obviously fictional titles, never anything read
 * from `data/`, which holds the household's real Notion export (hard rule 1).
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	owner = viewerOf(
		{
			id: admin.id,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		householdId
	);
	const created = await createMember(sql, admin.id, householdId, {
		username: 'partner',
		displayName: 'Partner',
		role: 'member'
	});
	if (!created.ok) throw new Error('could not create the member');
	partner = viewerOf(
		{
			id: created.userId,
			username: 'partner',
			displayName: 'Partner',
			role: 'member',
			mustChangeCredentials: true,
			isBootstrap: false
		},
		householdId
	);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what: string) => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

async function addBook(
	viewer: Viewer,
	title: string,
	extra: Record<string, unknown> = {}
): Promise<Book> {
	return ok(await createBook(sql, viewer, { title, ...extra }), `add "${title}"`).record;
}

/** Inserted directly rather than through `startRead`/`finishRead` (reading-
 *  log.ts): those default `finished_on` to the household's own today and
 *  refuse a second active read, and these tests need exact, varied dates
 *  across months and years, which only a direct insert can give cheaply. */
async function addRead(
	viewer: Viewer,
	bookId: string,
	overrides: Partial<{
		status: string;
		finishedOn: string | null;
		format: string | null;
		rating: number | null;
	}> = {}
): Promise<string> {
	const status = overrides.status ?? 'finished';
	const finishedOn = overrides.finishedOn === undefined ? '2026-06-15' : overrides.finishedOn;
	const format = overrides.format ?? null;
	const rating = overrides.rating ?? null;
	const rows = await sql<{ id: string }[]>`
		insert into book_reads (
			book_id, reader_user_id, status, finished_on, format, rating, created_by, updated_by
		) values (
			${bookId}::uuid, ${viewer.userId}::uuid, ${status}, ${finishedOn}::date, ${format}, ${rating},
			${viewer.userId}::uuid, ${viewer.userId}::uuid
		)
		returning id
	`;
	return rows[0]!.id;
}

async function addChallenge(viewer: Viewer, title: string, extra: Record<string, unknown> = {}) {
	return ok(
		await createReadingChallenge(sql, viewer, {
			title,
			year: 2026,
			kind: 'count',
			targetCount: 10,
			...extra
		}),
		`add "${title}"`
	).record;
}

describe('creating a challenge', () => {
	it('creates a count challenge with a target', async () => {
		const challenge = ok(
			await createReadingChallenge(sql, owner, {
				title: 'R3 Fictional Reading Goal',
				year: 2026,
				kind: 'count',
				targetCount: 30
			}),
			'create'
		).record;
		expect(challenge).toMatchObject({
			title: 'R3 Fictional Reading Goal',
			year: 2026,
			kind: 'count',
			targetCount: 30,
			ownerUserId: owner.userId,
			visibility: 'household'
		});
	});

	it('creates a prompts challenge with no target', async () => {
		const challenge = ok(
			await createReadingChallenge(sql, owner, {
				title: 'R3 Fictional Prompt Sheet',
				year: 2026,
				kind: 'prompts'
			}),
			'create'
		).record;
		expect(challenge.targetCount).toBeNull();
	});

	it('refuses a count challenge with no target', async () => {
		const result = await createReadingChallenge(sql, owner, {
			title: 'R3 No Target',
			year: 2026,
			kind: 'count'
		});
		expect(result).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('drops the count-only filters from a prompts challenge rather than erroring', async () => {
		const genre = ok(await createGenre(sql, owner, { name: 'R3 Fictional Genre' }), 'genre').record;
		const challenge = ok(
			await createReadingChallenge(sql, owner, {
				title: 'R3 Prompts With Stray Filters',
				year: 2026,
				kind: 'prompts',
				category: 'fiction',
				format: 'ebook',
				genreId: genre.id,
				targetCount: 5
			}),
			'create'
		).record;
		expect(challenge).toMatchObject({
			kind: 'prompts',
			targetCount: null,
			category: null,
			format: null,
			genreId: null
		});
	});

	it('rejects a year outside 1900-2200', async () => {
		const result = await createReadingChallenge(sql, owner, {
			title: 'R3 Bad Year',
			year: 3000,
			kind: 'count',
			targetCount: 5
		});
		expect(result).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

describe('updating a challenge', () => {
	it('patches only the fields sent', async () => {
		const challenge = await addChallenge(owner, 'R3 Patch Me');
		const updated = ok(
			await updateReadingChallenge(
				sql,
				owner,
				challenge.id,
				{ targetCount: 42 },
				challenge.updatedAt
			),
			'update'
		).record;
		expect(updated).toMatchObject({ title: 'R3 Patch Me', targetCount: 42 });
	});

	it('conflicts a stale edit (optimistic concurrency)', async () => {
		const challenge = await addChallenge(owner, 'R3 Stale Edit');
		ok(
			await updateReadingChallenge(
				sql,
				owner,
				challenge.id,
				{ targetCount: 20 },
				challenge.updatedAt
			),
			'first edit, with the original version'
		);

		const stale = await updateReadingChallenge(
			sql,
			owner,
			challenge.id,
			{ targetCount: 25 },
			challenge.updatedAt
		);
		expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('refuses an edit from someone other than the owner', async () => {
		const challenge = await addChallenge(owner, 'R3 Owner Only');
		const result = await updateReadingChallenge(sql, partner, challenge.id, { targetCount: 5 });
		expect(result).toMatchObject({ ok: false, reason: 'forbidden' });
	});
});

describe('archiving and restoring a challenge', () => {
	it('archives and restores, and it disappears from and returns to the live list', async () => {
		const challenge = await addChallenge(owner, 'R3 Archive Me');
		ok(await setReadingChallengeArchived(sql, owner, challenge.id, true), 'archive');

		const afterArchive = await listReadingChallenges(sql, owner);
		expect(afterArchive.map((c) => c.id)).not.toContain(challenge.id);

		ok(await setReadingChallengeArchived(sql, owner, challenge.id, false), 'restore');
		const afterRestore = await listReadingChallenges(sql, owner);
		expect(afterRestore.map((c) => c.id)).toContain(challenge.id);
	});
});

describe('privacy', () => {
	it('is a 404 for another member’s private challenge', async () => {
		const theirs = ok(
			await createReadingChallenge(sql, partner, {
				title: 'R3 Private Challenge',
				year: 2026,
				kind: 'count',
				targetCount: 5,
				visibility: 'private',
				ownerUserId: partner.userId
			}),
			'create private'
		).record;

		expect(await getReadingChallenge(sql, owner, theirs.id)).toBeNull();
		expect(await listReadingChallenges(sql, owner)).toEqual([]);
		expect(await updateReadingChallenge(sql, owner, theirs.id, { targetCount: 1 })).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});
});

describe('count challenge progress', () => {
	it('counts only the finished books in the challenge’s own year', async () => {
		const book2025 = await addBook(owner, 'R3 Finished In 2025');
		const book2026 = await addBook(owner, 'R3 Finished In 2026');
		const bookNextYear = await addBook(owner, 'R3 Finished In 2027');
		await addRead(owner, book2025.id, { finishedOn: '2025-12-31' });
		await addRead(owner, book2026.id, { finishedOn: '2026-01-01' });
		await addRead(owner, bookNextYear.id, { finishedOn: '2027-01-01' });

		const challenge = await addChallenge(owner, 'R3 Year Boundary', {
			year: 2026,
			targetCount: 10
		});
		const books = await countChallengeBooks(sql, owner, challenge);
		expect(books.map((b) => b.title)).toEqual(['R3 Finished In 2026']);
		expect(books[0]?.finishedPrecision).toBe('day');
	});

	it('carries a year-only finish date’s precision, so the page can show just the year', async () => {
		const book = await addBook(owner, 'R3 Read Sometime In 2026');
		const readId = await addRead(owner, book.id, { finishedOn: '2026-01-01' });
		await sql`update book_reads set finished_precision = 'year' where id = ${readId}::uuid`;

		const challenge = await addChallenge(owner, 'R3 Year Only Count', {
			year: 2026,
			targetCount: 5
		});
		const books = await countChallengeBooks(sql, owner, challenge);
		expect(books).toEqual([
			expect.objectContaining({ finishedOn: '2026-01-01', finishedPrecision: 'year' })
		]);
	});

	it('narrows by category, format and genre together', async () => {
		const genre = ok(await createGenre(sql, owner, { name: 'R3 Cozy Mystery' }), 'genre').record;
		const match = await addBook(owner, 'R3 Matching Book', {
			category: 'fiction',
			format: 'ebook',
			genreNames: 'R3 Cozy Mystery'
		});
		const wrongCategory = await addBook(owner, 'R3 Wrong Category', {
			category: 'nonfiction',
			format: 'ebook',
			genreNames: 'R3 Cozy Mystery'
		});
		const wrongFormat = await addBook(owner, 'R3 Wrong Format', {
			category: 'fiction',
			format: 'print',
			genreNames: 'R3 Cozy Mystery'
		});
		const wrongGenre = await addBook(owner, 'R3 Wrong Genre', {
			category: 'fiction',
			format: 'ebook'
		});
		for (const book of [match, wrongCategory, wrongFormat, wrongGenre]) {
			await addRead(owner, book.id, { finishedOn: '2026-03-01' });
		}

		const challenge = await addChallenge(owner, 'R3 Narrowed Challenge', {
			year: 2026,
			targetCount: 5,
			category: 'fiction',
			format: 'ebook',
			genreId: genre.id
		});
		const books = await countChallengeBooks(sql, owner, challenge);
		expect(books.map((b) => b.title)).toEqual(['R3 Matching Book']);
	});

	it('counts a read by how it was read, not by the book’s catalogue format', async () => {
		// A print-catalogued book listened to as an audiobook counts toward an
		// audiobook challenge, and an audiobook read in print does not.
		const listened = await addBook(owner, 'R3 Listened To', { format: 'print' });
		const readInPrint = await addBook(owner, 'R3 Read In Print', { format: 'audiobook' });
		const unrecorded = await addBook(owner, 'R3 Format From The Book', { format: 'audiobook' });
		await addRead(owner, listened.id, { finishedOn: '2026-05-01', format: 'audiobook' });
		await addRead(owner, readInPrint.id, { finishedOn: '2026-05-02', format: 'print' });
		await addRead(owner, unrecorded.id, { finishedOn: '2026-05-03' }); // no read format

		const challenge = await addChallenge(owner, 'R3 Audiobook Year', {
			year: 2026,
			targetCount: 12,
			format: 'audiobook'
		});
		const books = await countChallengeBooks(sql, owner, challenge);
		expect(books.map((b) => b.title).sort()).toEqual(['R3 Format From The Book', 'R3 Listened To']);
		const found = (await listReadingChallenges(sql, owner)).find((c) => c.id === challenge.id);
		expect(found?.progress).toEqual({ done: 2, total: 12 });
	});

	it('never counts another member’s reads, even of the same book', async () => {
		const book = await addBook(owner, 'R3 Shared Book');
		await addRead(owner, book.id, { finishedOn: '2026-04-01' });
		await addRead(partner, book.id, { finishedOn: '2026-04-02' });
		await addRead(partner, book.id, { finishedOn: '2026-04-03' });

		const challenge = await addChallenge(owner, 'R3 Only Mine', { year: 2026, targetCount: 10 });
		const books = await countChallengeBooks(sql, owner, challenge);
		expect(books).toHaveLength(1);

		const list = await listReadingChallenges(sql, owner);
		const found = list.find((c) => c.id === challenge.id);
		expect(found?.progress).toEqual({ done: 1, total: 10 });
	});

	it('shows in the list with done/total for count and filled/total for prompts', async () => {
		const book = await addBook(owner, 'R3 Listed Progress Book');
		await addRead(owner, book.id, { finishedOn: '2026-05-01' });
		const countChallenge = await addChallenge(owner, 'R3 Listed Count', {
			year: 2026,
			targetCount: 4
		});
		const promptsChallenge = await addChallenge(owner, 'R3 Listed Prompts', {
			year: 2026,
			kind: 'prompts'
		});
		const item = ok(
			await addChallengeItem(sql, owner, promptsChallenge.id, { prompt: 'R3 A book with a map' }),
			'add item'
		).record;
		ok(await fillChallengeItem(sql, owner, item.id, book.id), 'fill item');
		await addChallengeItem(sql, owner, promptsChallenge.id, {
			prompt: 'R3 Another unfilled prompt'
		});

		const list = await listReadingChallenges(sql, owner);
		const count = list.find((c) => c.id === countChallenge.id);
		const prompts = list.find((c) => c.id === promptsChallenge.id);
		expect(count?.progress).toEqual({ done: 1, total: 4 });
		expect(prompts?.progress).toEqual({ done: 1, total: 2 });
	});
});

describe('prompts and their items', () => {
	it('adds items appended in order', async () => {
		const challenge = await addChallenge(owner, 'R3 Item Order', {
			kind: 'prompts',
			targetCount: undefined
		});
		const first = ok(
			await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 First prompt' }),
			'add first'
		).record;
		const second = ok(
			await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 Second prompt' }),
			'add second'
		).record;
		expect(first.position).toBe(1);
		expect(second.position).toBe(2);

		const items = await listChallengeItems(sql, owner, challenge.id);
		expect(items.map((i) => i.prompt)).toEqual(['R3 First prompt', 'R3 Second prompt']);
	});

	it('updates a prompt’s text', async () => {
		const challenge = await addChallenge(owner, 'R3 Item Edit', { kind: 'prompts' });
		const item = ok(
			await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 Original prompt' }),
			'add'
		).record;
		const updated = ok(
			await updateChallengeItem(sql, owner, item.id, { prompt: 'R3 Edited prompt' }),
			'update'
		).record;
		expect(updated.prompt).toBe('R3 Edited prompt');
	});

	it('reorders with up/down, keeping positions unique', async () => {
		const challenge = await addChallenge(owner, 'R3 Reorder', { kind: 'prompts' });
		const a = ok(await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 A' }), 'a').record;
		const b = ok(await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 B' }), 'b').record;
		const c = ok(await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 C' }), 'c').record;
		expect([a.position, b.position, c.position]).toEqual([1, 2, 3]);

		const moved = ok(await moveChallengeItem(sql, owner, b.id, 'up'), 'move b up').record;
		expect(moved.position).toBe(1);

		const items = await listChallengeItems(sql, owner, challenge.id);
		expect(items.map((i) => i.prompt)).toEqual(['R3 B', 'R3 A', 'R3 C']);
		const positions = items.map((i) => i.position);
		expect(new Set(positions).size).toBe(positions.length);

		// Already first: moving up again is a no-op success, not an error.
		const noop = ok(await moveChallengeItem(sql, owner, b.id, 'up'), 'move b up again').record;
		expect(noop.position).toBe(1);
	});

	it('compacts positions on archive and appends on restore', async () => {
		const challenge = await addChallenge(owner, 'R3 Compact', { kind: 'prompts' });
		const a = ok(await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 A' }), 'a').record;
		const b = ok(await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 B' }), 'b').record;
		const c = ok(await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 C' }), 'c').record;

		ok(await setChallengeItemArchived(sql, owner, b.id, true), 'archive b');
		const live = await listChallengeItems(sql, owner, challenge.id);
		expect(live.map((i) => i.prompt)).toEqual(['R3 A', 'R3 C']);
		expect(live.map((i) => i.position)).toEqual([1, 2]);

		const restored = ok(
			await setChallengeItemArchived(sql, owner, b.id, false),
			'restore b'
		).record;
		// Appended at the end, not back into its old slot (migration 0035's own
		// header: the slot may already belong to a different item).
		expect(restored.position).toBe(3);
		const allLive = await listChallengeItems(sql, owner, challenge.id);
		expect(allLive.map((i) => i.prompt)).toEqual(['R3 A', 'R3 C', 'R3 B']);
		const positions = allLive.map((i) => i.position);
		expect(new Set(positions).size).toBe(positions.length);
		void a;
		void c;
	});

	it('fills a prompt with a readable book, setting completed_on to today', async () => {
		const challenge = await addChallenge(owner, 'R3 Fill Me', { kind: 'prompts' });
		const item = ok(
			await addChallengeItem(sql, owner, challenge.id, {
				prompt: 'R3 A book you picked up on a whim'
			}),
			'add'
		).record;
		const book = await addBook(owner, 'R3 Whim Book');

		const filled = ok(await fillChallengeItem(sql, owner, item.id, book.id), 'fill').record;
		expect(filled.bookId).toBe(book.id);
		expect(filled.completedOn).not.toBeNull();

		const items = await listChallengeItems(sql, owner, challenge.id);
		expect(items[0]).toMatchObject({ bookId: book.id, bookTitle: 'R3 Whim Book' });
	});

	it('clearing a filled prompt also clears completed_on', async () => {
		const challenge = await addChallenge(owner, 'R3 Clear Me', { kind: 'prompts' });
		const item = ok(
			await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 Clear this one' }),
			'add'
		).record;
		const book = await addBook(owner, 'R3 Clearable Book');
		ok(await fillChallengeItem(sql, owner, item.id, book.id), 'fill');

		const cleared = ok(await clearChallengeItem(sql, owner, item.id), 'clear').record;
		expect(cleared.bookId).toBeNull();
		expect(cleared.completedOn).toBeNull();
	});

	it('refuses to fill a prompt with a book the writer cannot read', async () => {
		const challenge = await addChallenge(owner, 'R3 Refuse Private Book', { kind: 'prompts' });
		const item = ok(
			await addChallengeItem(sql, owner, challenge.id, { prompt: 'R3 Needs a private book' }),
			'add'
		).record;
		const privateBook = await addBook(partner, 'R3 Partner Private Book', {
			visibility: 'private',
			ownerUserId: partner.userId
		});

		const result = await fillChallengeItem(sql, owner, item.id, privateBook.id);
		expect(result).toMatchObject({ ok: false, reason: 'not_found' });

		const items = await listChallengeItems(sql, owner, challenge.id);
		expect(items[0]?.bookId).toBeNull();
	});

	it('lists readable books for the fill picker, most recently finished first', async () => {
		const older = await addBook(owner, 'R3 Finished Long Ago');
		const newer = await addBook(owner, 'R3 Finished Recently');
		await addBook(owner, 'R3 Never Finished');
		await addRead(owner, older.id, { finishedOn: '2020-01-01' });
		await addRead(owner, newer.id, { finishedOn: '2026-08-01' });

		const options = await booksForChallengeFill(sql, owner);
		const titles = options.map((o) => o.title);
		expect(titles.indexOf('R3 Finished Recently')).toBeLessThan(
			titles.indexOf('R3 Finished Long Ago')
		);
		expect(titles.indexOf('R3 Finished Long Ago')).toBeLessThan(
			titles.indexOf('R3 Never Finished')
		);
	});
});

describe('reading insights', () => {
	it('totals finished/DNF, pages, audiobook hours, and their unknown-length counts', async () => {
		const printKnown = await addBook(owner, 'R3 Print Known Pages', { pages: 320 });
		const printUnknown = await addBook(owner, 'R3 Print Unknown Pages');
		const audioKnown = await addBook(owner, 'R3 Audio Known Minutes', { audiobookMinutes: 600 });
		const audioUnknown = await addBook(owner, 'R3 Audio Unknown Minutes');
		const dnfBook = await addBook(owner, 'R3 Abandoned Book');

		await addRead(owner, printKnown.id, { format: 'print', rating: 4, finishedOn: '2026-02-10' });
		await addRead(owner, printUnknown.id, { format: 'ebook', finishedOn: '2026-02-11' });
		await addRead(owner, audioKnown.id, {
			format: 'audiobook',
			rating: 5,
			finishedOn: '2026-02-12'
		});
		await addRead(owner, audioUnknown.id, { format: 'audiobook', finishedOn: '2026-02-13' });
		await addRead(owner, dnfBook.id, { status: 'dnf', finishedOn: '2026-02-14' });

		const insights = await readingInsights(sql, owner, 2026);
		expect(insights.finishedCount).toBe(4);
		expect(insights.dnfCount).toBe(1);
		expect(insights.pagesRead).toBe(320);
		expect(insights.pagesUnknownCount).toBe(1);
		expect(insights.audiobookHours).toBe(10);
		expect(insights.audiobookUnknownCount).toBe(1);
		expect(insights.averageRating).toBe(4.5);
	});

	it('never drops a read whose format was not recorded', async () => {
		// No format on the read: measured by the book's format if it has one,
		// else as print. Before, such a read landed in neither total and
		// neither unknown tally, and vanished from the year.
		const noFormatAnywhere = await addBook(owner, 'R3 No Format Anywhere');
		const audioByBook = await addBook(owner, 'R3 Audio By The Book', {
			format: 'audiobook',
			audiobookMinutes: 120
		});
		await addRead(owner, noFormatAnywhere.id, { finishedOn: '2026-03-10' });
		await addRead(owner, audioByBook.id, { finishedOn: '2026-03-11' });

		const insights = await readingInsights(sql, owner, 2026);
		expect(insights.finishedCount).toBe(2);
		expect(insights.pagesUnknownCount).toBe(1);
		expect(insights.audiobookHours).toBe(2);
	});

	it('is all zero for a year with no reads', async () => {
		await addBook(owner, 'R3 Untouched Book');
		const insights = await readingInsights(sql, owner, 2019);
		expect(insights).toMatchObject({
			finishedCount: 0,
			dnfCount: 0,
			pagesRead: 0,
			pagesUnknownCount: 0,
			audiobookHours: 0,
			audiobookUnknownCount: 0,
			averageRating: null,
			topGenres: [],
			topAuthors: [],
			longestBook: null,
			shortestBook: null
		});
		expect(insights.finishedPerMonth).toEqual(new Array(12).fill(0));
	});

	it('buckets finished reads per month, zero-filled', async () => {
		const jan = await addBook(owner, 'R3 January Book');
		const jul = await addBook(owner, 'R3 July Book');
		await addRead(owner, jan.id, { finishedOn: '2026-01-15' });
		await addRead(owner, jul.id, { finishedOn: '2026-07-04' });

		const insights = await readingInsights(sql, owner, 2026);
		const expected = new Array(12).fill(0);
		expected[0] = 1;
		expected[6] = 1;
		expect(insights.finishedPerMonth).toEqual(expected);
		expect(insights.finishedMonthUnknown).toBe(0);
	});

	it('counts a finish known only to the year in the year, but in no month', async () => {
		// An imported StoryGraph "2026" is stored as 1 January (migration 0037);
		// charting it there would pile every such read into January.
		const known = await addBook(owner, 'R3 Known Month Book');
		const yearOnly = await addBook(owner, 'R3 Year Only Book');
		await addRead(owner, known.id, { finishedOn: '2026-03-10' });
		const readId = await addRead(owner, yearOnly.id, { finishedOn: '2026-01-01' });
		await sql`update book_reads set finished_precision = 'year' where id = ${readId}::uuid`;

		const insights = await readingInsights(sql, owner, 2026);
		expect(insights.finishedCount).toBe(2);
		expect(insights.finishedMonthUnknown).toBe(1);
		const expected = new Array(12).fill(0);
		expected[2] = 1;
		expect(insights.finishedPerMonth).toEqual(expected);
	});

	it('ranks the top genres and authors by finished count', async () => {
		const a = await addBook(owner, 'R3 Genre Author A', {
			genreNames: 'R3 Insight Fantasy',
			authorNames: 'R3 Prolific Author'
		});
		const b = await addBook(owner, 'R3 Genre Author B', {
			genreNames: 'R3 Insight Fantasy',
			authorNames: 'R3 Prolific Author'
		});
		const c = await addBook(owner, 'R3 Genre Author C', {
			genreNames: 'R3 Insight Horror',
			authorNames: 'R3 One-Off Author'
		});
		await addRead(owner, a.id, { finishedOn: '2026-03-01' });
		await addRead(owner, b.id, { finishedOn: '2026-03-02' });
		await addRead(owner, c.id, { finishedOn: '2026-03-03' });

		const insights = await readingInsights(sql, owner, 2026);
		expect(insights.topGenres[0]).toMatchObject({ name: 'R3 Insight Fantasy', count: 2 });
		expect(insights.topAuthors[0]).toMatchObject({ name: 'R3 Prolific Author', count: 2 });
	});

	it('finds the longest and shortest book finished by pages', async () => {
		const long = await addBook(owner, 'R3 Longest Book', { pages: 900 });
		const short = await addBook(owner, 'R3 Shortest Book', { pages: 80 });
		const middle = await addBook(owner, 'R3 Middle Book', { pages: 300 });
		await addRead(owner, long.id, { finishedOn: '2026-04-01' });
		await addRead(owner, short.id, { finishedOn: '2026-04-02' });
		await addRead(owner, middle.id, { finishedOn: '2026-04-03' });

		const insights = await readingInsights(sql, owner, 2026);
		expect(insights.longestBook?.title).toBe('R3 Longest Book');
		expect(insights.shortestBook?.title).toBe('R3 Shortest Book');
	});

	it('breaks down by format and by category', async () => {
		const ebook = await addBook(owner, 'R3 Format Ebook', { category: 'fiction' });
		const print = await addBook(owner, 'R3 Format Print', { category: 'nonfiction' });
		await addRead(owner, ebook.id, { format: 'ebook', finishedOn: '2026-05-01' });
		await addRead(owner, print.id, { format: 'print', finishedOn: '2026-05-02' });

		const insights = await readingInsights(sql, owner, 2026);
		expect(insights.byFormat).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ format: 'ebook', count: 1 }),
				expect.objectContaining({ format: 'print', count: 1 })
			])
		);
		expect(insights.byCategory).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ category: 'fiction', count: 1 }),
				expect.objectContaining({ category: 'nonfiction', count: 1 })
			])
		);
	});

	it('never counts a private book the viewer cannot read, nor another member’s reads', async () => {
		const ownBook = await addBook(owner, 'R3 Own Insight Book');
		await addRead(owner, ownBook.id, { finishedOn: '2026-06-01' });
		const partnerBook = await addBook(partner, 'R3 Partner Insight Book', {
			visibility: 'private',
			ownerUserId: partner.userId
		});
		await addRead(partner, partnerBook.id, { finishedOn: '2026-06-02' });

		const ownerInsights = await readingInsights(sql, owner, 2026);
		expect(ownerInsights.finishedCount).toBe(1);
	});

	it('lists the years with any finished read, newest first', async () => {
		const bookA = await addBook(owner, 'R3 Insight Year A');
		const bookB = await addBook(owner, 'R3 Insight Year B');
		await addRead(owner, bookA.id, { finishedOn: '2024-05-01' });
		await addRead(owner, bookB.id, { finishedOn: '2026-05-01' });

		const years = await insightYears(sql, owner);
		expect(years).toEqual([2026, 2024]);
	});
});

describe('through a client configured the way the app’s is', () => {
	// `$lib/server/db` also hands its client to drizzle(), which replaces the
	// driver's timestamp serializers with pass-throughs — a JS Date sent as a
	// parameter then reaches the wire unconverted and throws. See the same
	// block at the end of health-measurements.test.ts and reading-log.test.ts
	// for how this caught a production failure that every test against a
	// plain client missed (hard rule 2).
	it('creates, fills, clears and archives through the app-like client', async () => {
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const book = await ok(
				await createBook(appLike, owner, { title: 'R3 App-Like Client Book' }),
				'create book through the app-like client'
			).record;
			const challenge = ok(
				await createReadingChallenge(appLike, owner, {
					title: 'R3 App-Like Client Challenge',
					year: 2026,
					kind: 'prompts'
				}),
				'create challenge through the app-like client'
			).record;
			const item = ok(
				await addChallengeItem(appLike, owner, challenge.id, { prompt: 'R3 App-like prompt' }),
				'add item through the app-like client'
			).record;
			const filled = ok(
				await fillChallengeItem(appLike, owner, item.id, book.id),
				'fill through the app-like client'
			).record;
			expect(filled.completedOn).not.toBeNull();

			const cleared = ok(
				await clearChallengeItem(appLike, owner, item.id),
				'clear through the app-like client'
			).record;
			expect(cleared.completedOn).toBeNull();

			const archived = ok(
				await setReadingChallengeArchived(appLike, owner, challenge.id, true),
				'archive through the app-like client'
			).record;
			expect(archived.archivedAt).not.toBeNull();
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
