import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createArea,
	createAssessment,
	createDailyLog,
	createEvent,
	createGoal,
	listAssessments,
	listEvents,
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
