import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	ARCHIVE_KINDS,
	ARCHIVE_TABLES,
	NOT_IN_THE_ARCHIVE,
	archivedCounts,
	createArea,
	createAssessment,
	createAuthor,
	createBill,
	createBook,
	createBookSeries,
	createDailyLog,
	createEvent,
	createGenre,
	createGoal,
	createHabit,
	createHealthMeasurement,
	createHealthTerm,
	createImportantDate,
	createIngredient,
	createLabMarker,
	createLabResult,
	createLibraryItem,
	createMedicalVisit,
	createMedication,
	createPerson,
	createProject,
	createRecipe,
	createTag,
	createTask,
	createWishlistItem,
	listArchived,
	listLabMarkers,
	listMedicalVisits,
	listMedications,
	listTasks,
	restore,
	setAreaArchived,
	setAuthorArchived,
	setBookArchived,
	setBookSeriesArchived,
	setDailyLogArchived,
	setGenreArchived,
	setGoalArchived,
	setHabitArchived,
	setHealthMeasurementArchived,
	setHealthTermArchived,
	setImportantDateArchived,
	setLabMarkerArchived,
	setLabResultArchived,
	setMedicalVisitArchived,
	setMedicationArchived,
	setProjectArchived,
	setRecipeArchived,
	setTagArchived,
	setTaskArchived,
	type ArchiveKind,
	type Queryable
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';
import { routeMatchers } from './route-matchers';

/**
 * The archive is the other half of "nothing is deleted". These cover the two
 * ways that promise can be broken: something archived that cannot be found
 * again, and something restorable by someone who may not write it.
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

/** Left out, each kind's own default; given, the same ownership for every record. */
type Ownership =
	{ visibility: 'private' | 'household'; ownerUserId: string } | Record<string, never>;

/**
 * One record of every archivable kind, all in the viewer's household.
 *
 * Made through each kind's own create path wherever there is one, so a kind
 * cannot pass here by being inserted in a shape the application never writes.
 * Three have none: a meal plan's day is opened by planning a meal (always
 * household-wide there), and prep and the watchlist only ever arrive from the
 * import — those are inserted with the columns the importer writes.
 */
