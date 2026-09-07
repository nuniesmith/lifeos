import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createLibraryItem,
	librarySummary,
	listLibrary,
	search,
	touchLibraryItem,
	updateLibraryItem
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The Library (migration 0013).
 *
 * One table behind Library, Reading and the Knowledge Hub. The property these
 * assert is that the three are filters rather than collections: something
 * cannot be "finished" on one page and "to read" on another, because there is
 * only one row and one status.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let viewer: Viewer;
let elsewhere: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	const identity = {
		id: admin.id,
		username: 'admin',
		displayName: 'Admin',
		role: 'admin' as const,
		mustChangeCredentials: false,
		isBootstrap: true
	};
	viewer = viewerOf(identity, householdId);

	const [other] = await sql<{ id: string }[]>`
		insert into households (name) values ('Next door') returning id
	`;
	elsewhere = viewerOf(identity, other!.id);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what: string) => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

const item = async (title: string, extra: object = {}) =>
	ok(await createLibraryItem(sql, viewer, { title, ...extra }), `create ${title}`).record;

describe('the shelf', () => {
	it('is one table filtered three ways, not three collections', async () => {
		const book = await item('Why We Sleep', { entryType: 'book', status: 'reading_list' });
		await item('A note', { entryType: 'note', status: 'inbox' });

		expect(
			(await listLibrary(sql, viewer, { status: 'reading_list' })).map((i) => i.title)
		).toEqual(['Why We Sleep']);

		// Finishing it moves the same row. There is no second copy that could
		// still claim it is unread.
		ok(await updateLibraryItem(sql, viewer, book.id, { status: 'archived_read' }), 'finish');
		expect(await listLibrary(sql, viewer, { status: 'reading_list' })).toEqual([]);
		expect(
			(await listLibrary(sql, viewer, { status: 'archived_read' })).map((i) => i.title)
		).toEqual(['Why We Sleep']);
		// And it is still in the library, because it never left.
		expect(await listLibrary(sql, viewer)).toHaveLength(2);
	});

	it('normalises a status written the way the source writes it', async () => {
		// "On Reading List" arrives from the import; the form posts
		// "reading_list". Both have to mean the same thing.
		const book = await item('Something', { status: 'Reading List' });
		expect(book.status).toBe('reading_list');
	});

	it('refuses a status it does not know', async () => {
		expect(await createLibraryItem(sql, viewer, { title: 'X', status: 'someday' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('defaults an entry with nothing said about it', async () => {
		const plain = await item('Just a link');
		expect(plain.entryType).toBe('reference');
		expect(plain.status).toBe('inbox');
		expect(plain.highlightCount).toBe(0);
		expect(plain.lastInteractionAt).toBeNull();
	});
});

describe('rediscovery', () => {
	it('sorts never-opened first, because that is the most rediscoverable', async () => {
		const old = await item('Never opened', { status: 'live' });
		const recent = await item('Opened just now', { status: 'live' });
		ok(await touchLibraryItem(sql, viewer, recent.id), 'touch');

		const stale = await listLibrary(sql, viewer, { status: 'live', order: 'stale' });
		expect(stale.map((i) => i.title)).toEqual(['Never opened', 'Opened just now']);
		expect(stale[0]?.id).toBe(old.id);
	});

	it('records when something was opened, so the ordering means something', async () => {
		const entry = await item('Why We Sleep');
		expect(entry.lastInteractionAt).toBeNull();

		const touched = ok(await touchLibraryItem(sql, viewer, entry.id), 'touch');
		expect(touched.record.lastInteractionAt).toBeInstanceOf(Date);

		const [after] = await listLibrary(sql, viewer);
		expect(after?.lastInteractionAt).toBeInstanceOf(Date);
	});

	it('puts the most recently opened first under the recent ordering', async () => {
		const first = await item('First');
		const second = await item('Second');
		ok(await touchLibraryItem(sql, viewer, first.id), 'touch');
		// A distinct instant, so the ordering is not deciding on a tie.
		await new Promise((r) => setTimeout(r, 10));
		ok(await touchLibraryItem(sql, viewer, second.id), 'touch');

		expect((await listLibrary(sql, viewer, { order: 'recent' })).map((i) => i.title)).toEqual([
			'Second',
			'First'
		]);
	});
});

describe('the summary', () => {
	it('counts by status and by type, and totals the highlights', async () => {
		await item('Book one', { entryType: 'book', status: 'reading_list' });
		await item('Book two', { entryType: 'book', status: 'live' });
		await item('A note', { entryType: 'note', status: 'inbox' });
		await sql`update library_items set highlight_count = 15 where title = 'Book two'`;

		const summary = await librarySummary(sql, viewer);
		expect(summary.total).toBe(3);
		expect(summary.byType).toEqual({ book: 2, note: 1, reference: 0 });
		expect(summary.byStatus).toEqual({
			inbox: 1,
			reading_list: 1,
			live: 1,
			archived_read: 0
		});
		expect(summary.highlights).toBe(15);
	});

	it('counts nothing from another household', async () => {
		await item('Ours');
		expect((await librarySummary(sql, elsewhere)).total).toBe(0);
		expect(await listLibrary(sql, elsewhere)).toEqual([]);
	});
});

describe('search', () => {
	it('finds a library entry by its author', async () => {
		await item('Why We Sleep', { author: 'Matthew Walker', summary: 'On sleep debt' });

		const hits = await search(sql, viewer, 'Matthew');
		expect(hits.map((h) => h.title)).toEqual(['Why We Sleep']);
		expect(hits[0]?.kind).toBe('library_item');
		expect(hits[0]?.path).toMatch(/^\/library\//);
	});

	it('does not reach across a household in search either', async () => {
		await item('Why We Sleep', { author: 'Matthew Walker' });
		expect(await search(sql, elsewhere, 'Matthew')).toEqual([]);
	});
});
