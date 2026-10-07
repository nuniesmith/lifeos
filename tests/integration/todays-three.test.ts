import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import { clearSlot, createTask, pickTask, todaysThree } from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Today's Three (migration 0038).
 *
 * `todays_three` carries no household_id, owner or visibility of its own --
 * it is scoped entirely through the task a pick names, so the tests below
 * that matter most are the ones proving that scoping actually holds: a task
 * the viewer may not read cannot be picked, and the same privacy rule the
 * task itself gets is what a pick gets too.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;
const DAY = '2026-10-05';

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(
		await sql<{ id: string; role: 'admin' | 'member' }[]>`select id, role from users limit 1`
	);
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

const makeTask = async (viewer: Viewer, title: string, visibility?: 'private' | 'household') => {
	const result = await createTask(sql, viewer, { title, ...(visibility ? { visibility } : {}) });
	if (!result.ok) throw new Error(`could not create ${title}: ${JSON.stringify(result)}`);
	return result.record.id;
};

describe('picking, replacing and clearing a slot', () => {
	it('picks a task for a slot', async () => {
		const taskId = await makeTask(owner, 'Renew passport');
		const result = await pickTask(sql, owner, DAY, 'due', taskId);
		expect(result).toMatchObject({ ok: true, record: { slot: 'due', taskId } });

		const picks = await todaysThree(sql, owner, DAY);
		expect(picks).toHaveLength(1);
		expect(picks[0]).toMatchObject({
			slot: 'due',
			taskId,
			task: { id: taskId, title: 'Renew passport', status: 'todo', archivedAt: null }
		});
	});

	it('replaces whatever the slot held, rather than refusing the second pick', async () => {
		const first = await makeTask(owner, 'First pick');
		const second = await makeTask(owner, 'Second pick');
		await pickTask(sql, owner, DAY, 'hard', first);

		const result = await pickTask(sql, owner, DAY, 'hard', second);
		expect(result).toMatchObject({ ok: true, record: { slot: 'hard', taskId: second } });

		const picks = await todaysThree(sql, owner, DAY);
		expect(picks).toHaveLength(1);
		expect(picks[0]?.taskId).toBe(second);
	});

	it('fills all three slots independently', async () => {
		const due = await makeTask(owner, 'Due task');
		const hard = await makeTask(owner, 'Hard task');
		const easy = await makeTask(owner, 'Easy task');
		await pickTask(sql, owner, DAY, 'due', due);
		await pickTask(sql, owner, DAY, 'hard', hard);
		await pickTask(sql, owner, DAY, 'easy', easy);

		const picks = await todaysThree(sql, owner, DAY);
		const bySlot = Object.fromEntries(picks.map((p) => [p.slot, p.taskId]));
		expect(bySlot).toEqual({ due, hard, easy });
	});

	it('clears a slot, and reports whether there was anything to clear', async () => {
		const taskId = await makeTask(owner, 'Clear me');
		await pickTask(sql, owner, DAY, 'easy', taskId);

		expect(await clearSlot(sql, owner, DAY, 'easy')).toBe(true);
		expect(await todaysThree(sql, owner, DAY)).toHaveLength(0);
		// Already empty: clearing again is the state asked for, not a failure.
		expect(await clearSlot(sql, owner, DAY, 'easy')).toBe(false);
	});

	it('keeps each day and each person separate', async () => {
		const taskId = await makeTask(owner, 'Shared errand', 'household');
		await pickTask(sql, owner, DAY, 'due', taskId);
		await pickTask(sql, owner, '2026-10-06', 'due', taskId);
		await pickTask(sql, partner, DAY, 'due', taskId);

		expect(await todaysThree(sql, owner, DAY)).toHaveLength(1);
		expect(await todaysThree(sql, owner, '2026-10-06')).toHaveLength(1);
		expect(await todaysThree(sql, owner, '2026-10-07')).toHaveLength(0);
		expect(await todaysThree(sql, partner, DAY)).toHaveLength(1);
	});
});

describe('one task cannot be the day’s three twice over', () => {
	it('refuses the same task in a second slot on the same day', async () => {
		const taskId = await makeTask(owner, 'One task, one slot');
		await pickTask(sql, owner, DAY, 'due', taskId);

		const result = await pickTask(sql, owner, DAY, 'hard', taskId);
		expect(result).toMatchObject({ ok: false, reason: 'invalid' });

		// Refused, and nothing moved: due still holds it, hard is still empty.
		const picks = await todaysThree(sql, owner, DAY);
		expect(picks).toHaveLength(1);
		expect(picks[0]).toMatchObject({ slot: 'due', taskId });
	});

	it('allows the same task again once the day moves on', async () => {
		const taskId = await makeTask(owner, 'Every day');
		await pickTask(sql, owner, DAY, 'due', taskId);
		const result = await pickTask(sql, owner, '2026-10-06', 'due', taskId);
		expect(result).toMatchObject({ ok: true });
	});
});