async function oneOfEach(
	viewer: Viewer,
	own: Ownership = {}
): Promise<Record<ArchiveKind, string>> {
	const owner = 'ownerUserId' in own ? own.ownerUserId : null;
	const visibility = 'visibility' in own ? own.visibility : 'household';
	const made = async <T extends { ok: boolean }>(result: Promise<T>, kind: ArchiveKind) =>
		(ok(await result, `create ${kind}`) as unknown as { record: { id: string } }).record.id;
	const inserted = async (rows: Promise<{ id: string }[]>) => one(await rows).id;

	const marker = await made(
		createLabMarker(sql, viewer, { name: 'Ferritin', units: 'ug/L', ...own }),
		'lab_marker'
	);

	return {
		task: await made(createTask(sql, viewer, { title: 'Renew passport', ...own }), 'task'),
		project: await made(createProject(sql, viewer, { name: 'Garden shed', ...own }), 'project'),
		goal: await made(createGoal(sql, viewer, { title: 'Run 10k', ...own }), 'goal'),
		area: await made(createArea(sql, viewer, { name: 'Home', ...own }), 'area'),
		habit: await made(createHabit(sql, viewer, { name: 'Stretch', ...own }), 'habit'),
		// Tags carry no owner or visibility to give them.
		tag: await made(createTag(sql, viewer, { name: 'errands' }), 'tag'),
		daily_log: await made(
			createDailyLog(sql, viewer, { onDate: '2026-04-17', note: 'Quiet day', ...own }),
			'daily_log'
		),
		important_date: await made(
			createImportantDate(sql, viewer, { title: 'Anniversary', onDate: '2026-06-02', ...own }),
			'important_date'
		),
		significant_event: await made(
			createEvent(sql, viewer, { title: 'Moved house', onDate: '2026-02-14', ...own }),
			'significant_event'
		),
		life_assessment: await made(
			createAssessment(sql, viewer, {
				focus: 'Health',
				rating: 6,
				period: 'Q1',
				year: 2026,
				...own
			}),
			'life_assessment'
		),
		medication: await made(
			createMedication(sql, viewer, { name: 'Vitamin D', type: 'supplement', ...own }),
			'medication'
		),
		medical_visit: await made(
			createMedicalVisit(sql, viewer, {
				reason: 'Follow up',
				visitDate: '2026-04-17',
				visitTime: '09:30',
				...own
			}),
			'medical_visit'
		),
		lab_marker: marker,
		lab_result: await made(
			createLabResult(sql, viewer, {
				markerId: marker,
				resultDate: '2026-04-10',
				value: 42.5,
				...own
			}),
			'lab_result'
		),
		health_measurement: await made(
			createHealthMeasurement(sql, viewer, {
				measuredAt: '2026-04-17T07:15',
				weight: 70,
				weightUnit: 'kg',
				...own
			}),
			'health_measurement'
		),
		health_term: await made(
			createHealthTerm(sql, viewer, { kind: 'symptom', name: 'Headache', ...own }),
			'health_term'
		),
		recipe: await made(createRecipe(sql, viewer, { name: 'Lentil soup', ...own }), 'recipe'),
		ingredient: await made(
			createIngredient(sql, viewer, { name: 'Red lentils', ...own }),
			'ingredient'
		),
		meal_plan: await inserted(sql<{ id: string }[]>`
			insert into meal_plans (household_id, owner_user_id, visibility, on_date, created_by)
			values (${viewer.householdId}::uuid, ${owner}::uuid, ${visibility}, '2026-04-18',
			        ${viewer.userId}::uuid)
			returning id
		`),
		prep_task: await inserted(sql<{ id: string }[]>`
			insert into prep_tasks (household_id, owner_user_id, visibility, name, created_by)
			values (${viewer.householdId}::uuid, ${owner}::uuid, ${visibility}, 'Soak the beans',
			        ${viewer.userId}::uuid)
			returning id
		`),
		library_item: await made(
			createLibraryItem(sql, viewer, { title: 'A field guide to moss', ...own }),
			'library_item'
		),
		person: await made(createPerson(sql, viewer, { name: 'Robin Quill', ...own }), 'person'),
		wishlist_item: await made(
			createWishlistItem(sql, viewer, { name: 'Rain jacket', ...own }),
			'wishlist_item'
		),
		media_item: await inserted(sql<{ id: string }[]>`
			insert into media_items (household_id, owner_user_id, visibility, name, created_by)
			values (${viewer.householdId}::uuid, ${owner}::uuid, ${visibility}, 'Harbour Lights',
			        ${viewer.userId}::uuid)
			returning id
		`),
		bill: await made(createBill(sql, viewer, { name: 'Internet', ...own }), 'bill'),
		book: await made(createBook(sql, viewer, { title: 'The Sample Saga', ...own }), 'book'),
		// Authors, series and genres carry no owner or visibility to give them,
		// the same as tags above.
		author: await made(createAuthor(sql, viewer, { name: 'Fictional Author' }), 'author'),
		book_series: await made(
			createBookSeries(sql, viewer, { name: 'The Sample Chronicles' }),
			'book_series'
		),
		genre: await made(createGenre(sql, viewer, { name: 'Speculative Fiction' }), 'genre')
	};
}

/** What each of {@link oneOfEach}'s records is called in the archive. */
const TITLES: Record<ArchiveKind, string> = {
	task: 'Renew passport',
	project: 'Garden shed',
	goal: 'Run 10k',
	area: 'Home',
	habit: 'Stretch',
	tag: 'errands',
	daily_log: 'Friday 17 Apr 2026',
	important_date: 'Anniversary',
	significant_event: 'Moved house',
	life_assessment: 'Health — Q1 2026',
	medication: 'Vitamin D',
	medical_visit: 'Follow up — 17 Apr 2026',
	lab_marker: 'Ferritin',
	lab_result: 'Ferritin 42.5 ug/L — 10 Apr 2026',
	// In the household's zone, which is where it was entered: not 11:15 UTC.
	health_measurement: 'Reading — 17 Apr 2026, 07:15',
	health_term: 'Headache',
	recipe: 'Lentil soup',
	ingredient: 'Red lentils',
	meal_plan: 'Meal plan — 18 Apr 2026',
	prep_task: 'Soak the beans',
	library_item: 'A field guide to moss',
	person: 'Robin Quill',
	wishlist_item: 'Rain jacket',
	media_item: 'Harbour Lights',
	bill: 'Internet',
	book: 'The Sample Saga',
	author: 'Fictional Author',
	book_series: 'The Sample Chronicles',
	genre: 'Speculative Fiction'
};

