import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	activeReads,
	createBook,
	createGenre,
	deleteRead,
	dnfRead,
	finishRead,
	getBook,
	listBookSeries,
	listReadsForBook,
	pauseRead,
	pickTbr,
	readCount,
	recentlyRead,
	resumeRead,
	seriesProgress,
	startRead,
	updateRead,
	updateReadProgress,
	type Book
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The reading log (Reading Tracker R2; migration 0033).
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

describe('starting a read', () => {
	it('creates a reading read for the viewer and moves the book to reading', async () => {
		const book = await addBook(owner, 'The Fictional Saga');
		const started = ok(await startRead(sql, owner, book.id, {}), 'start a read').record;

		expect(started).toMatchObject({
			bookId: book.id,
			readerUserId: owner.userId,
			status: 'reading',
			format: null
		});
		expect(started.startedOn).not.toBeNull();

		const updatedBook = await getBook(sql, owner, book.id);
		expect(updatedBook?.status).toBe('reading');
	});

	it("defaults the read's format to the book's own format when not given", async () => {
		const book = await addBook(owner, 'Format Default', { format: 'audiobook' });
		const started = ok(await startRead(sql, owner, book.id, {}), 'start').record;
		expect(started.format).toBe('audiobook');
	});

	it("lets a caller's own format override the book's default", async () => {
		const book = await addBook(owner, 'Format Override', { format: 'print' });
		const started = ok(
			await startRead(sql, owner, book.id, { format: 'ebook' }),
			'start with a format'
		).record;
		expect(started.format).toBe('ebook');
	});

	it('refuses a second active read by the same reader, with a clear message', async () => {
		const book = await addBook(owner, 'Double Start');
		ok(await startRead(sql, owner, book.id, {}), 'start once');

		const second = await startRead(sql, owner, book.id, {});
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.reason).toBe('invalid');
			expect(second.message).toMatch(/already have an active read/i);
		}
	});

	it('lets a different reader start their own read of the same book', async () => {
		const book = await addBook(owner, 'Shared Copy');
		ok(await startRead(sql, owner, book.id, {}), 'operator starts');
		const kayla = ok(await startRead(sql, partner, book.id, {}), 'partner starts').record;
		expect(kayla.readerUserId).toBe(partner.userId);
	});

	it('is not_found for a book the viewer cannot see', async () => {
		const result = await startRead(sql, owner, '00000000-0000-4000-8000-000000000000', {});
		expect(result).toMatchObject({ ok: false, reason: 'not_found' });
	});
});

describe('a start → pause → resume → finish cycle', () => {
	it("moves the book's status in step at every stage", async () => {
		const book = await addBook(owner, 'Cycle Book');

		const started = ok(await startRead(sql, owner, book.id, {}), 'start').record;
		expect((await getBook(sql, owner, book.id))?.status).toBe('reading');

		const paused = ok(await pauseRead(sql, owner, started.id, started.updatedAt), 'pause').record;
		expect(paused.status).toBe('paused');
		expect((await getBook(sql, owner, book.id))?.status).toBe('paused');

		const resumed = ok(await resumeRead(sql, owner, paused.id, paused.updatedAt), 'resume').record;
		expect(resumed.status).toBe('reading');
		expect((await getBook(sql, owner, book.id))?.status).toBe('reading');

		const finished = ok(
			await finishRead(sql, owner, resumed.id, { rating: 4.5 }, resumed.updatedAt),
			'finish'
		).record;
		expect(finished.status).toBe('finished');
		expect(finished.finishedOn).not.toBeNull();

		const finalBook = await getBook(sql, owner, book.id);
		expect(finalBook?.status).toBe('read');
		expect(finalBook?.rating).toBe(4.5);
	});
});

