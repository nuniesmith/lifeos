import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { one } from '$lib/server/db/scalar';
import { importStorygraph, type StorygraphImportSummary } from '$lib/server/import/storygraph';

/**
 * The StoryGraph importer's database half (Reading Tracker R3b; migration
 * 0037). The CLI (scripts/import-storygraph.mjs) is deliberately thin and
 * is not re-tested here -- it only resolves --user/--household and calls
 * `importStorygraph`, the same split `scripts/import.mjs` already uses
 * around `runImport`.
 *
 * The fixture is entirely invented (tests/unit/import-storygraph.test.ts's
 * header has the full rationale); this file never reads from `data/`,
 * which holds the household's real export (hard rule 1).
 */

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/storygraph-sample.csv');

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let householdId: string;
let operatorId: string;
let partnerId: string;
let csvText: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	operatorId = one(await sql<{ id: string }[]>`select id from users limit 1`).id;
	const created = await createMember(sql, operatorId, householdId, {
		username: 'kayla',
		displayName: 'Kayla',
		role: 'member'
	});
	if (!created.ok) throw new Error('could not create the partner');
	partnerId = created.userId;
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const run = (dryRun: boolean) =>
	importStorygraph(sql, csvText, {
		householdId,
		userId: operatorId,
		dryRun
	});

const booksByStorygraphId = async (id: string) =>
	one(
		await sql<
			{
				title: string;
				status: string;
				format: string | null;
				owned: boolean;
				isbn: string | null;
				rating: string | null;
				pace: string | null;
				moods: string[];
				tags: string[];
				content_warnings: string | null;
				tbr_added_on: string | null;
				owner_user_id: string;
				visibility: string;
			}[]
		>`
			select title, status, format, owned, isbn, rating::text as rating, pace, moods, tags,
			       content_warnings, tbr_added_on::text as tbr_added_on,
			       owner_user_id::text as owner_user_id, visibility
			from books where household_id = ${householdId}::uuid and storygraph_id = ${id}
		`,
		`book ${id}`
	);

const readsFor = (storygraphId: string) =>
	sql<
		{
			status: string;
			started_on: string | null;
			finished_on: string | null;
			rating: string | null;
			review: string | null;
			reader_user_id: string;
		}[]
	>`
		select r.status, r.started_on::text as started_on, r.finished_on::text as finished_on,
		       r.rating::text as rating, r.review, r.reader_user_id::text as reader_user_id
		from book_reads r join books b on b.id = r.book_id
		where b.household_id = ${householdId}::uuid and b.storygraph_id = ${storygraphId}
		order by r.started_on asc nulls first, r.finished_on asc nulls first
	`;