type Archiver = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean
) => Promise<{ ok: boolean }>;

/** The archive action each page actually calls, for the kinds that have one. */
const ARCHIVERS: Partial<Record<ArchiveKind, Archiver>> = {
	task: setTaskArchived,
	project: setProjectArchived,
	goal: setGoalArchived,
	area: setAreaArchived,
	habit: setHabitArchived,
	tag: setTagArchived,
	daily_log: setDailyLogArchived,
	important_date: setImportantDateArchived,
	medication: setMedicationArchived,
	medical_visit: setMedicalVisitArchived,
	lab_marker: setLabMarkerArchived,
	lab_result: setLabResultArchived,
	health_measurement: setHealthMeasurementArchived,
	health_term: setHealthTermArchived,
	recipe: setRecipeArchived,
	book: setBookArchived,
	author: setAuthorArchived,
	book_series: setBookSeriesArchived,
	genre: setGenreArchived
};

async function archiveEach(viewer: Viewer, ids: Record<ArchiveKind, string>) {
	for (const kind of ARCHIVE_KINDS) {
		const archiver = ARCHIVERS[kind];
		if (archiver) ok(await archiver(sql, viewer, ids[kind], true), `archive ${kind}`);
		// No page archives these yet; the importer brings them in archived, and
		// this is the state its rows arrive in.
		else
			await sql`update ${sql(ARCHIVE_TABLES[kind])} set archived_at = now() where id = ${ids[kind]}::uuid`;
	}
}

const every = (n: number) => Object.fromEntries(ARCHIVE_KINDS.map((kind) => [kind, n]));