describe('progress', () => {
	it('updates only the field the caller sends, leaving the other alone', async () => {
		const book = await addBook(owner, 'Progress Book', { pages: 400 });
		const started = ok(await startRead(sql, owner, book.id, {}), 'start').record;

		const withPages = ok(
			await updateReadProgress(sql, owner, started.id, { progressPages: 120 }, started.updatedAt),
			'set pages'
		).record;
		expect(withPages).toMatchObject({ progressPages: 120, progressMinutes: null });

		const withMinutesToo = ok(
			await updateReadProgress(
				sql,
				owner,
				started.id,
				{ progressMinutes: 30 },
				withPages.updatedAt
			),
			'set minutes'
		).record;
		// The pages already recorded must survive an edit that only sends minutes.
		expect(withMinutesToo).toMatchObject({ progressPages: 120, progressMinutes: 30 });
	});
});

describe('finishing a read', () => {
	it('rates an unrated book from a first finish', async () => {
		const book = await addBook(owner, 'Unrated Book');
		const read = ok(await startRead(sql, owner, book.id, {}), 'start').record;
		ok(await finishRead(sql, owner, read.id, { rating: 3.5 }, read.updatedAt), 'finish');

		expect((await getBook(sql, owner, book.id))?.rating).toBe(3.5);
	});

	it('never overwrites a rating the book already carries', async () => {
		const book = await addBook(owner, 'Prerated Book', { rating: 5 });
		const read = ok(await startRead(sql, owner, book.id, {}), 'start').record;
		ok(await finishRead(sql, owner, read.id, { rating: 2 }, read.updatedAt), 'finish');

		expect((await getBook(sql, owner, book.id))?.rating).toBe(5);
	});

	it("does not let a reread's rating overwrite the rating an earlier finish already set", async () => {
		const book = await addBook(owner, 'Reread Book');
		const first = ok(await startRead(sql, owner, book.id, {}), 'start first read').record;
		ok(await finishRead(sql, owner, first.id, { rating: 4 }, first.updatedAt), 'finish first read');
		expect((await getBook(sql, owner, book.id))?.rating).toBe(4);

		const second = ok(await startRead(sql, owner, book.id, {}), 'start reread').record;
		ok(await finishRead(sql, owner, second.id, { rating: 1 }, second.updatedAt), 'finish reread');
		expect((await getBook(sql, owner, book.id))?.rating).toBe(4);
	});

	it('rejects a finish date before the read started', async () => {
		const book = await addBook(owner, 'Backwards Dates');
		const read = ok(
			await startRead(sql, owner, book.id, { startedOn: '2026-09-10' }),
			'start'
		).record;

		const result = await finishRead(
			sql,
			owner,
			read.id,
			{ finishedOn: '2026-09-01' },
			read.updatedAt
		);
		expect(result).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

describe('dnf', () => {
	it('sets the read and the book to dnf, with a reason', async () => {
		const book = await addBook(owner, 'Abandoned Book');
		const read = ok(await startRead(sql, owner, book.id, {}), 'start').record;

		const dnfd = ok(
			await dnfRead(sql, owner, read.id, { reason: 'Too slow for me' }, read.updatedAt),
			'dnf'
		).record;
		expect(dnfd).toMatchObject({ status: 'dnf', dnfReason: 'Too slow for me' });
		expect(dnfd.finishedOn).not.toBeNull();

		expect((await getBook(sql, owner, book.id))?.status).toBe('dnf');
	});
});

describe('recently read', () => {
	it('shows a rereads book once, at its most recent finish, newest first', async () => {
		const older = await addBook(owner, 'Older Finish');
		const olderRead = ok(
			await startRead(sql, owner, older.id, { startedOn: '2026-08-01' }),
			'start older'
		).record;
		ok(
			await finishRead(sql, owner, olderRead.id, { finishedOn: '2026-08-05' }, olderRead.updatedAt),
			'finish older'
		);

		const reread = await addBook(owner, 'Reread Twice');
		const firstRead = ok(
			await startRead(sql, owner, reread.id, { startedOn: '2026-08-10' }),
			'start reread first time'
		).record;
		ok(
			await finishRead(sql, owner, firstRead.id, { finishedOn: '2026-08-12' }, firstRead.updatedAt),
			'finish reread first time'
		);
		const secondRead = ok(
			await startRead(sql, owner, reread.id, { startedOn: '2026-08-20' }),
			'start reread second time'
		).record;
		ok(
			await finishRead(
				sql,
				owner,
				secondRead.id,
				{ finishedOn: '2026-08-25' },
				secondRead.updatedAt
			),
			'finish reread second time'
		);

		const recent = await recentlyRead(sql, owner);
		expect(recent.map((b) => b.id)).toEqual([reread.id, older.id]);
	});

	it("does not show another reader's finish", async () => {
		const book = await addBook(owner, 'Partner Only Finish');
		const read = ok(await startRead(sql, partner, book.id, {}), 'partner starts').record;
		ok(await finishRead(sql, partner, read.id, {}, read.updatedAt), 'partner finishes');

		expect(await recentlyRead(sql, owner)).toEqual([]);
		expect((await recentlyRead(sql, partner)).map((b) => b.id)).toEqual([book.id]);
	});
});

describe('reads are kept apart by reader', () => {
	it("does not count another reader's finished read as the viewer's own", async () => {
		const book = await addBook(owner, 'Shared Read');
		const ownerRead = ok(await startRead(sql, owner, book.id, {}), 'operator starts').record;
		const partnerRead = ok(await startRead(sql, partner, book.id, {}), 'partner starts').record;
		ok(
			await finishRead(sql, partner, partnerRead.id, {}, partnerRead.updatedAt),
			'partner finishes'
		);

		expect(await readCount(sql, partner, book.id)).toBe(1);
		expect(await readCount(sql, owner, book.id)).toBe(0);

		// The operator's own read is untouched by the partner's finish: still
		// active, and the book-status guard did not let the partner's finish
		// stomp anything the operator's own read is responsible for.
		const ownerActive = await activeReads(sql, owner);
		expect(ownerActive.map((r) => r.id)).toEqual([ownerRead.id]);

		const history = await listReadsForBook(sql, owner, book.id);
		expect(history).toHaveLength(2);
		expect(history.find((r) => r.id === partnerRead.id)?.readerName).toBe('Partner');
	});

	it('keeps series progress and counts per viewer', async () => {
		const book1 = await addBook(owner, 'Trilogy Book One', {
			seriesName: 'Fictional Trilogy',
			seriesPosition: 1
		});
		const seriesId = book1.seriesId!;
		const book2 = await addBook(owner, 'Trilogy Book Two', {
			seriesName: 'Fictional Trilogy',
			seriesPosition: 2
		});
		const book3 = await addBook(owner, 'Trilogy Book Three', {
			seriesName: 'Fictional Trilogy',
			seriesPosition: 3
		});

		const read1 = ok(await startRead(sql, owner, book1.id, {}), 'operator starts book one').record;
		ok(await finishRead(sql, owner, read1.id, {}, read1.updatedAt), 'operator finishes book one');

		const progress = await seriesProgress(sql, owner, seriesId);
		expect(progress.books.map((b) => ({ id: b.id, finished: b.finished }))).toEqual([
			{ id: book1.id, finished: true },
			{ id: book2.id, finished: false },
			{ id: book3.id, finished: false }
		]);
		expect(progress.nextUpId).toBe(book2.id);

		// The partner has read none of it: kept apart from the operator's own
		// progress through the very same series.
		const partnerProgress = await seriesProgress(sql, partner, seriesId);
		expect(partnerProgress.books.every((b) => !b.finished)).toBe(true);
		expect(partnerProgress.nextUpId).toBe(book1.id);

		const ownerSeries = (await listBookSeries(sql, owner, {})).find((s) => s.id === seriesId);
		expect(ownerSeries).toMatchObject({ bookCount: 3, finishedCount: 1 });
		const partnerSeries = (await listBookSeries(sql, partner, {})).find((s) => s.id === seriesId);
		expect(partnerSeries).toMatchObject({ bookCount: 3, finishedCount: 0 });
	});
});

describe('authorization', () => {
	it("forbids changing or deleting another reader's read of a book the viewer can see", async () => {
		const book = await addBook(owner, 'Operator Book');
		const read = ok(await startRead(sql, owner, book.id, {}), 'start').record;

		const pauseAsPartner = await pauseRead(sql, partner, read.id, read.updatedAt);
		expect(pauseAsPartner).toMatchObject({ ok: false, reason: 'forbidden' });

		const updateAsPartner = await updateRead(sql, partner, read.id, { rating: 1 }, read.updatedAt);
		expect(updateAsPartner).toMatchObject({ ok: false, reason: 'forbidden' });

		const deleteAsPartner = await deleteRead(sql, partner, read.id);
		expect(deleteAsPartner).toMatchObject({ ok: false, reason: 'forbidden' });

		// Untouched by every refused attempt above.
		const stillOwners = await listReadsForBook(sql, owner, book.id);
		expect(stillOwners).toHaveLength(1);
	});

	it('is not_found — never forbidden — for a read on a book the viewer cannot see at all', async () => {
		const privateBook = ok(
			await createBook(sql, partner, {
				title: 'Partner Private Book',
				visibility: 'private',
				ownerUserId: partner.userId
			}),
			'create a private book'
		).record;
		const read = ok(await startRead(sql, partner, privateBook.id, {}), 'partner starts').record;

		const pauseAsOwner = await pauseRead(sql, owner, read.id, read.updatedAt);
		expect(pauseAsOwner).toMatchObject({ ok: false, reason: 'not_found' });

		const deleteAsOwner = await deleteRead(sql, owner, read.id);
		expect(deleteAsOwner).toMatchObject({ ok: false, reason: 'not_found' });
	});
});

describe('editing and deleting a read', () => {
	it('corrects dates, format, rating and review after the fact', async () => {
		const book = await addBook(owner, 'Edit Me Book');
		const read = ok(
			await startRead(sql, owner, book.id, { startedOn: '2026-09-01', format: 'print' }),
			'start'
		).record;
		const finished = ok(
			await finishRead(sql, owner, read.id, { finishedOn: '2026-09-15' }, read.updatedAt),
			'finish'
		).record;

		const edited = ok(
			await updateRead(
				sql,
				owner,
				finished.id,
				{ startedOn: '2026-09-02', format: 'ebook', rating: 4.75, review: 'Loved the ending.' },
				finished.updatedAt
			),
			'edit'
		).record;
		expect(edited).toMatchObject({
			startedOn: '2026-09-02',
			finishedOn: '2026-09-15',
			format: 'ebook',
			rating: 4.75,
			review: 'Loved the ending.'
		});
	});

	it('conflicts a stale edit (optimistic concurrency)', async () => {
		const book = await addBook(owner, 'Stale Edit Book');
		const read = ok(await startRead(sql, owner, book.id, {}), 'start').record;
		ok(
			await updateReadProgress(sql, owner, read.id, { progressPages: 50 }, read.updatedAt),
			'first edit, with the original version'
		);

		// Same (now stale) version used a second time.
		const stale = await updateReadProgress(
			sql,
			owner,
			read.id,
			{ progressPages: 60 },
			read.updatedAt
		);
		expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('deletes a read outright, with no archive to restore it from', async () => {
		const book = await addBook(owner, 'Delete Me Book');
		const read = ok(await startRead(sql, owner, book.id, {}), 'start').record;

		const deleted = await deleteRead(sql, owner, read.id);
		expect(deleted).toMatchObject({ ok: true, record: { id: read.id } });
		expect(await listReadsForBook(sql, owner, book.id)).toEqual([]);
	});
});

describe('the TBR picker', () => {
	it('filters by genre, format, owned and max pages together', async () => {
		const genre = ok(
			await createGenre(sql, owner, { name: 'Cozy Mystery' }),
			'create genre'
		).record;
		const match = await addBook(owner, 'Short Cozy Ebook', {
			format: 'ebook',
			owned: true,
			pages: 150,
			genreNames: 'Cozy Mystery'
		});
		await addBook(owner, 'Long Cozy Print', {
			format: 'print',
			owned: true,
			pages: 900,
			genreNames: 'Cozy Mystery'
		});
		await addBook(owner, 'Short Fantasy Ebook', { format: 'ebook', owned: true, pages: 150 });

		const pick = await pickTbr(sql, owner, {
			genreId: genre.id,
			format: 'ebook',
			owned: true,
			maxPages: 200
		});
		expect(pick?.id).toBe(match.id);
	});

	it('excludes the ids it is given', async () => {
		const a = await addBook(owner, 'Alpha TBR');
		const b = await addBook(owner, 'Beta TBR');

		const excluded = await pickTbr(sql, owner, { excludeIds: [a.id, b.id] });
		expect(excluded).toBeNull();

		const stillPickable = await pickTbr(sql, owner, { excludeIds: [a.id] });
		expect(stillPickable?.id).toBe(b.id);
	});

	it('picks deterministically from an injected random function', async () => {
		await addBook(owner, 'Alpha TBR');
		await addBook(owner, 'Beta TBR');

		const first = await pickTbr(sql, owner, {}, () => 0);
		const last = await pickTbr(sql, owner, {}, () => 0.999);
		expect(first?.title).toBe('Alpha TBR');
		expect(last?.title).toBe('Beta TBR');
	});

	it('returns null when nothing on the TBR matches', async () => {
		const result = await pickTbr(sql, owner, { maxPages: 10 });
		expect(result).toBeNull();
	});
});

describe('through a client configured the way the app’s is', () => {
	// `$lib/server/db` also hands its client to drizzle(), which replaces the
	// driver's timestamp serializers with pass-throughs — a JS Date sent as a
	// parameter then reaches the wire unconverted and throws. See the same
	// block at the end of health-measurements.test.ts for how this caught a
	// production failure that every test against a plain client missed (hard
	// rule 2).
	it('starts, pauses, resumes and finishes a read through the app-like client', async () => {
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const book = await addBook(owner, 'App-Like Client Cycle');
			const started = ok(
				await startRead(appLike, owner, book.id, { startedOn: '2026-09-01' }),
				'start through the app-like client'
			).record;
			const paused = ok(
				await pauseRead(appLike, owner, started.id, started.updatedAt),
				'pause through the app-like client'
			).record;
			const resumed = ok(
				await resumeRead(appLike, owner, paused.id, paused.updatedAt),
				'resume through the app-like client'
			).record;
			const finished = ok(
				await finishRead(
					appLike,
					owner,
					resumed.id,
					{ finishedOn: '2026-09-10', rating: 4 },
					resumed.updatedAt
				),
				'finish through the app-like client'
			).record;

			expect(finished.status).toBe('finished');
			expect(finished.startedOn).toBe('2026-09-01');
			expect(finished.finishedOn).toBe('2026-09-10');
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});

	it('dnfs a read through the app-like client', async () => {
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const book = await addBook(owner, 'App-Like Client DNF');
			const started = ok(
				await startRead(appLike, owner, book.id, {}),
				'start through the app-like client'
			).record;
			const dnfd = ok(
				await dnfRead(appLike, owner, started.id, { reason: 'Not for me' }, started.updatedAt),
				'dnf through the app-like client'
			).record;

			expect(dnfd.status).toBe('dnf');
			expect(dnfd.finishedOn).not.toBeNull();
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