describe('authorization lives in the same statement that writes', () => {
	it('is not found when the task is private to the other member', async () => {
		const theirs = await makeTask(partner, 'Private matter', 'private');
		const result = await pickTask(sql, owner, DAY, 'due', theirs);
		expect(result).toMatchObject({ ok: false, reason: 'not_found' });
		expect(await todaysThree(sql, owner, DAY)).toHaveLength(0);
	});

	it('is not found for a task in another household entirely', async () => {
		const outsiderHousehold = await sql<{ id: string }[]>`
			insert into households (name) values ('Elsewhere') returning id
		`;
		const outsiderUsers = await sql<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash, must_change_credentials)
			values ('outsider', 'Outsider', 'admin', 'not-used-by-this-test', false)
			returning id
		`;
		await sql`
			insert into household_members (household_id, user_id)
			values (${outsiderHousehold[0]!.id}::uuid, ${outsiderUsers[0]!.id}::uuid)
		`;
		const outsider = viewerOf(
			{
				id: outsiderUsers[0]!.id,
				username: 'outsider',
				displayName: 'Outsider',
				role: 'admin',
				mustChangeCredentials: false,
				isBootstrap: false
			},
			outsiderHousehold[0]!.id
		);
		const theirTask = await makeTask(outsider, 'Not yours');

		expect(await pickTask(sql, owner, DAY, 'due', theirTask)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('refuses a malformed task id without raising', async () => {
		expect(await pickTask(sql, owner, DAY, 'due', 'not-a-uuid')).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('stops showing a pick once the task is made private to someone else, without touching the row', async () => {
		// The pick is made while the task is still shared, then the task's
		// owner narrows it -- the same live re-check documents.ts's
		// linkedNamesForVisit performs for its own links, not a fact cached at
		// pick time.
		const taskId = await makeTask(partner, 'Shared for now', 'household');
		await pickTask(sql, owner, DAY, 'due', taskId);
		expect(await todaysThree(sql, owner, DAY)).toHaveLength(1);

		const makePrivate = await sql`
			update tasks set visibility = 'private', owner_user_id = ${partner.userId}::uuid
			where id = ${taskId}::uuid
		`;
		expect(makePrivate.count).toBe(1);

		const picks = await todaysThree(sql, owner, DAY);
		expect(picks).toHaveLength(1);
		expect(picks[0]?.task).toBeNull();
		// Not touched: owner's own row still names the slot and the task, so
		// the task becoming readable again would show it without a fresh pick.
		const row = one(
			await sql<{ slot: string; task_id: string }[]>`
				select slot, task_id::text as task_id from todays_three
				where user_id = ${owner.userId}::uuid and on_date = ${DAY}::date
			`
		);
		expect(row).toEqual({ slot: 'due', task_id: taskId });
	});
});

describe('deleting the task removes the pick', () => {
	it('cascades when a task is deleted outright', async () => {
		const taskId = await makeTask(owner, 'Will be deleted');
		await pickTask(sql, owner, DAY, 'due', taskId);
		expect(await todaysThree(sql, owner, DAY)).toHaveLength(1);

		await sql`delete from tasks where id = ${taskId}::uuid`;

		expect(await todaysThree(sql, owner, DAY)).toHaveLength(0);
		const rows = await sql<{ id: string }[]>`select id from todays_three`;
		expect(rows).toHaveLength(0);
	});
});

describe('the Today load', () => {
	it('returns the picks for the day it asks about', async () => {
		const taskId = await makeTask(owner, 'On the agenda');
		await pickTask(sql, owner, DAY, 'easy', taskId);

		const todayPicks = await todaysThree(sql, owner, DAY);
		expect(todayPicks).toMatchObject([{ slot: 'easy', taskId }]);

		const otherDay = await todaysThree(sql, owner, '2026-01-01');
		expect(otherDay).toHaveLength(0);
	});
});

describe('through a client configured the way the app’s is', () => {
	it('picks and clears a slot without sending a bare JS Date', async () => {
		// `$lib/server/db` also hands its client to drizzle(), which replaces
		// the driver's timestamp serializers with pass-throughs -- a JS Date
		// sent as a parameter then reaches the wire unconverted and throws.
		// Neither write path here ever builds a Date; this is what proves it,
		// the same way health-measurements.test.ts proves it for its own two
		// write paths.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const taskId = await makeTask(owner, 'Through a drizzle-wrapped client');
			const picked = await pickTask(appLike, owner, DAY, 'due', taskId);
			expect(picked).toMatchObject({ ok: true, record: { slot: 'due', taskId } });

			const picks = await todaysThree(appLike, owner, DAY);
			expect(picks).toMatchObject([{ slot: 'due', taskId }]);

			expect(await clearSlot(appLike, owner, DAY, 'due')).toBe(true);
			expect(await todaysThree(appLike, owner, DAY)).toHaveLength(0);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
