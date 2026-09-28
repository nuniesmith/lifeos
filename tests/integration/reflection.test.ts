import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	archiveAssessment,
	archiveEvent,
	createArea,
	createAssessment,
	createDailyLog,
	createEvent,
	createGoal,
	getAssessment,
	getEvent,
	listAssessments,
	listEvents,
	unarchiveAssessment,
	unarchiveEvent,
	updateAssessment,
	updateEvent,
	updateGoal,
	yearInReview,
	yearsOnRecord
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Perspectives and the year in review (migration 0015).
 *
 * The claim worth testing is that the yearly figures are COMPUTED. A stored
 * rollup passes a test that inserts it and reads it back; a computed one has
 * to change when the underlying record changes, which is what these assert.
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

describe('the wheel of life', () => {
	it('records a rating against an area', async () => {
		const area = ok(await createArea(sql, owner, { name: 'Health' }), 'area').record;
		const rated = ok(
			await createAssessment(sql, owner, {
				focus: 'Physical health',
				rating: 6,
				period: 'Start of Year',
				year: 2026,
				areaId: area.id
			}),
			'assess'
		).record;

		expect(rated.rating).toBe(6);
		expect(rated.areaName).toBe('Health');
		// The focus is what the person named it, which is not the area's name:
		// the area is "Health" and the focus that year was "Physical health".
		expect(rated.focus).toBe('Physical health');
	});

	it('adds a rating with the year left blank, as the form sends it', async () => {
		// The add form's Year is optional and submits ''. That used to be read
		// as 0, which the table's CHECK (1900-2200) refused, so no rating could
		// be added without a year.
		const rated = ok(
			await createAssessment(sql, owner, { focus: 'Sleep', rating: 5, year: '', period: '' }),
			'assess with a blank year'
		).record;
		expect(rated.year).toBeNull();
	});

	it('refuses a year outside the range the table allows, as invalid rather than an error', async () => {
		expect(
			await createAssessment(sql, owner, { focus: 'Sleep', rating: 5, year: '150' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses a rating outside one to ten', async () => {
		for (const rating of [0, 11, -3]) {
			expect(await createAssessment(sql, owner, { focus: 'x', rating })).toMatchObject({
				ok: false,
				reason: 'invalid'
			});
		}
	});

	it('sorts the lowest first, because that is the point of the exercise', async () => {
		for (const [focus, rating] of [
			['Money', 3],
			['Work', 8],
			['Sleep', 5]
		] as const) {
			ok(await createAssessment(sql, owner, { focus, rating, year: 2026 }), focus);
		}
		expect((await listAssessments(sql, owner, { year: 2026 })).map((a) => a.focus)).toEqual([
			'Money',
			'Sleep',
			'Work'
		]);
	});

	it('is private by default, because a self-rating is about oneself', async () => {
		ok(await createAssessment(sql, owner, { focus: 'Money', rating: 3, year: 2026 }), 'assess');
		// The area may be shared; the score of it is not.
		expect(owner.role).toBe('admin');
		expect(await listAssessments(sql, partner, { year: 2026 })).toEqual([]);
		expect(await listAssessments(sql, owner, { year: 2026 })).toHaveLength(1);
	});
});

describe('editing a rating', () => {
	it('changes the fields that were sent and keeps the rest', async () => {
		const created = ok(
			await createAssessment(sql, owner, { focus: 'Fitness', rating: 4, year: 2026 }),
			'assess'
		).record;
		const area = ok(await createArea(sql, owner, { name: 'Career' }), 'area').record;

		const edited = ok(
			await updateAssessment(
				sql,
				owner,
				created.id,
				{ rating: 7, notes: 'Feeling better', areaId: area.id },
				created.updatedAt
			),
			'edit'
		).record;

		expect(edited.rating).toBe(7);
		expect(edited.notes).toBe('Feeling better');
		expect(edited.areaName).toBe('Career');
		// Untouched fields survive the partial edit.
		expect(edited.focus).toBe('Fitness');
		expect(edited.year).toBe(2026);
	});

	it('refuses a rating outside one to ten, the same as creating one', async () => {
		const created = ok(
			await createAssessment(sql, owner, { focus: 'Fitness', rating: 4 }),
			'assess'
		).record;
		expect(
			await updateAssessment(sql, owner, created.id, { rating: 11 }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses a stale edit as a conflict, not a silent overwrite', async () => {
		const created = ok(
			await createAssessment(sql, owner, { focus: 'Fitness', rating: 4 }),
			'assess'
		).record;
		ok(
			await updateAssessment(sql, owner, created.id, { rating: 5 }, created.updatedAt),
			'first edit'
		);

		// The same stale `updatedAt` a second, already-open tab would still have.
		expect(
			await updateAssessment(sql, owner, created.id, { rating: 9 }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('is a 404 for the other member, never a 403, because it is private', async () => {
		const created = ok(
			await createAssessment(sql, owner, { focus: 'Fitness', rating: 4 }),
			'assess'
		).record;
		expect(await getAssessment(sql, partner, created.id)).toBeNull();
		expect(
			await updateAssessment(sql, partner, created.id, { rating: 9 }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'not_found' });
	});

	it('ignores an area id that is not even a uuid rather than crashing on the cast', async () => {
		const created = ok(
			await createAssessment(sql, owner, { focus: 'Fitness', rating: 4 }),
			'assess'
		).record;
		const edited = ok(
			await updateAssessment(
				sql,
				owner,
				created.id,
				{ areaId: 'not-a-real-id' },
				created.updatedAt
			),
			'edit with a garbage area id'
		).record;
		expect(edited.areaId).toBeNull();
	});
});

describe('archiving a rating', () => {
	it('leaves the wheel and comes back on restore', async () => {
		const created = ok(
			await createAssessment(sql, owner, { focus: 'Fitness', rating: 4, year: 2026 }),
			'assess'
		).record;

		ok(await archiveAssessment(sql, owner, created.id), 'archive');
		expect(await listAssessments(sql, owner, { year: 2026 })).toEqual([]);
		// Archived is not gone: it can still be found and shown for restoring —
		// only the live views (`listAssessments`) leave it out.
		expect((await getAssessment(sql, owner, created.id))?.archivedAt).not.toBeNull();

		ok(await unarchiveAssessment(sql, owner, created.id), 'restore');
		expect((await listAssessments(sql, owner, { year: 2026 })).map((a) => a.id)).toEqual([
			created.id
		]);
	});
});

describe('significant events', () => {
	it('records something that happened on a day', async () => {
		const event = ok(
			await createEvent(sql, owner, { title: 'Adopted a greyhound', onDate: '2026-05-19' }),
			'event'
		).record;
		expect(event.onDate).toBe('2026-05-19');
		expect((await listEvents(sql, owner, { from: '2026-01-01', to: '2026-12-31' })).length).toBe(1);
	});

	it('refuses an event with no date, because it has nowhere to sit', async () => {
		expect(await createEvent(sql, owner, { title: 'Sometime' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('is shared, unlike a self-rating', async () => {
		ok(
			await createEvent(sql, owner, { title: 'Adopted a greyhound', onDate: '2026-05-19' }),
			'event'
		);
		expect(await listEvents(sql, partner)).toHaveLength(1);
	});
});

describe('editing an event', () => {
	it('changes the fields that were sent and keeps the rest', async () => {
		const created = ok(
			await createEvent(sql, owner, { title: 'Repainted the porch', onDate: '2026-04-01' }),
			'event'
		).record;
		const area = ok(await createArea(sql, owner, { name: 'Home' }), 'area').record;

		const edited = ok(
			await updateEvent(
				sql,
				owner,
				created.id,
				{ onDate: '2026-04-02', isFavourite: 'on', areaId: area.id },
				created.updatedAt
			),
			'edit'
		).record;

		expect(edited.onDate).toBe('2026-04-02');
		expect(edited.isFavourite).toBe(true);
		expect(edited.areaName).toBe('Home');
		// Untouched fields survive the partial edit.
		expect(edited.title).toBe('Repainted the porch');
	});

	it('refuses a malformed date, the same as creating one', async () => {
		const created = ok(
			await createEvent(sql, owner, { title: 'Repainted the porch', onDate: '2026-04-01' }),
			'event'
		).record;
		expect(
			await updateEvent(sql, owner, created.id, { onDate: 'not a date' }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses a stale edit as a conflict, not a silent overwrite', async () => {
		const created = ok(
			await createEvent(sql, owner, { title: 'Repainted the porch', onDate: '2026-04-01' }),
			'event'
		).record;
		ok(
			await updateEvent(
				sql,
				owner,
				created.id,
				{ title: 'Repainted the fence' },
				created.updatedAt
			),
			'first edit'
		);

		// The same stale `updatedAt` a second, already-open tab would still have.
		expect(
			await updateEvent(sql, owner, created.id, { title: 'Repainted the shed' }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('is editable by the other member too, because it is shared', async () => {
		const created = ok(
			await createEvent(sql, owner, { title: 'Repainted the porch', onDate: '2026-04-01' }),
			'event'
		).record;
		const edited = ok(
			await updateEvent(
				sql,
				partner,
				created.id,
				{ title: 'Repainted the fence' },
				created.updatedAt
			),
			'partner edits a shared event'
		).record;
		expect(edited.title).toBe('Repainted the fence');
	});

	it('ignores an area id that is not even a uuid rather than crashing on the cast', async () => {
		const created = ok(
			await createEvent(sql, owner, { title: 'Repainted the porch', onDate: '2026-04-01' }),
			'event'
		).record;
		const edited = ok(
			await updateEvent(sql, owner, created.id, { areaId: 'not-a-real-id' }, created.updatedAt),
			'edit with a garbage area id'
		).record;
		expect(edited.areaId).toBeNull();
	});
});

describe('archiving an event', () => {
	it('leaves the list and the year in review, and comes back on restore', async () => {
		const created = ok(
			await createEvent(sql, owner, { title: 'Repainted the porch', onDate: '2026-04-01' }),
			'event'
		).record;
		expect((await yearInReview(sql, owner, 2026)).events).toBe(1);

		ok(await archiveEvent(sql, owner, created.id), 'archive');
		expect(await listEvents(sql, owner, { from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
		// Archived is not gone: it can still be found and shown for restoring —
		// only the live views (`listEvents`, `yearInReview`) leave it out.
		expect((await getEvent(sql, owner, created.id))?.archivedAt).not.toBeNull();
		// The whole reason this figure is computed rather than a stored count:
		// archiving is exactly the kind of underlying change it must reflect.
		expect((await yearInReview(sql, owner, 2026)).events).toBe(0);

		ok(await unarchiveEvent(sql, owner, created.id), 'restore');
		expect((await yearInReview(sql, owner, 2026)).events).toBe(1);
	});

	it('moves out of the year in review when its date is edited off the year, not only when archived', async () => {
		const created = ok(
			await createEvent(sql, owner, { title: 'Repainted the porch', onDate: '2026-04-01' }),
			'event'
		).record;
		expect((await yearInReview(sql, owner, 2026)).events).toBe(1);

		ok(
			await updateEvent(sql, owner, created.id, { onDate: '2027-04-01' }, created.updatedAt),
			'move to next year'
		);
		expect((await yearInReview(sql, owner, 2026)).events).toBe(0);
		expect((await yearInReview(sql, owner, 2027)).events).toBe(1);
	});
});

describe('the year in review', () => {
	it('counts days logged from the logs themselves', async () => {
		for (const date of ['2026-01-05', '2026-06-01', '2026-12-31']) {
			ok(await createDailyLog(sql, owner, { onDate: date }), date);
		}
		// One outside the year, to prove the window is applied.
		ok(await createDailyLog(sql, owner, { onDate: '2025-12-31' }), 'prior year');

		expect((await yearInReview(sql, owner, 2026)).daysLogged).toBe(3);
	});

	it('changes when the underlying record changes, which a stored rollup would not', async () => {
		const goal = ok(await createGoal(sql, owner, { title: 'Lose weight' }), 'goal').record;
		expect((await yearInReview(sql, owner, 2026)).goalsAchieved).toBe(0);

		ok(
			await updateGoal(
				sql,
				owner,
				goal.id,
				{ status: 'achieved', achievedOn: '2026-03-01' },
				goal.updatedAt
			),
			'achieve'
		);

		// This is the whole reason the figure is computed rather than imported:
		// the answer moved because the record did.
		expect((await yearInReview(sql, owner, 2026)).goalsAchieved).toBe(1);
	});

	it('has no consistency figure when there is nothing to divide by', async () => {
		// Zero of zero is not nought percent; it is not a question yet.
		expect((await yearInReview(sql, owner, 2026)).habitConsistency).toBeNull();
	});

	it('counts only the viewer’s own days', async () => {
		ok(await createDailyLog(sql, partner, { onDate: '2026-05-01' }), 'their log');
		expect((await yearInReview(sql, owner, 2026)).daysLogged).toBe(0);
		expect((await yearInReview(sql, partner, 2026)).daysLogged).toBe(1);
	});

	it('lists the years there is anything to review', async () => {
		ok(await createDailyLog(sql, owner, { onDate: '2026-05-01' }), 'log');
		ok(await createEvent(sql, owner, { title: 'A thing', onDate: '2024-01-01' }), 'event');

		expect(await yearsOnRecord(sql, owner)).toEqual([2026, 2024]);
	});
});

describe('through a client configured the way the app’s is', () => {
	it('edits and archives a rating', async () => {
		// `$lib/server/db` hands its client to drizzle(), which replaces the
		// driver's timestamp serializers with pass-throughs. The plain client
		// above converts a JS Date parameter without complaint; this one is set
		// up the way the app's is — see health-measurements.test.ts's version of
		// this test for how that difference cost this project a production bug.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createAssessment(appLike, owner, { focus: 'Fitness', rating: 4, year: 2026 }),
				'add a rating through the app-like client'
			).record;
			const edited = ok(
				await updateAssessment(appLike, owner, created.id, { rating: 8 }, created.updatedAt),
				'edit it through the app-like client'
			).record;
			expect(edited.rating).toBe(8);

			ok(
				await archiveAssessment(appLike, owner, edited.id),
				'archive it through the app-like client'
			);
			expect(await listAssessments(appLike, owner, { year: 2026 })).toEqual([]);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});

	it('edits and archives an event', async () => {
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createEvent(appLike, owner, { title: 'Repainted the porch', onDate: '2026-04-01' }),
				'add an event through the app-like client'
			).record;
			const edited = ok(
				await updateEvent(appLike, owner, created.id, { onDate: '2026-04-02' }, created.updatedAt),
				'edit it through the app-like client'
			).record;
			expect(edited.onDate).toBe('2026-04-02');

			ok(await archiveEvent(appLike, owner, edited.id), 'archive it through the app-like client');
			expect(await listEvents(appLike, owner, { from: '2026-01-01', to: '2026-12-31' })).toEqual(
				[]
			);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
