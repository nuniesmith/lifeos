import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMember } from '$lib/server/auth/admin';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addLibraryLink,
	createLibraryItem,
	librarySummary,
	listLibrary,
	listLibraryLinks,
	removeLibraryLink,
	search,
	setLibraryItemArchived,
	touchLibraryItem,
	updateLibraryItem
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The Library (migration 0013; links and archiving added by migration 0023,
 * PACK1-001).
 *
 * One table behind Library, Reading and the Knowledge Hub. The property these
 * assert is that the three are filters rather than collections: something
 * cannot be "finished" on one page and "to read" on another, because there is
 * only one row and one status.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let viewer: Viewer;
let partner: Viewer;
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

	const created = await createMember(sql, admin.id, householdId, {
		username: 'partner',
		displayName: 'Partner',
		role: 'member'
	});
	if (!created.ok) throw new Error('could not create the partner');
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

/** Inserts a row directly, so ownership combinations `createLibraryItem`
 *  refuses to create (an item owned by somebody other than the caller) can
 *  still be tested for read/write scoping — the same reason
 *  repositories.test.ts's `seedTask` bypasses the repository. */
async function seedItem(
	householdId: string,
	ownerUserId: string | null,
	visibility: 'household' | 'private',
	title: string
): Promise<{ id: string; updatedAt: Date }> {
	const row = one(
		await sql<{ id: string; updated_at: Date }[]>`
			insert into library_items (household_id, owner_user_id, visibility, title)
			values (${householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title})
			returning id, updated_at
		`,
		'library item'
	);
	return { id: row.id, updatedAt: new Date(row.updated_at) };
}

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

describe('editing', () => {
	it('can change format and url after creation, not only at creation', async () => {
		const entry = await item('A podcast', { format: 'Podcast', url: 'https://example.com/old' });
		const edited = ok(
			await updateLibraryItem(sql, viewer, entry.id, {
				format: 'Video',
				url: 'https://example.com/new'
			}),
			'edit format and url'
		).record;
		expect(edited).toMatchObject({ format: 'Video', url: 'https://example.com/new' });
	});
});

