import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createArea,
	createGoal,
	createProject,
	goalsNeedingSetup,
	markReviewed,
	reviewQueue
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The review queue (migration 0009) and the "needs setup" warning.
 *
 * `today` is passed in rather than read from the clock so these assert exact
 * dates instead of drifting with the day they are run on.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

const TODAY = '2026-09-07';

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
	if (!result.ok) throw new Error(`could not create ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

describe('the review queue', () => {
	it('reports a record whose cadence has elapsed as overdue', async () => {
		// 30 days after 1 August is 31 August; today is 7 September.
		ok(
			await createArea(sql, owner, {
				name: 'Finances',
				reviewEveryDays: 30,
				lastReviewedOn: '2026-08-01'
			}),
			'area'
		);

		const queue = await reviewQueue(sql, owner, TODAY);
		expect(queue).toHaveLength(1);
		expect(queue[0]).toMatchObject({
			kind: 'area',
			title: 'Finances',
			dueOn: '2026-08-31',
			overdueDays: 7
		});
	});

	it('leaves a record alone until its cadence elapses', async () => {
		ok(
			await createArea(sql, owner, {
				name: 'Travel',
				reviewEveryDays: 365,
				lastReviewedOn: '2026-08-01'
			}),
			'area'
		);
		expect(await reviewQueue(sql, owner, TODAY)).toEqual([]);

		const all = await reviewQueue(sql, owner, TODAY, { includeUpcoming: true });
		expect(all[0]).toMatchObject({ dueOn: '2027-08-01', overdueDays: -328 });
	});

	it('treats a cadence with no review yet as due today, not as never', async () => {
		// The cadence is the statement that this should be looked at; never
		// having done so is the strongest case for doing it now.
		ok(await createArea(sql, owner, { name: 'Pets', reviewEveryDays: 30 }), 'area');

		const queue = await reviewQueue(sql, owner, TODAY);
		expect(queue[0]).toMatchObject({ dueOn: TODAY, overdueDays: 0, lastReviewedOn: null });
	});

	it('ignores anything with no cadence set', async () => {
		ok(await createArea(sql, owner, { name: 'Whatever' }), 'area');
		expect(await reviewQueue(sql, owner, TODAY)).toEqual([]);
	});

	it('covers areas, goals and projects in one soonest-first queue', async () => {
		ok(
			await createArea(sql, owner, {
				name: 'An area',
				reviewEveryDays: 30,
				lastReviewedOn: '2026-08-20'
			}),
			'area'
		);
		ok(
			await createGoal(sql, owner, {
				title: 'A goal',
				reviewEveryDays: 14,
				lastReviewedOn: '2026-08-01'
			}),
			'goal'
		);
		ok(
			await createProject(sql, owner, {
				name: 'A project',
				reviewEveryDays: 7,
				lastReviewedOn: '2026-08-25'
			}),
			'project'
		);

		const queue = await reviewQueue(sql, owner, TODAY);
		// Goal 15 Aug, project 1 Sep, area 19 Sep — the area is not yet due.
		expect(queue.map((i) => i.title)).toEqual(['A goal', 'A project']);
		expect(queue.map((i) => i.kind)).toEqual(['goal', 'project']);
		expect(queue[0]?.path).toMatch(/^\/goals\//);
	});

	it('clears an item once it is marked reviewed', async () => {
		const created = ok(
			await createArea(sql, owner, {
				name: 'Life Admin',
				reviewEveryDays: 30,
				lastReviewedOn: '2026-07-01'
			}),
			'area'
		);

		expect(await reviewQueue(sql, owner, TODAY)).toHaveLength(1);

		const marked = await markReviewed(sql, owner, 'area', created.record.id, TODAY);
		expect(marked).toMatchObject({ ok: true });

		expect(await reviewQueue(sql, owner, TODAY)).toEqual([]);
		const all = await reviewQueue(sql, owner, TODAY, { includeUpcoming: true });
		expect(all[0]).toMatchObject({ lastReviewedOn: TODAY, dueOn: '2026-10-07' });
	});

	it('refuses to mark a record the viewer may not write', async () => {
		const mine = ok(
			await createArea(sql, owner, {
				name: 'Mine alone',
				reviewEveryDays: 30,
				visibility: 'private',
				ownerUserId: owner.userId
			}),
			'area'
		);

		const attempt = await markReviewed(sql, partner, 'area', mine.record.id, TODAY);
		expect(attempt).toMatchObject({ ok: false, reason: 'not_found' });
	});

	it('never shows another member’s private record in the queue', async () => {
		ok(
			await createGoal(sql, partner, {
				title: 'Something personal',
				reviewEveryDays: 7,
				visibility: 'private',
				ownerUserId: partner.userId
			}),
			'goal'
		);

		expect(await reviewQueue(sql, owner, TODAY)).toEqual([]);
		expect(await reviewQueue(sql, partner, TODAY)).toHaveLength(1);
	});
});

describe('goals needing setup', () => {
	it('names a goal with no project and no habit behind it', async () => {
		ok(await createGoal(sql, owner, { title: 'Make some more local friends' }), 'goal');
		const bare = await goalsNeedingSetup(sql, owner);
		expect(bare.map((g) => g.title)).toEqual(['Make some more local friends']);
	});

	it('stops naming it once a project is attached', async () => {
		const goal = ok(await createGoal(sql, owner, { title: 'Lose weight' }), 'goal');
		const project = ok(await createProject(sql, owner, { name: 'Couch to 5k' }), 'project');
		await sql`
			insert into project_goals (project_id, goal_id)
			values (${project.record.id}::uuid, ${goal.record.id}::uuid)
		`;

		expect(await goalsNeedingSetup(sql, owner)).toEqual([]);
	});

	it('does not nag about a goal that is already finished or dropped', async () => {
		ok(await createGoal(sql, owner, { title: 'Done and dusted', status: 'achieved' }), 'goal');
		ok(await createGoal(sql, owner, { title: 'Let go of', status: 'dropped' }), 'goal');
		expect(await goalsNeedingSetup(sql, owner)).toEqual([]);
	});

	it('does nag about a goal parked for later, which is the point', async () => {
		// 'planned' arrived with migration 0010. A goal chosen for later with
		// nothing behind it is exactly what a review should surface.
		ok(await createGoal(sql, owner, { title: 'Someday, a boat', status: 'planned' }), 'goal');
		expect((await goalsNeedingSetup(sql, owner)).map((g) => g.title)).toEqual(['Someday, a boat']);
	});
});