describe('the archive', () => {
	it('finds an archived task and offers it back', async () => {
		const task = ok(await createTask(sql, owner, { title: 'Old thing' }), 'create task');
		ok(await setTaskArchived(sql, owner, task.record.id, true), 'archive');

		const archived = await listArchived(sql, owner);
		expect(archived).toHaveLength(1);
		expect(archived[0]).toMatchObject({ kind: 'task', title: 'Old thing' });
		expect(archived[0]?.path).toBe(`/tasks/${task.record.id}`);
	});

	it('does not list live records', async () => {
		ok(await createTask(sql, owner, { title: 'Still going' }), 'create task');
		expect(await listArchived(sql, owner)).toEqual([]);
	});

	it('restores a record back into the live views', async () => {
		const task = ok(await createTask(sql, owner, { title: 'Back please' }), 'create task');
		ok(await setTaskArchived(sql, owner, task.record.id, true), 'archive');

		expect(await listTasks(sql, owner, { status: 'open' })).toHaveLength(0);

		const back = await restore(sql, owner, 'task', task.record.id);
		expect(back).toMatchObject({ ok: true });

		expect((await listTasks(sql, owner, { status: 'open' })).map((t) => t.title)).toEqual([
			'Back please'
		]);
		expect(await listArchived(sql, owner)).toEqual([]);
	});

	it('spans every kind that can be archived', async () => {
		const task = ok(await createTask(sql, owner, { title: 'A task' }), 'create task');
		const area = ok(await createArea(sql, owner, { name: 'An area' }), 'create area');
		const tag = ok(await createTag(sql, owner, { name: 'A tag' }), 'create tag');

		ok(await setTaskArchived(sql, owner, task.record.id, true), 'archive task');
		await sql`update areas set archived_at = now() where id = ${area.record.id}::uuid`;
		ok(await setTagArchived(sql, owner, tag.record.id, true), 'archive tag');

		const counts = await archivedCounts(sql, owner);
		expect(counts).toMatchObject({ task: 1, area: 1, tag: 1, goal: 0, project: 0, habit: 0 });

		const kinds = (await listArchived(sql, owner)).map((r) => r.kind).sort();
		expect(kinds).toEqual(['area', 'tag', 'task']);
	});

	it('gives a tag no link, because it has no page of its own', async () => {
		const tag = ok(await createTag(sql, owner, { name: 'Orphan' }), 'create tag');
		ok(await setTagArchived(sql, owner, tag.record.id, true), 'archive tag');
		expect((await listArchived(sql, owner))[0]?.path).toBeNull();
	});

	it('filters to one kind and by name', async () => {
		const a = ok(await createTask(sql, owner, { title: 'Compost bins' }), 'create task');
		const b = ok(await createTask(sql, owner, { title: 'Ferry tickets' }), 'create task');
		ok(await setTaskArchived(sql, owner, a.record.id, true), 'archive a');
		ok(await setTaskArchived(sql, owner, b.record.id, true), 'archive b');

		expect((await listArchived(sql, owner, { search: 'ferry' })).map((r) => r.title)).toEqual([
			'Ferry tickets'
		]);
		expect(await listArchived(sql, owner, { kinds: ['goal'] })).toEqual([]);
	});

	describe('privacy', () => {
		it('never lists another member’s private record', async () => {
			const theirs = ok(
				await createTask(sql, partner, {
					title: 'Private matter',
					visibility: 'private',
					ownerUserId: partner.userId
				}),
				'create task'
			);
			ok(await setTaskArchived(sql, partner, theirs.record.id, true), 'archive');

			expect(owner.role).toBe('admin');
			expect(await listArchived(sql, owner)).toEqual([]);
			expect((await archivedCounts(sql, owner)).task).toBe(0);
			expect(await listArchived(sql, partner)).toHaveLength(1);
		});

		it('refuses to restore a record the viewer may not write', async () => {
			const theirs = ok(
				await createTask(sql, partner, {
					title: 'Private matter',
					visibility: 'private',
					ownerUserId: partner.userId
				}),
				'create task'
			);
			ok(await setTaskArchived(sql, partner, theirs.record.id, true), 'archive');

			expect(await restore(sql, owner, 'task', theirs.record.id)).toMatchObject({
				ok: false,
				reason: 'not_found'
			});
			// And it is genuinely still archived, not merely reported as refused.
			expect(await listArchived(sql, partner)).toHaveLength(1);
		});

		it('refuses to restore a shared record belonging to the other member', async () => {
			// The boundary that actually separates the read scope from the write
			// scope. A private record is excluded by both, so testing only that
			// case lets `restore` fall back to the read scope unnoticed: this is
			// household-visible — the owner can SEE it in the archive — but it is
			// the partner's, so putting it back is not theirs to do.
			const theirs = ok(
				await createTask(sql, partner, {
					title: 'Shared but theirs',
					visibility: 'household',
					ownerUserId: partner.userId
				}),
				'create task'
			);
			ok(await setTaskArchived(sql, partner, theirs.record.id, true), 'archive');

			expect((await listArchived(sql, owner)).map((r) => r.title)).toEqual(['Shared but theirs']);

			expect(await restore(sql, owner, 'task', theirs.record.id)).toMatchObject({
				ok: false,
				reason: 'not_found'
			});
			expect(await listArchived(sql, partner)).toHaveLength(1);

			// The person it belongs to can still restore it.
			expect(await restore(sql, partner, 'task', theirs.record.id)).toMatchObject({ ok: true });
		});

		it('never crosses a household boundary', async () => {
			const task = ok(await createTask(sql, owner, { title: 'Ours' }), 'create task');
			ok(await setTaskArchived(sql, owner, task.record.id, true), 'archive');

			const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };
			expect(await listArchived(sql, elsewhere)).toEqual([]);
			expect(await restore(sql, elsewhere, 'task', task.record.id)).toMatchObject({ ok: false });
		});
	});
});