describe('archiving', () => {
	it('archives and restores an entry', async () => {
		const entry = await item('To read later');

		const archived = ok(
			await setLibraryItemArchived(sql, viewer, entry.id, true),
			'archive'
		).record;
		expect(archived.archivedAt).toBeInstanceOf(Date);
		// Out of the live list, but still directly reachable — /archive looks at
		// it before anyone restores it.
		expect((await listLibrary(sql, viewer)).map((i) => i.id)).not.toContain(entry.id);

		const restored = ok(
			await setLibraryItemArchived(sql, viewer, entry.id, false, archived.updatedAt),
			'restore'
		).record;
		expect(restored.archivedAt).toBeNull();
		expect((await listLibrary(sql, viewer)).map((i) => i.id)).toContain(entry.id);
	});

	it('refuses to archive a private entry owned by someone else, as not found', async () => {
		// Unreadable, not merely unwritable: telling the viewer this exists
		// would itself be the leak.
		const theirs = await seedItem(viewer.householdId, partner.userId, 'private', 'Partner-only');
		expect(await setLibraryItemArchived(sql, viewer, theirs.id, true)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('refuses to archive a shared entry owned by someone else, as forbidden — and leaves it untouched', async () => {
		const theirs = await seedItem(
			viewer.householdId,
			partner.userId,
			'household',
			'Partner claims this'
		);
		expect(await setLibraryItemArchived(sql, viewer, theirs.id, true)).toMatchObject({
			ok: false,
			reason: 'forbidden'
		});

		const [row] = await sql<{ archived_at: unknown }[]>`
			select archived_at from library_items where id = ${theirs.id}::uuid
		`;
		expect(row?.archived_at).toBeNull();
	});
});

describe('links between entries', () => {
	it('records an edge and reports it from both ends', async () => {
		const a = await item('Deep Work');
		const b = await item('So Good They Cannot Ignore You');

		expect(await addLibraryLink(sql, viewer, a.id, b.id)).toMatchObject({
			ok: true,
			record: { itemId: b.id, title: b.title }
		});

		expect((await listLibraryLinks(sql, viewer, a.id)).map((l) => l.itemId)).toEqual([b.id]);
		// The same single row, seen from the other side — a library link has no
		// direction, unlike a task dependency.
		expect((await listLibraryLinks(sql, viewer, b.id)).map((l) => l.itemId)).toEqual([a.id]);
	});

	it('is idempotent, and does not care which end is named first', async () => {
		const a = await item('First entry');
		const b = await item('Second entry');
		await addLibraryLink(sql, viewer, a.id, b.id);
		await addLibraryLink(sql, viewer, b.id, a.id);
		expect((await listLibraryLinks(sql, viewer, a.id)).map((l) => l.itemId)).toEqual([b.id]);
	});

	it('refuses an entry linking to itself', async () => {
		const a = await item('Self-referential entry');
		expect(await addLibraryLink(sql, viewer, a.id, a.id)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('removes an edge and reports whether there was one', async () => {
		const a = await item('Third entry');
		const b = await item('Fourth entry');
		await addLibraryLink(sql, viewer, a.id, b.id);

		expect(await removeLibraryLink(sql, viewer, a.id, b.id)).toBe(true);
		expect(await removeLibraryLink(sql, viewer, a.id, b.id)).toBe(false);
		expect(await listLibraryLinks(sql, viewer, a.id)).toEqual([]);
	});

	it('does not leak the title of an entry the viewer cannot read', async () => {
		const shared = await item('Shared entry');
		const secret = await seedItem(viewer.householdId, viewer.userId, 'private', 'My private note');
		expect(await addLibraryLink(sql, viewer, shared.id, secret.id)).toMatchObject({ ok: true });

		// The owner sees the edge.
		expect((await listLibraryLinks(sql, viewer, shared.id)).map((l) => l.itemId)).toEqual([
			secret.id
		]);

		// The partner can read `shared` but not the private entry it links to.
		// The edge must disappear rather than surface its title through a join.
		const seen = await listLibraryLinks(sql, partner, shared.id);
		expect(seen).toHaveLength(0);
		expect(JSON.stringify(seen)).not.toContain('private note');
	});

	it('refuses to add a link from an entry the viewer cannot write, private or merely unowned by them', async () => {
		const theirsPrivate = await seedItem(
			viewer.householdId,
			partner.userId,
			'private',
			'Partner-guarded'
		);
		const mine = await item('Mine to link from');
		expect(await addLibraryLink(sql, viewer, theirsPrivate.id, mine.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});

		// Readable is not the same as writable: a shared entry someone else
		// owns can be seen but must still refuse to be linked *from*.
		const theirsShared = await seedItem(
			viewer.householdId,
			partner.userId,
			'household',
			'Partner-owned, shared'
		);
		expect(await addLibraryLink(sql, viewer, theirsShared.id, mine.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('refuses to remove a link on an entry the viewer cannot write', async () => {
		const theirs = await seedItem(viewer.householdId, partner.userId, 'household', 'One of theirs');
		const other = await seedItem(viewer.householdId, partner.userId, 'household', 'Also theirs');
		await addLibraryLink(sql, partner, theirs.id, other.id);

		expect(await removeLibraryLink(sql, viewer, theirs.id, other.id)).toBe(false);
		expect((await listLibraryLinks(sql, viewer, theirs.id)).map((l) => l.itemId)).toEqual([
			other.id
		]);
	});
});

describe('through a client configured the way the app’s is', () => {
	it('creates and archives an entry', async () => {
		// `$lib/server/db` also hands its client to drizzle(), which replaces
		// the driver's timestamp serializers with pass-throughs. A JS Date sent
		// as a parameter then reaches the wire unconverted and throws — the
		// same failure health-measurements.test.ts documents. This is the
		// client `setLibraryItemArchived`'s `expectedUpdatedAt` runs through in
		// production; the plain client above would hide the mistake.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createLibraryItem(appLike, viewer, { title: 'Through the app client' }),
				'create through the app-like client'
			).record;

			const archived = ok(
				await setLibraryItemArchived(appLike, viewer, created.id, true, created.updatedAt),
				'archive it through the app-like client'
			).record;
			expect(archived.archivedAt).toBeInstanceOf(Date);

			const restored = ok(
				await setLibraryItemArchived(appLike, viewer, created.id, false, archived.updatedAt),
				'restore it through the app-like client'
			).record;
			expect(restored.archivedAt).toBeNull();
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