describe('importing the fixture for the operator', () => {
	beforeEach(async () => {
		csvText = await readFile(FIXTURE_PATH, 'utf8');
	});

	it('reports the counts the fixture implies', async () => {
		const summary = await run(false);
		expect(summary).toMatchObject<Partial<StorygraphImportSummary>>({
			dryRun: false,
			rowsRead: 8,
			booksCreated: 8,
			booksSkipped: 0,
			booksFailed: 0,
			authorsCreated: 7,
			readsByStatus: { finished: 4, reading: 1, paused: 1, dnf: 1 }
		});
		// Row-level warnings: the three UIDs that are not valid ISBNs (rows
		// 2, 4, 5) and the one reversed range (row 7) -- see the fixture's
		// own build script / the unit tests for why each one fires.
		expect(summary.warnings).toHaveLength(4);
		for (const w of summary.warnings) {
			expect(Object.keys(w).sort()).toEqual(['field', 'message', 'row']);
		}
	});

	it('creates the books and reads exactly as the fixture implies', async () => {
		await run(false);

		const sample = await booksByStorygraphId('9780000000001');
		expect(sample).toMatchObject({
			title: 'The Sample Saga',
			status: 'read',
			format: 'ebook',
			owned: true,
			isbn: '9780000000001',
			pace: 'medium',
			moods: ['hopeful', 'adventurous'],
			tags: ['found-family', 'slow-burn'],
			content_warnings: 'Violence\n\nSome battle scenes.',
			tbr_added_on: '2023-12-01',
			owner_user_id: operatorId,
			visibility: 'household'
		});
		expect(Number(sample.rating)).toBe(4.25);
		expect(await readsFor('9780000000001')).toEqual([
			{
				status: 'finished',
				started_on: '2024-01-05',
				finished_on: '2024-01-20',
				rating: '4.25',
				review: 'A fun start.',
				reader_user_id: operatorId
			}
		]);

		// The reread: two finished reads, oldest first, rating/review on the
		// most recent one only.
		const reread = await readsFor('9780000000002');
		expect(reread).toHaveLength(2);
		expect(reread[0]).toMatchObject({
			started_on: '2019-05-01',
			finished_on: '2019-05-10',
			rating: null,
			review: null
		});
		expect(reread[1]).toMatchObject({
			started_on: '2024-02-01',
			finished_on: '2024-02-20',
			review: 'Even better the second time.'
		});
		expect(Number(reread[1]?.rating)).toBe(5);

		// The reversed range: the book exists and keeps its own rating, but
		// no read was built from the one range it had.
		const reversed = await booksByStorygraphId('9780000000003');
		expect(reversed.title).toBe('The Reversed Timeline');
		expect(Number(reversed.rating)).toBe(3);
		expect(await readsFor('9780000000003')).toEqual([]);

		// to-read: no read at all, status tbr.
		const tbr = await booksByStorygraphId('SG-UID-0004');
		expect(tbr).toMatchObject({ title: 'Someday Shelf', status: 'tbr' });
		expect(await readsFor('SG-UID-0004')).toEqual([]);

		// did-not-finish: one dateless dnf read, rating/review still attached.
		const dnf = await booksByStorygraphId('not-an-isbn-005');
		expect(dnf.status).toBe('dnf');
		expect(await readsFor('not-an-isbn-005')).toEqual([
			{
				status: 'dnf',
				started_on: null,
				finished_on: null,
				rating: '2.50',
				review: 'Not for me.',
				reader_user_id: operatorId
			}
		]);

		// Empty Dates Read falling back to Last Date Read.
		expect(await readsFor('9780000000004')).toEqual([
			{
				status: 'finished',
				started_on: null,
				finished_on: '2021-07-04',
				rating: null,
				review: null,
				reader_user_id: operatorId
			}
		]);

		// "Fictional Author" is reused across rows 1, 2, 6 and 8 rather than
		// recreated -- one row in authors, linked to all four books.
		const author = one(
			await sql<{ id: string; count: number }[]>`
				select a.id, count(*)::int as count from authors a
				join book_authors ba on ba.author_id = a.id
				where a.household_id = ${householdId}::uuid and lower(a.name) = 'fictional author'
				group by a.id
			`,
			'the reused author'
		);
		expect(author.count).toBe(4);

		const authorCount = await sql<{ count: number }[]>`
			select count(*)::int as count from authors where household_id = ${householdId}::uuid
		`;
		expect(authorCount[0]?.count).toBe(7);
	});

	it('writes nothing on a dry run, even though the report describes a real import', async () => {
		const summary = await run(true);
		expect(summary).toMatchObject({ dryRun: true, booksCreated: 8, authorsCreated: 7 });

		const counts = await sql<{ books: number; authors: number; reads: number }[]>`
			select
				(select count(*)::int from books where household_id = ${householdId}::uuid) as books,
				(select count(*)::int from authors where household_id = ${householdId}::uuid) as authors,
				(select count(*)::int from book_reads r join books b on b.id = r.book_id
				 where b.household_id = ${householdId}::uuid) as reads
		`;
		expect(counts[0]).toEqual({ books: 0, authors: 0, reads: 0 });
	});

	it('skips every row and creates nothing on a second run', async () => {
		await run(false);
		const before = await sql<{ count: number }[]>`
			select count(*)::int as count from books where household_id = ${householdId}::uuid
		`;

		const second = await run(false);
		expect(second).toMatchObject({
			booksCreated: 0,
			booksSkipped: 8,
			booksFailed: 0,
			authorsCreated: 0,
			readsByStatus: { finished: 0, reading: 0, paused: 0, dnf: 0 }
		});

		const after = await sql<{ count: number }[]>`
			select count(*)::int as count from books where household_id = ${householdId}::uuid
		`;
		expect(after[0]?.count).toBe(before[0]?.count);
		expect(after[0]?.count).toBe(8);
	});

	it('leaves a book the household edited since the first run untouched by the second', async () => {
		await run(false);
		// Simulate an in-app edit: the household retitled and re-rated the
		// first sample book after importing it.
		await sql`
			update books set title = 'A Household-Renamed Title', rating = 1,
				updated_at = now(), updated_by = ${operatorId}::uuid
			where household_id = ${householdId}::uuid and storygraph_id = '9780000000001'
		`;

		await run(false);

		const edited = await booksByStorygraphId('9780000000001');
		expect(edited.title).toBe('A Household-Renamed Title');
		expect(Number(edited.rating)).toBe(1);
	});

	it('logs every read as the operator, never the other household member', async () => {
		await run(false);
		const readers = await sql<{ reader_user_id: string }[]>`
			select distinct r.reader_user_id::text as reader_user_id
			from book_reads r join books b on b.id = r.book_id
			where b.household_id = ${householdId}::uuid
		`;
		expect(readers).toEqual([{ reader_user_id: operatorId }]);
		expect(readers.some((r) => r.reader_user_id === partnerId)).toBe(false);
	});
});

