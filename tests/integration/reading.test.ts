import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createAuthor,
	createBook,
	createBookSeries,
	createGenre,
	findOrCreateAuthor,
	findOrCreateBookSeries,
	findOrCreateGenre,
	getAuthor,
	getBook,
	getBookSeries,
	getGenre,
	householdToday,
	listAuthors,
	listAuthorsForBook,
	listBookSeries,
	listBooks,
	listGenres,
	listGenresForBook,
	setAuthorArchived,
	setBookArchived,
	setBookSeriesArchived,
	setGenreArchived,
	updateAuthor,
	updateBook,
	updateBookSeries,
	updateGenre
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The book catalogue (Reading Tracker R1; migration 0030).
 *
 * All test data is invented: obviously fictional titles and authors, never
 * anything read from `data/`, which holds the household's real Notion export
 * (hard rule 1).
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

describe('authors', () => {
	it('creates, renames, and takes notes', async () => {
		const created = ok(
			await createAuthor(sql, owner, { name: 'Fictional Author' }),
			'create author'
		).record;
		expect(created.name).toBe('Fictional Author');

		const renamed = ok(
			await updateAuthor(
				sql,
				owner,
				created.id,
				{ notes: 'Writes The Sample Saga.' },
				created.updatedAt
			),
			'add notes'
		).record;
		expect(renamed).toMatchObject({ name: 'Fictional Author', notes: 'Writes The Sample Saga.' });
	});

	it('refuses a second live author with the same name, case-insensitively', async () => {
		ok(await createAuthor(sql, owner, { name: 'Fictional Author' }), 'first author');
		expect(await createAuthor(sql, owner, { name: 'fictional author' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('finds an existing live author by name rather than creating a duplicate', async () => {
		const first = ok(await createAuthor(sql, owner, { name: 'Fictional Author' }), 'create').record;
		const found = ok(
			await findOrCreateAuthor(sql, owner, 'FICTIONAL AUTHOR'),
			'find or create'
		).record;
		expect(found.id).toBe(first.id);
		expect((await listAuthors(sql, owner)).length).toBe(1);
	});

	it('creates a fresh author once the same name is archived', async () => {
		const first = ok(await createAuthor(sql, owner, { name: 'Fictional Author' }), 'create').record;
		ok(await setAuthorArchived(sql, owner, first.id, true), 'archive');

		const second = ok(
			await findOrCreateAuthor(sql, owner, 'Fictional Author'),
			'find or create after archive'
		).record;
		expect(second.id).not.toBe(first.id);
	});

	it('lists live book counts the viewer can read, excluding another member’s private books', async () => {
		const author = ok(
			await createAuthor(sql, owner, { name: 'Fictional Author' }),
			'create'
		).record;
		ok(
			await createBook(sql, owner, { title: 'The Sample Saga', authorNames: 'Fictional Author' }),
			'shared book'
		);
		ok(
			await createBook(sql, partner, {
				title: 'A Private Sequel',
				authorNames: 'Fictional Author',
				visibility: 'private',
				ownerUserId: partner.userId
			}),
			'private book'
		);

		const [asOwner] = await listAuthors(sql, owner);
		expect(asOwner).toMatchObject({ id: author.id, bookCount: 1 });
		const [asPartner] = await listAuthors(sql, partner);
		expect(asPartner).toMatchObject({ id: author.id, bookCount: 2 });
	});

	it('never lists or renames another household’s author', async () => {
		const created = ok(
			await createAuthor(sql, owner, { name: 'Fictional Author' }),
			'create'
		).record;
		const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };
		expect(await getAuthor(sql, elsewhere, created.id)).toBeNull();
		expect(
			await updateAuthor(sql, elsewhere, created.id, { name: 'Hijacked' }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'not_found' });
	});
});

describe('series', () => {
	it('creates with a planned count and renames', async () => {
		const created = ok(
			await createBookSeries(sql, owner, { name: 'The Sample Chronicles', plannedCount: 7 }),
			'create series'
		).record;
		expect(created).toMatchObject({ name: 'The Sample Chronicles', plannedCount: 7 });

		const renamed = ok(
			await updateBookSeries(sql, owner, created.id, { plannedCount: 9 }, created.updatedAt),
			'update planned count'
		).record;
		expect(renamed.plannedCount).toBe(9);
	});

	it('refuses a planned count of zero, matching the table’s own > 0 CHECK', async () => {
		expect(
			await createBookSeries(sql, owner, { name: 'The Sample Chronicles', plannedCount: 0 })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('find-or-creates by name and counts its live books', async () => {
		const first = ok(
			await findOrCreateBookSeries(sql, owner, 'The Sample Chronicles'),
			'first'
		).record;
		const again = ok(
			await findOrCreateBookSeries(sql, owner, 'the sample chronicles'),
			'again'
		).record;
		expect(again.id).toBe(first.id);

		ok(
			await createBook(sql, owner, {
				title: 'The Sample Saga',
				seriesName: 'The Sample Chronicles',
				seriesPosition: 1
			}),
			'book one'
		);
		const [series] = await listBookSeries(sql, owner);
		expect(series).toMatchObject({ id: first.id, bookCount: 1 });
	});

	it('archives and restores', async () => {
		const created = ok(
			await createBookSeries(sql, owner, { name: 'The Sample Chronicles' }),
			'create'
		).record;
		ok(await setBookSeriesArchived(sql, owner, created.id, true), 'archive');
		expect((await getBookSeries(sql, owner, created.id))?.archivedAt).not.toBeNull();
		ok(await setBookSeriesArchived(sql, owner, created.id, false), 'restore');
		expect((await getBookSeries(sql, owner, created.id))?.archivedAt).toBeNull();
	});
});

describe('genres', () => {
	it('creates, renames and counts live books through the join table', async () => {
		const genre = ok(
			await createGenre(sql, owner, { name: 'Speculative Fiction' }),
			'create'
		).record;
		ok(
			await createBook(sql, owner, { title: 'The Sample Saga', genreNames: 'Speculative Fiction' }),
			'book'
		);

		const [listed] = await listGenres(sql, owner);
		expect(listed).toMatchObject({ id: genre.id, bookCount: 1 });

		const renamed = ok(
			await updateGenre(sql, owner, genre.id, { name: 'Speculative fiction' }, genre.updatedAt),
			'rename'
		).record;
		expect(renamed.name).toBe('Speculative fiction');
	});

	it('finds an existing genre case-insensitively rather than duplicating it', async () => {
		const first = ok(await createGenre(sql, owner, { name: 'Cozy Mystery' }), 'create').record;
		const found = ok(await findOrCreateGenre(sql, owner, 'cozy mystery'), 'find').record;
		expect(found.id).toBe(first.id);
	});

	it('archives and restores', async () => {
		const created = ok(await createGenre(sql, owner, { name: 'Cozy Mystery' }), 'create').record;
		ok(await setGenreArchived(sql, owner, created.id, true), 'archive');
		expect((await getGenre(sql, owner, created.id))?.archivedAt).not.toBeNull();
		ok(await setGenreArchived(sql, owner, created.id, false), 'restore');
		expect((await getGenre(sql, owner, created.id))?.archivedAt).toBeNull();
	});
});

describe('books: creating', () => {
	it('defaults to tbr and stamps today onto tbr_added_on', async () => {
		const today = await householdToday(sql, owner.householdId);
		const created = ok(await createBook(sql, owner, { title: 'The Sample Saga' }), 'create').record;
		expect(created).toMatchObject({
			status: 'tbr',
			tbrAddedOn: today,
			owned: false,
			favourite: false
		});
	});

	it('does not stamp tbr_added_on for a book that is not created as tbr', async () => {
		const created = ok(
			await createBook(sql, owner, { title: 'The Sample Saga', status: 'reading' }),
			'create'
		).record;
		expect(created.tbrAddedOn).toBeNull();
	});

	it('refuses a blank title', async () => {
		expect(await createBook(sql, owner, { title: '   ' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('round-trips every field the form can set', async () => {
		const created = ok(
			await createBook(sql, owner, {
				title: 'The Sample Saga',
				subtitle: 'A Fictional Tale',
				status: 'reading',
				category: 'fiction',
				audience: 'adult',
				format: 'ebook',
				owned: true,
				pages: 320,
				isbn: '978-0-06-231609-7',
				releaseDate: '2025-06-01',
				rating: 3.75,
				favourite: true,
				spice: 2,
				pace: 'fast',
				tropes: 'Found family, found family, Slow burn',
				moods: 'Hopeful',
				tags: 'Book club',
				contentWarnings: 'Peril',
				description: '# A summary',
				notes: 'Loved it',
				storygraphUrl: 'https://app.thestorygraph.com/books/sample',
				recommendedBy: 'Kayla'
			}),
			'create'
		).record;

		expect(created).toMatchObject({
			title: 'The Sample Saga',
			subtitle: 'A Fictional Tale',
			status: 'reading',
			category: 'fiction',
			audience: 'adult',
			format: 'ebook',
			owned: true,
			pages: 320,
			isbn: '9780062316097',
			releaseDate: '2025-06-01',
			rating: 3.75,
			favourite: true,
			spice: 2,
			pace: 'fast',
			tropes: ['Found family', 'Slow burn'],
			moods: ['Hopeful'],
			tags: ['Book club'],
			contentWarnings: 'Peril',
			description: '# A summary',
			notes: 'Loved it',
			storygraphUrl: 'https://app.thestorygraph.com/books/sample',
			recommendedBy: 'Kayla'
		});
	});

	it('refuses a rating that is not a quarter step, matching the table’s own CHECK', async () => {
		expect(await createBook(sql, owner, { title: 'The Sample Saga', rating: 3.3 })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('find-or-creates the series and stores the position together', async () => {
		const created = ok(
			await createBook(sql, owner, {
				title: 'The Sample Saga',
				seriesName: 'The Sample Chronicles',
				seriesPosition: 1.5
			}),
			'create'
		).record;
		expect(created.seriesPosition).toBe(1.5);
		const series = await getBookSeries(sql, owner, created.seriesId!);
		expect(series?.name).toBe('The Sample Chronicles');
	});

	it('find-or-creates authors and genres and links them in order', async () => {
		const created = ok(
			await createBook(sql, owner, {
				title: 'The Sample Saga',
				authorNames: 'Second Author, Fictional Author',
				genreNames: 'Speculative Fiction, Cozy Mystery'
			}),
			'create'
		).record;

		const authors = await listAuthorsForBook(sql, owner, created.id);
		expect(authors.map((a) => a.name)).toEqual(['Second Author', 'Fictional Author']);
		expect(authors.map((a) => a.position)).toEqual([0, 1]);

		const genres = await listGenresForBook(sql, owner, created.id);
		expect(genres.map((g) => g.name).sort()).toEqual(['Cozy Mystery', 'Speculative Fiction']);
	});
});

describe('books: listing and filters', () => {
	async function seedCatalogue() {
		const author = ok(
			await createAuthor(sql, owner, { name: 'Fictional Author' }),
			'author'
		).record;
		const genre = ok(await createGenre(sql, owner, { name: 'Cozy Mystery' }), 'genre').record;
		const series = ok(
			await createBookSeries(sql, owner, { name: 'The Sample Chronicles' }),
			'series'
		).record;

		const tbr = ok(
			await createBook(sql, owner, {
				title: 'The TBR Sample',
				authorNames: 'Fictional Author',
				genreNames: 'Cozy Mystery'
			}),
			'tbr'
		).record;
		const reading = ok(
			await createBook(sql, owner, {
				title: 'The Reading Sample',
				status: 'reading',
				seriesName: 'The Sample Chronicles',
				seriesPosition: 2
			}),
			'reading'
		).record;
		const read = ok(
			await createBook(sql, owner, {
				title: 'The Read Sample',
				status: 'read',
				owned: true,
				favourite: true
			}),
			'read'
		).record;
		return { author, genre, series, tbr, reading, read };
	}

	it('filters by status', async () => {
		const { tbr } = await seedCatalogue();
		const list = await listBooks(sql, owner, { status: 'tbr' });
		expect(list.map((b) => b.id)).toEqual([tbr.id]);
	});

	it('filters by author, series and genre id', async () => {
		const { author, genre, series, tbr, reading } = await seedCatalogue();
		expect((await listBooks(sql, owner, { authorId: author.id })).map((b) => b.id)).toEqual([
			tbr.id
		]);
		expect((await listBooks(sql, owner, { genreId: genre.id })).map((b) => b.id)).toEqual([tbr.id]);
		expect((await listBooks(sql, owner, { seriesId: series.id })).map((b) => b.id)).toEqual([
			reading.id
		]);
	});

	it('filters by owned and favourite', async () => {
		const { read } = await seedCatalogue();
		expect((await listBooks(sql, owner, { owned: true })).map((b) => b.id)).toEqual([read.id]);
		expect((await listBooks(sql, owner, { favourite: true })).map((b) => b.id)).toEqual([read.id]);
	});

	it('searches the title', async () => {
		const { reading } = await seedCatalogue();
		expect((await listBooks(sql, owner, { search: 'reading samp' })).map((b) => b.id)).toEqual([
			reading.id
		]);
	});

	it('carries the author names and series name for display', async () => {
		await seedCatalogue();
		const [tbr] = await listBooks(sql, owner, { status: 'tbr' });
		expect(tbr?.authorNames).toBe('Fictional Author');
		const [reading] = await listBooks(sql, owner, { status: 'reading' });
		expect(reading?.seriesName).toBe('The Sample Chronicles');
	});

	it('orders a series by series_position', async () => {
		const series = ok(
			await createBookSeries(sql, owner, { name: 'The Sample Chronicles' }),
			'series'
		).record;
		const two = ok(
			await createBook(sql, owner, {
				title: 'Book Two',
				seriesName: series.name,
				seriesPosition: 2
			}),
			'two'
		).record;
		const one_ = ok(
			await createBook(sql, owner, {
				title: 'Book One',
				seriesName: series.name,
				seriesPosition: 1
			}),
			'one'
		).record;

		const ordered = await listBooks(sql, owner, { seriesId: series.id, order: 'series_position' });
		expect(ordered.map((b) => b.id)).toEqual([one_.id, two.id]);
	});

	it('never lists another member’s private book, and excludes it from counts', async () => {
		const author = ok(
			await createAuthor(sql, owner, { name: 'Fictional Author' }),
			'author'
		).record;
		ok(
			await createBook(sql, partner, {
				title: 'A Private Read',
				authorNames: 'Fictional Author',
				visibility: 'private',
				ownerUserId: partner.userId
			}),
			'private'
		);
		expect(await listBooks(sql, owner, {})).toEqual([]);
		expect((await listAuthors(sql, owner))[0]?.bookCount).toBe(0);
		expect((await listAuthors(sql, partner))[0]?.bookCount).toBe(1);
		void author;
	});
});

describe('books: editing', () => {
	it('changes only the fields supplied, keeping the rest', async () => {
		const created = ok(
			await createBook(sql, owner, { title: 'The Sample Saga', pages: 320, favourite: true }),
			'create'
		).record;
		const updated = ok(
			await updateBook(sql, owner, created.id, { pages: 400 }, created.updatedAt),
			'update pages only'
		).record;
		expect(updated.pages).toBe(400);
		expect(updated.favourite).toBe(true);
		expect(updated.title).toBe('The Sample Saga');
	});

	it('clears tropes back to empty when the patch says so explicitly', async () => {
		const created = ok(
			await createBook(sql, owner, { title: 'The Sample Saga', tropes: 'Slow burn' }),
			'create'
		).record;
		const updated = ok(
			await updateBook(sql, owner, created.id, { tropes: '' }, created.updatedAt),
			'clear tropes'
		).record;
		expect(updated.tropes).toEqual([]);
	});

	it('replaces authors rather than accumulating them', async () => {
		const created = ok(
			await createBook(sql, owner, { title: 'The Sample Saga', authorNames: 'Fictional Author' }),
			'create'
		).record;
		ok(
			await updateBook(sql, owner, created.id, { authorNames: 'Second Author' }, created.updatedAt),
			'replace authors'
		);
		const authors = await listAuthorsForBook(sql, owner, created.id);
		expect(authors.map((a) => a.name)).toEqual(['Second Author']);
	});

	it('leaves the author list untouched when the patch does not mention it', async () => {
		const created = ok(
			await createBook(sql, owner, { title: 'The Sample Saga', authorNames: 'Fictional Author' }),
			'create'
		).record;
		ok(
			await updateBook(sql, owner, created.id, { pages: 100 }, created.updatedAt),
			'unrelated edit'
		);
		const authors = await listAuthorsForBook(sql, owner, created.id);
		expect(authors.map((a) => a.name)).toEqual(['Fictional Author']);
	});

	it('moves a book to a different series and drops the stale position', async () => {
		const created = ok(
			await createBook(sql, owner, {
				title: 'The Sample Saga',
				seriesName: 'The Sample Chronicles',
				seriesPosition: 1
			}),
			'create'
		).record;
		const moved = ok(
			await updateBook(
				sql,
				owner,
				created.id,
				{ seriesName: 'A New Series', seriesPosition: 3 },
				created.updatedAt
			),
			'move series'
		).record;
		expect(moved.seriesPosition).toBe(3);
		const series = await getBookSeries(sql, owner, moved.seriesId!);
		expect(series?.name).toBe('A New Series');
	});

	it('clears the series and its position together when the name is blanked', async () => {
		const created = ok(
			await createBook(sql, owner, {
				title: 'The Sample Saga',
				seriesName: 'The Sample Chronicles',
				seriesPosition: 1
			}),
			'create'
		).record;
		const cleared = ok(
			await updateBook(
				sql,
				owner,
				created.id,
				{ seriesName: '', seriesPosition: 5 },
				created.updatedAt
			),
			'clear series'
		).record;
		expect(cleared.seriesId).toBeNull();
		expect(cleared.seriesPosition).toBeNull();
	});

	it('refuses a stale write', async () => {
		const created = ok(await createBook(sql, owner, { title: 'The Sample Saga' }), 'create').record;
		ok(await updateBook(sql, owner, created.id, { pages: 100 }, created.updatedAt), 'first edit');
		expect(
			await updateBook(sql, owner, created.id, { pages: 200 }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('refuses to edit another member’s private book as not_found, never forbidden', async () => {
		const theirs = ok(
			await createBook(sql, partner, {
				title: 'Their Book',
				visibility: 'private',
				ownerUserId: partner.userId
			}),
			'their book'
		).record;
		expect(await updateBook(sql, owner, theirs.id, { pages: 100 }, theirs.updatedAt)).toMatchObject(
			{ ok: false, reason: 'not_found' }
		);
		expect(await getBook(sql, owner, theirs.id)).toBeNull();
	});
});

describe('books: archiving', () => {
	it('archives and restores', async () => {
		const created = ok(await createBook(sql, owner, { title: 'The Sample Saga' }), 'create').record;
		ok(await setBookArchived(sql, owner, created.id, true), 'archive');
		expect((await listBooks(sql, owner, {})).map((b) => b.id)).toEqual([]);
		expect((await getBook(sql, owner, created.id))?.archivedAt).not.toBeNull();

		ok(await setBookArchived(sql, owner, created.id, false), 'restore');
		expect((await listBooks(sql, owner, {})).map((b) => b.id)).toEqual([created.id]);
	});
});

describe('through a client configured the way the app’s is', () => {
	it('creates, edits and archives a book without a raw Date parameter reaching the wire', async () => {
		// `$lib/server/db` hands its client to drizzle(), which replaces the
		// driver's timestamp serializers with pass-throughs — a JS Date sent as
		// a parameter then reaches the wire unconverted and throws. This is the
		// client shape the app actually runs with (hard rule 2).
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createBook(appLike, owner, {
					title: 'The Sample Saga',
					releaseDate: '2025-06-01',
					seriesName: 'The Sample Chronicles',
					seriesPosition: 1,
					authorNames: 'Fictional Author'
				}),
				'create through the app-like client'
			).record;

			const updated = ok(
				await updateBook(
					appLike,
					owner,
					created.id,
					{ status: 'read', releaseDate: '2025-07-04' },
					created.updatedAt
				),
				'edit through the app-like client'
			).record;
			expect(updated).toMatchObject({ status: 'read', releaseDate: '2025-07-04' });

			const archived = ok(
				await setBookArchived(appLike, owner, created.id, true, updated.updatedAt),
				'archive through the app-like client'
			).record;
			expect(archived.archivedAt).not.toBeNull();
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