describe('every kind the archive holds', () => {
	it('is found, named, and restored back into the live views', async () => {
		const ids = await oneOfEach(owner);
		await archiveEach(owner, ids);

		const archived = await listArchived(sql, owner, { limit: 300 });
		expect(Object.fromEntries(archived.map((r) => [r.kind, r.title]))).toEqual(TITLES);
		for (const record of archived) expect(record.id, record.kind).toBe(ids[record.kind]);
		expect(await archivedCounts(sql, owner)).toEqual(every(1));

		for (const kind of ARCHIVE_KINDS) {
			expect(await restore(sql, owner, kind, ids[kind]), kind).toMatchObject({ ok: true });
		}

		expect(await listArchived(sql, owner, { limit: 300 })).toEqual([]);
		expect(await archivedCounts(sql, owner)).toEqual(every(0));
		for (const kind of ARCHIVE_KINDS) {
			const [row] = await sql<{ archived_at: unknown }[]>`
				select archived_at from ${sql(ARCHIVE_TABLES[kind])} where id = ${ids[kind]}::uuid
			`;
			expect(row?.archived_at, `${kind} is still archived`).toBeNull();
		}

		// And back on the health pages that archived them, which have no way of
		// their own to bring back a medication archived by mistake.
		expect((await listMedications(sql, owner)).map((m) => m.id)).toEqual([ids.medication]);
		expect((await listMedicalVisits(sql, owner)).map((v) => v.id)).toEqual([ids.medical_visit]);
		expect((await listLabMarkers(sql, owner)).map((m) => m.id)).toEqual([ids.lab_marker]);
	});

	it('links each one to a page that exists and shows it', async () => {
		const ids = await oneOfEach(owner);
		await archiveEach(owner, ids);

		const routes = routeMatchers();
		const paths = Object.fromEntries(
			(await listArchived(sql, owner, { limit: 300 })).map((r) => [r.kind, r.path])
		) as Record<ArchiveKind, string | null>;

		for (const kind of ARCHIVE_KINDS) {
			// Tags have no page of their own; see the tag case above.
			if (kind === 'tag') continue;
			const path = paths[kind];
			expect(path, `${kind} has no link`).not.toBeNull();
			expect(
				routes.some((r) => r.test(path!)),
				`${kind} -> ${path} matches no route`
			).toBe(true);
		}

		// A detail link has to name the record, not merely a route that exists.
		expect(paths.medical_visit).toBe(`/health/visits/${ids.medical_visit}`);
		expect(paths.lab_marker).toBe(`/health/labs/${ids.lab_marker}`);
		expect(paths.lab_result).toBe(`/health/labs/${ids.lab_marker}`);
		expect(paths.library_item).toBe(`/library/${ids.library_item}`);
		expect(paths.recipe).toBe(`/food/recipes/${ids.recipe}`);
		expect(paths.daily_log).toBe('/journal/2026-04-17');
		expect(paths.book).toBe(`/reading/books/${ids.book}`);
		expect(paths.author).toBe(`/reading/authors/${ids.author}`);
		expect(paths.book_series).toBe(`/reading/series/${ids.book_series}`);
		// Genre has no page of its own; /reading/genres is the list that shows
		// it, the same way ingredients and prep tasks link to a list rather than
		// a page named after the record.
		expect(paths.genre).toBe('/reading/genres');
	});

	it('searches the titles as shown, including ones built from several columns', async () => {
		const ids = await oneOfEach(owner);
		await archiveEach(owner, ids);

		const found = await listArchived(sql, owner, { search: 'ferritin' });
		expect(found.map((r) => r.kind).sort()).toEqual(['lab_marker', 'lab_result']);
		expect((await listArchived(sql, owner, { search: 'follow up' })).map((r) => r.kind)).toEqual([
			'medical_visit'
		]);
	});
});

describe('every table carrying archived_at', () => {
	it('is in the archive, or names why not', async () => {
		const rows = await sql<{ table_name: string }[]>`
			select table_name from information_schema.columns
			where table_schema = 'public' and column_name = 'archived_at'
			order by table_name
		`;
		const archivable = rows.map((r) => r.table_name);
		const sources = new Set(Object.values(ARCHIVE_TABLES));
		const excused = (table: string) => Object.hasOwn(NOT_IN_THE_ARCHIVE, table);

		// The failure this catches: medications, lab markers and visits each got
		// an Archive button on their own pages and the archive knew about none of
		// them, so "recoverable" held only for the six kinds of the first slice.
		const missing = archivable.filter((t) => !sources.has(t) && !excused(t));
		expect(
			missing,
			`archivable, but neither in the archive nor excused: ${missing.join(', ')}`
		).toEqual([]);

		// And the exceptions stay honest: each is still archivable, is not also a
		// source, and actually says why.
		for (const [table, reason] of Object.entries(NOT_IN_THE_ARCHIVE)) {
			expect(archivable, `${table} is excused but carries no archived_at`).toContain(table);
			expect(sources.has(table), `${table} is both in the archive and excused`).toBe(false);
			expect(reason.trim().length, `${table} is excused without a reason`).toBeGreaterThan(20);
		}
	});
});

