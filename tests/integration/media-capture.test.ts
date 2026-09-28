import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createMediaItem,
	getMediaItem,
	listMediaViewings,
	logMediaViewing,
	mediaStreamingServices,
	pickMediaToWatch,
	setMediaItemArchived,
	updateMediaItem
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The watchlist's full edit, per-viewing history, and "what should we watch?"
 * picker (PACK5-001, migration 0025). `collections.test.ts` keeps the
 * pre-existing `setMediaStatus`/`listMedia` coverage; this file is everything
 * feature 1-4 of plan §13 added on top of that, in its own file the way the
 * People pack's `people.test.ts` sits apart from `collections.test.ts` rather
 * than growing it.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
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

	const [other] = await sql<{ id: string }[]>`
		insert into households (name) values ('Next door') returning id
	`;
	elsewhere = viewerOf(
		{
			id: admin.id,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		other!.id
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

const title = (name: string, extra: object = {}, who = owner) =>
	createMediaItem(sql, who, { name, ...extra });

describe('adding a title', () => {
	it('needs only a name, and defaults to a household-shared want-to-watch', async () => {
		const created = ok(await title('Sample Show Alpha'), 'add a title').record;
		expect(created).toMatchObject({
			name: 'Sample Show Alpha',
			mediaType: 'other',
			status: 'want_to_watch',
			visibility: 'household',
			ownerUserId: null,
			timesWatched: 0,
			isFavourite: false,
			watchAgain: false
		});
	});

	it('takes every optional field feature 1 offers', async () => {
		const created = ok(
			await title('Sample Show Beta', {
				mediaType: 'tv',
				status: 'watching',
				streamingService: 'Testflix',
				genre: 'Drama',
				releaseYear: 2019,
				totalSeasons: 4
			}),
			'add a title'
		).record;
		expect(created).toMatchObject({
			mediaType: 'tv',
			status: 'watching',
			streamingService: 'Testflix',
			genre: 'Drama',
			releaseYear: 2019,
			totalSeasons: 4
		});
	});

	it('refuses a blank name and an unknown type', async () => {
		expect(await title('')).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await title('Sample Show Gamma', { mediaType: 'podcast' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});
});

describe('editing a title fully', () => {
	it('patches progress, rating, favourite, watch again and why saved, leaving the rest', async () => {
		const created = ok(await title('Sample Show Delta', { mediaType: 'tv' }), 'add').record;

		const edited = ok(
			await updateMediaItem(sql, owner, created.id, {
				currentSeason: 2,
				currentEpisode: 5,
				rating: 4,
				isFavourite: true,
				watchAgain: true,
				whySaved: 'a placeholder reason',
				startedOn: '2026-01-05',
				finishedOn: '2026-02-01'
			}),
			'edit'
		).record;

		expect(edited).toMatchObject({
			name: 'Sample Show Delta',
			currentSeason: 2,
			currentEpisode: 5,
			rating: 4,
			isFavourite: true,
			watchAgain: true,
			whySaved: 'a placeholder reason',
			startedOn: '2026-01-05',
			finishedOn: '2026-02-01'
		});
	});

	it('changes status as a plain field, with no increment of its own', async () => {
		const created = ok(await title('Sample Show Epsilon', { status: 'watching' }), 'add').record;

		const edited = ok(
			await updateMediaItem(sql, owner, created.id, { status: 'watched' }),
			'edit status'
		).record;

		// Unlike setMediaStatus, a plain field edit does not itself count as a
		// watch -- logMediaViewing and the queue's own quick action are the two
		// places that increment, and this is neither.
		expect(edited.status).toBe('watched');
		expect(edited.timesWatched).toBe(0);
		expect(edited.lastWatchedAt).toBeNull();
	});

	it('clears a rating back to "not rated" and unsets the checkboxes', async () => {
		const created = ok(await title('Sample Show Zeta'), 'add').record;
		await updateMediaItem(sql, owner, created.id, { rating: 5, isFavourite: true });

		const cleared = ok(
			await updateMediaItem(sql, owner, created.id, { rating: '', isFavourite: false }),
			'clear'
		).record;
		expect(cleared.rating).toBeNull();
		expect(cleared.isFavourite).toBe(false);
	});

	it('refuses a rating outside 1-5', async () => {
		const created = ok(await title('Sample Show Eta'), 'add').record;
		expect(await updateMediaItem(sql, owner, created.id, { rating: 9 })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('conflicts on a stale version and explains a concurrent edit', async () => {
		const created = ok(await title('Sample Show Theta'), 'add').record;
		await updateMediaItem(sql, owner, created.id, { genre: 'Comedy' });

		const stale = await updateMediaItem(
			sql,
			owner,
			created.id,
			{ genre: 'Horror' },
			created.updatedAt
		);
		expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('is 404 for a private title owned by someone else, and 403 for a shared one owned by them', async () => {
		const privateOne = ok(
			await createMediaItem(sql, owner, {
				name: 'Sample Show Iota',
				ownerUserId: owner.userId,
				visibility: 'private'
			}),
			'add private'
		).record;
		expect(await updateMediaItem(sql, partner, privateOne.id, { genre: 'X' })).toMatchObject({
			ok: false,
			reason: 'not_found'
		});

		const sharedButOwned = ok(
			await createMediaItem(sql, owner, {
				name: 'Sample Show Kappa',
				ownerUserId: owner.userId,
				visibility: 'household'
			}),
			'add shared-but-owned'
		).record;
		expect(await updateMediaItem(sql, partner, sharedButOwned.id, { genre: 'X' })).toMatchObject({
			ok: false,
			reason: 'forbidden'
		});
		// The partner can still see it, which is what makes 403 the honest
		// answer here rather than 404.
		expect(await getMediaItem(sql, partner, sharedButOwned.id)).not.toBeNull();
	});

	it('never reaches another household', async () => {
		const created = ok(await title('Sample Show Lambda'), 'add').record;
		expect(await getMediaItem(sql, elsewhere, created.id)).toBeNull();
		expect(await updateMediaItem(sql, elsewhere, created.id, { genre: 'X' })).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});
});

describe('archiving a title', () => {
	it('archives and restores, leaving the viewing history untouched', async () => {
		const created = ok(await title('Sample Show Mu'), 'add').record;
		await logMediaViewing(sql, owner, created.id, { watchedOn: '2026-01-01' });

		const archived = ok(await setMediaItemArchived(sql, owner, created.id, true), 'archive').record;
		expect(archived.archivedAt).toBeInstanceOf(Date);

		const restored = ok(
			await setMediaItemArchived(sql, owner, created.id, false),
			'restore'
		).record;
		expect(restored.archivedAt).toBeNull();
		expect(await listMediaViewings(sql, owner, created.id)).toHaveLength(1);
	});
});

describe('streaming services in use', () => {
	it('lists distinct services, scoped to the household', async () => {
		await title('Sample Show Nu', { streamingService: 'Testflix' });
		await title('Sample Show Xi', { streamingService: 'Testflix' });
		await title('Sample Show Omicron', { streamingService: 'PrimeSample' });
		await title('Sample Show Pi', {}, elsewhere);

		expect(await mediaStreamingServices(sql, owner)).toEqual(['PrimeSample', 'Testflix']);
		expect(await mediaStreamingServices(sql, elsewhere)).toEqual([]);
	});
});

describe('logging a viewing', () => {
	it('adds to an imported times_watched rather than replacing it, and stamps last_watched_at', async () => {
		// Seeded the way the importer would have left it: a history of two
		// watches with no viewing rows behind either of them.
		const created = ok(await title('Sample Show Rho', { status: 'watched' }), 'add').record;
		await sql`update media_items set times_watched = 2 where id = ${created.id}::uuid`;

		const logged = ok(
			await logMediaViewing(sql, owner, created.id, {
				watchedOn: '2026-03-01',
				season: 1,
				episode: 4,
				note: 'a placeholder note'
			}),
			'log a viewing'
		).record;
		expect(logged).toMatchObject({
			mediaItemId: created.id,
			watchedOn: '2026-03-01',
			season: 1,
			episode: 4
		});

		const item = await getMediaItem(sql, owner, created.id);
		// 2 (imported) + 1 (this viewing), never recomputed as a count of rows.
		expect(item?.timesWatched).toBe(3);
		expect(item?.lastWatchedAt).toBeInstanceOf(Date);
	});

	it('moves last_watched_at forward for a later viewing, and never backward for a backfilled one', async () => {
		const created = ok(await title('Sample Show Sigma'), 'add').record;

		await logMediaViewing(sql, owner, created.id, { watchedOn: '2026-05-10' });
		const afterRecent = await getMediaItem(sql, owner, created.id);
		const recentStamp = afterRecent!.lastWatchedAt!.getTime();

		// A viewing logged afterwards but dated *before* the one above must not
		// undo how recent last_watched_at already is.
		await logMediaViewing(sql, owner, created.id, { watchedOn: '2020-01-01' });
		const afterBackfill = await getMediaItem(sql, owner, created.id);
		expect(afterBackfill!.lastWatchedAt!.getTime()).toBe(recentStamp);
		expect(afterBackfill!.timesWatched).toBe(2);
	});

	it('logs and lists through a client configured the way the app’s is', async () => {
		// $lib/server/db hands its client to drizzle(), which replaces the
		// driver's timestamp serializers with pass-throughs -- a JS Date sent
		// as a parameter then reaches the wire unconverted and throws. The
		// plain client every other test in this file uses hides that, because
		// it converts a Date without complaint; this one does not.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createMediaItem(appLike, owner, { name: 'Sample Show Tau' }),
				'add through the app-like client'
			).record;
			const logged = ok(
				await logMediaViewing(appLike, owner, created.id, { watchedOn: '2026-04-02' }),
				'log a viewing through the app-like client'
			).record;
			expect(logged.watchedOn).toBe('2026-04-02');

			const item = await getMediaItem(appLike, owner, created.id);
			expect(item?.lastWatchedAt).toBeInstanceOf(Date);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});

	it('lists most-recent-first, scoped the same as the title itself', async () => {
		const created = ok(await title('Sample Show Upsilon'), 'add').record;
		await logMediaViewing(sql, owner, created.id, { watchedOn: '2026-01-01' });
		await logMediaViewing(sql, owner, created.id, { watchedOn: '2026-06-01' });

		const viewings = await listMediaViewings(sql, owner, created.id);
		expect(viewings.map((v) => v.watchedOn)).toEqual(['2026-06-01', '2026-01-01']);
		expect(await listMediaViewings(sql, elsewhere, created.id)).toEqual([]);
	});

	it('is 404 for a private title, and 403 for a shared one owned by someone else', async () => {
		const privateOne = ok(
			await createMediaItem(sql, owner, {
				name: 'Sample Show Phi',
				ownerUserId: owner.userId,
				visibility: 'private'
			}),
			'add private'
		).record;
		expect(
			await logMediaViewing(sql, partner, privateOne.id, { watchedOn: '2026-01-01' })
		).toMatchObject({ ok: false, reason: 'not_found' });

		const sharedButOwned = ok(
			await createMediaItem(sql, owner, {
				name: 'Sample Show Chi',
				ownerUserId: owner.userId,
				visibility: 'household'
			}),
			'add shared-but-owned'
		).record;
		expect(
			await logMediaViewing(sql, partner, sharedButOwned.id, { watchedOn: '2026-01-01' })
		).toMatchObject({ ok: false, reason: 'forbidden' });
	});

	it('requires a date watched', async () => {
		const created = ok(await title('Sample Show Psi'), 'add').record;
		expect(await logMediaViewing(sql, owner, created.id, {})).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});
});

describe('what should we watch?', () => {
	it('only suggests want_to_watch, never something already started, dropped or archived', async () => {
		await title('Sample Pick Alpha', { status: 'want_to_watch' });
		await title('Sample Pick Beta', { status: 'watching' });
		await title('Sample Pick Gamma', { status: 'dropped' });
		const droppedArchive = ok(
			await title('Sample Pick Delta', { status: 'want_to_watch' }),
			'add'
		).record;
		await setMediaItemArchived(sql, owner, droppedArchive.id, true);

		const pick = await pickMediaToWatch(sql, owner, {}, () => 0);
		expect(pick?.name).toBe('Sample Pick Alpha');
	});

	it('uses the injected random source to choose deterministically', async () => {
		await title('Sample Pick Epsilon', { status: 'want_to_watch' });
		await title('Sample Pick Zeta', { status: 'want_to_watch' });
		await title('Sample Pick Eta', { status: 'want_to_watch' });
		// Sorted by name: Epsilon, Eta, Zeta. random() pinned near 1 picks the last.
		const last = await pickMediaToWatch(sql, owner, {}, () => 0.999999);
		expect(last?.name).toBe('Sample Pick Zeta');
		const first = await pickMediaToWatch(sql, owner, {}, () => 0);
		expect(first?.name).toBe('Sample Pick Epsilon');
	});

	it('filters by type and streaming service', async () => {
		await title('Sample Pick Theta', { status: 'want_to_watch', mediaType: 'movie' });
		await title('Sample Pick Iota', {
			status: 'want_to_watch',
			mediaType: 'tv',
			streamingService: 'Testflix'
		});

		expect((await pickMediaToWatch(sql, owner, { mediaType: 'movie' }))?.name).toBe(
			'Sample Pick Theta'
		);
		expect((await pickMediaToWatch(sql, owner, { streamingService: 'Testflix' }))?.name).toBe(
			'Sample Pick Iota'
		);
		expect(await pickMediaToWatch(sql, owner, { streamingService: 'Nobody Has This' })).toBeNull();
	});

	it('never suggests a title the viewer cannot read, and nothing from another household', async () => {
		await createMediaItem(sql, owner, {
			name: 'Sample Pick Kappa',
			status: 'want_to_watch',
			ownerUserId: owner.userId,
			visibility: 'private'
		});
		await title('Sample Pick Lambda', { status: 'want_to_watch' }, elsewhere);

		expect(await pickMediaToWatch(sql, partner, {})).toBeNull();
		expect(await pickMediaToWatch(sql, owner, {})).not.toBeNull();
		// Each household sees only its own: owner never sees Lambda, and
		// elsewhere never sees Kappa.
		expect((await pickMediaToWatch(sql, elsewhere, {}))?.name).toBe('Sample Pick Lambda');
	});

	it('returns null when nothing is left to suggest', async () => {
		expect(await pickMediaToWatch(sql, owner, {})).toBeNull();
	});
});