describe('a row that fails at the database', () => {
	it('is counted as a failure without losing the rows around it (hard rule 4)', async () => {
		const header = [
			'Title',
			'Authors',
			'Date Added',
			'Dates Read',
			'Format',
			'ISBN/UID',
			'Last Date Read',
			'Moods',
			'Owned?',
			'Pace',
			'Read Count',
			'Read Status',
			'Review',
			'Star Rating',
			'Tags'
		];
		const goodRow = (title: string, uid: string) =>
			[
				title,
				'Fictional Author',
				'2024/01/01',
				'',
				'digital',
				uid,
				'',
				'',
				'No',
				'medium',
				'0',
				'to-read',
				'',
				'',
				''
			].join(',');
		// `books.title` CHECKs length(trim(title)) <= 300 -- the one bound on
		// this field mapStorygraphRow does not itself enforce (it only
		// refuses a blank title), so this is a real way for an otherwise
		// well-formed row to fail at the database rather than at mapping:
		// exactly the case a savepoint per row exists to contain.
		const overlongTitle = 'X'.repeat(301);
		const text =
			`${header.join(',')}\n` +
			`${goodRow('Before the Bad Row', 'FAIL-UID-1')}\n` +
			`${goodRow(overlongTitle, 'FAIL-UID-2')}\n` +
			`${goodRow('After the Bad Row', 'FAIL-UID-3')}\n`;

		const summary = await importStorygraph(sql, text, {
			householdId,
			userId: operatorId,
			dryRun: false
		});
		expect(summary).toMatchObject({ rowsRead: 3, booksCreated: 2, booksFailed: 1 });
		expect(summary.warnings).toContainEqual({ row: 2, field: 'row', message: expect.any(String) });

		const titles = await sql<{ title: string }[]>`
			select title from books where household_id = ${householdId}::uuid order by title
		`;
		expect(titles.map((t) => t.title)).toEqual(['After the Bad Row', 'Before the Bad Row']);
	});
});

describe('through a client configured the way the app’s is', () => {
	it('imports the fixture with no Date-parameter error', async () => {
		// `$lib/server/db` also hands its client to drizzle(), which replaces
		// the driver's timestamp serializers with pass-throughs -- a JS Date
		// sent as a parameter then reaches the wire unconverted and throws
		// (hard rule 2; see health-measurements.test.ts for the production
		// failure this already caused once). Every date this importer sends
		// is a plain 'YYYY-MM-DD' string, never a Date, and this is the test
		// that would catch it if that ever regressed.
		const text = await readFile(FIXTURE_PATH, 'utf8');
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const summary = await importStorygraph(appLike, text, {
				householdId,
				userId: operatorId,
				dryRun: false
			});
			expect(summary.booksCreated).toBe(8);
			expect(summary.booksFailed).toBe(0);

			const count = await appLike<{ count: number }[]>`
				select count(*)::int as count from books where household_id = ${householdId}::uuid
			`;
			expect(count[0]?.count).toBe(8);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