describe('privacy, for every kind', () => {
	it('never lists or restores another member’s private record', async () => {
		// Their private medication, visit, lab result, reading, journal day… —
		// every kind that can be private at all.
		const theirs = await oneOfEach(partner, { visibility: 'private', ownerUserId: partner.userId });
		await archiveEach(partner, theirs);

		expect(owner.role).toBe('admin');
		// Tags have no owner and are shared by design, so they are the one kind
		// the other member may see here.
		expect((await listArchived(sql, owner, { limit: 300 })).map((r) => r.kind)).toEqual(['tag']);
		expect(await archivedCounts(sql, owner)).toEqual({ ...every(0), tag: 1 });

		for (const kind of ARCHIVE_KINDS) {
			if (kind === 'tag') continue;
			expect(await restore(sql, owner, kind, theirs[kind]), kind).toMatchObject({
				ok: false,
				reason: 'not_found'
			});
		}
		// Genuinely still archived, not merely reported as refused.
		expect(await archivedCounts(sql, partner)).toEqual(every(1));
	});

	it('lists the other member’s shared records but restores none of them', async () => {
		// The boundary between the read scope and the write scope, for every kind:
		// household-visible, so the owner may see each one, but the partner's, so
		// putting it back is not the owner's to do.
		const theirs = await oneOfEach(partner, {
			visibility: 'household',
			ownerUserId: partner.userId
		});
		await archiveEach(partner, theirs);

		// A journal day stays its author's even when its row says household, as
		// it does in search.
		const seen = (await listArchived(sql, owner, { limit: 300 })).map((r) => r.kind).sort();
		expect(seen).toEqual(ARCHIVE_KINDS.filter((k) => k !== 'daily_log').sort());

		for (const kind of ARCHIVE_KINDS) {
			// Household-wide: either member may restore a tag.
			if (kind === 'tag') continue;
			expect(await restore(sql, owner, kind, theirs[kind]), kind).toMatchObject({
				ok: false,
				reason: 'not_found'
			});
		}
		expect(await archivedCounts(sql, partner)).toEqual(every(1));

		// The person they belong to can still restore every one.
		for (const kind of ARCHIVE_KINDS) {
			expect(await restore(sql, partner, kind, theirs[kind]), kind).toMatchObject({ ok: true });
		}
	});

	it('names a lab result by its marker only for someone who may read the marker', async () => {
		// A household-visible result under a marker its owner keeps private: the
		// result is readable in its own right, the marker's name is not.
		const marker = ok(
			await createLabMarker(sql, partner, {
				name: 'Confidential panel',
				visibility: 'private',
				ownerUserId: partner.userId
			}),
			'create marker'
		).record;
		const result = ok(
			await createLabResult(sql, partner, {
				markerId: marker.id,
				resultDate: '2026-04-10',
				value: 3
			}),
			'create result'
		).record;
		ok(await setLabResultArchived(sql, partner, result.id, true), 'archive result');

		const seen = await listArchived(sql, owner);
		expect(seen).toMatchObject([{ kind: 'lab_result', title: 'Lab result 3 — 10 Apr 2026' }]);
		// And no link to a marker page they could not open.
		expect(seen[0]?.path).toBeNull();
		expect(await listArchived(sql, owner, { search: 'confidential' })).toEqual([]);

		expect((await listArchived(sql, partner)).map((r) => r.title)).toEqual([
			'Confidential panel 3 — 10 Apr 2026'
		]);
	});

	it('never crosses a household boundary, for any kind', async () => {
		const ids = await oneOfEach(owner);
		await archiveEach(owner, ids);

		// The same person in another household: the household predicate is all
		// that stands in the way, even for the kinds scoped by owner.
		const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };
		expect(await listArchived(sql, elsewhere, { limit: 300 })).toEqual([]);
		expect(await archivedCounts(sql, elsewhere)).toEqual(every(0));
		for (const kind of ARCHIVE_KINDS) {
			expect(await restore(sql, elsewhere, kind, ids[kind]), kind).toMatchObject({ ok: false });
		}
		expect(await archivedCounts(sql, owner)).toEqual(every(1));
	});
});
