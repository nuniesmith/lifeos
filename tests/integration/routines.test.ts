import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addStep,
	completeStep,
	createHabit,
	createRoutine,
	getRoutine,
	getRoutineWithSteps,
	listHabitLogs,
	logHabit,
	listRoutineSteps,
	listRoutines,
	moveStep,
	routineStepProgress,
	setRoutineArchived,
	setStepArchived,
	stepCompletionsOn,
	uncompleteStep,
	updateRoutine,
	updateStep
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Routines and their steps (migration 0031).
 *
 * Two things dominate this suite: a step's link to a habit is only ever set
 * from the statement that also checks the habit is readable (`addStep`,
 * `updateStep`), and completing a step is a personal act -- readable, not
 * writable -- so a shared routine's steps are ticked by whichever member is
 * doing them, the same rule `logHabit` already follows.
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

async function makeRoutine(viewer: Viewer, overrides: Record<string, unknown> = {}) {
	return ok(
		await createRoutine(sql, viewer, { name: 'Fictional Morning Routine', ...overrides }),
		'create routine'
	).record;
}

async function makeStep(
	viewer: Viewer,
	routineId: string,
	overrides: Record<string, unknown> = {}
) {
	return ok(
		await addStep(sql, viewer, routineId, {
			title: 'Drink water',
			averageVersion: 'Drink a full glass of water',
			...overrides
		}),
		'add step'
	).record;
}

describe('routines', () => {
	it('creates one owned by the creator, household-visible, anytime by default', async () => {
		const routine = await makeRoutine(owner);
		expect(routine).toMatchObject({
			name: 'Fictional Morning Routine',
			timeOfDay: 'anytime',
			visibility: 'household',
			ownerUserId: owner.userId,
			sortOrder: 0
		});
	});

	it('lists live routines, alphabetically within the default order', async () => {
		await makeRoutine(owner, { name: 'Evening wind-down' });
		await makeRoutine(owner, { name: 'Fictional Morning Routine' });
		expect((await listRoutines(sql, owner)).map((r) => r.name)).toEqual([
			'Evening wind-down',
			'Fictional Morning Routine'
		]);
	});

	it('updates fields and detects a stale edit', async () => {
		const routine = await makeRoutine(owner);
		const edited = ok(
			await updateRoutine(
				sql,
				owner,
				routine.id,
				{ name: 'Fictional Evening Routine', timeOfDay: 'evening', notes: 'Wind down.' },
				routine.updatedAt
			),
			'update routine'
		).record;
		expect(edited).toMatchObject({ name: 'Fictional Evening Routine', timeOfDay: 'evening' });

		// The version this edit was made from is now stale: a second save from
		// the same starting point must not silently win.
		expect(
			await updateRoutine(sql, owner, routine.id, { name: 'Once more' }, routine.updatedAt)
		).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('archives and restores', async () => {
		const routine = await makeRoutine(owner);
		ok(await setRoutineArchived(sql, owner, routine.id, true), 'archive');
		expect((await listRoutines(sql, owner)).map((r) => r.id)).not.toContain(routine.id);

		ok(await setRoutineArchived(sql, owner, routine.id, false), 'restore');
		expect((await listRoutines(sql, owner)).map((r) => r.id)).toContain(routine.id);
	});

	it('is not found for a member it was never shared with', async () => {
		const routine = await makeRoutine(partner, {
			visibility: 'private',
			ownerUserId: partner.userId
		});
		expect(await getRoutine(sql, owner, routine.id)).toBeNull();
		expect(await getRoutineWithSteps(sql, owner, routine.id)).toBeNull();
	});
});

describe('routine steps', () => {
	it('appends steps in order, starting at position 1', async () => {
		const routine = await makeRoutine(owner);
		const first = await makeStep(owner, routine.id, { title: 'Make the bed' });
		const second = await makeStep(owner, routine.id, { title: 'Drink water' });
		expect(first.position).toBe(1);
		expect(second.position).toBe(2);
		expect((await listRoutineSteps(sql, owner, routine.id)).map((s) => s.title)).toEqual([
			'Make the bed',
			'Drink water'
		]);
	});

	it('requires an average version, and refuses a blank one', async () => {
		const routine = await makeRoutine(owner);
		expect(
			await addStep(sql, owner, routine.id, { title: 'Stretch', averageVersion: '   ' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('links a habit only when the writer can actually read it, checked in the write itself', async () => {
		const routine = await makeRoutine(owner);
		const theirHabit = ok(
			await createHabit(sql, partner, {
				name: 'Private habit',
				visibility: 'private',
				ownerUserId: partner.userId
			}),
			'create private habit'
		).record;

		expect(
			await addStep(sql, owner, routine.id, {
				title: 'Walk',
				averageVersion: 'Walk 10 minutes',
				habitId: theirHabit.id
			})
		).toMatchObject({ ok: false, reason: 'not_found' });

		const ownHabit = ok(
			await createHabit(sql, owner, { name: 'Walk daily' }),
			'create habit'
		).record;
		const step = await makeStep(owner, routine.id, { title: 'Walk', habitId: ownHabit.id });
		expect(step.habitId).toBe(ownHabit.id);
	});

	it('updateStep changes fields without touching a habit link that was not mentioned', async () => {
		const routine = await makeRoutine(owner);
		const habit = ok(await createHabit(sql, owner, { name: 'Walk daily' }), 'create habit').record;
		const step = await makeStep(owner, routine.id, { habitId: habit.id });

		const edited = ok(
			await updateStep(sql, owner, step.id, { title: 'Drink two glasses of water' }),
			'update step'
		).record;
		expect(edited).toMatchObject({ title: 'Drink two glasses of water', habitId: habit.id });

		// Explicitly clearing it, though, does clear it.
		const cleared = ok(
			await updateStep(sql, owner, step.id, { habitId: '' }),
			'clear habit link'
		).record;
		expect(cleared.habitId).toBeNull();
	});

	it('refuses to link an unreadable habit on update, in the same statement', async () => {
		const routine = await makeRoutine(owner);
		const step = await makeStep(owner, routine.id);
		const theirHabit = ok(
			await createHabit(sql, partner, {
				name: 'Private habit',
				visibility: 'private',
				ownerUserId: partner.userId
			}),
			'create private habit'
		).record;

		expect(await updateStep(sql, owner, step.id, { habitId: theirHabit.id })).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('moving a step keeps every live position unique, and edges are a no-op', async () => {
		const routine = await makeRoutine(owner);
		const a = await makeStep(owner, routine.id, { title: 'A' });
		const b = await makeStep(owner, routine.id, { title: 'B' });
		const c = await makeStep(owner, routine.id, { title: 'C' });

		ok(await moveStep(sql, owner, b.id, 'up'), 'move B up');
		let steps = await listRoutineSteps(sql, owner, routine.id);
		expect(steps.map((s) => s.title)).toEqual(['B', 'A', 'C']);
		expect(steps.map((s) => s.position).sort()).toEqual([1, 2, 3]);

		// Already first: moving up again is a no-op success, not an error.
		expect(await moveStep(sql, owner, b.id, 'up')).toMatchObject({ ok: true });
		steps = await listRoutineSteps(sql, owner, routine.id);
		expect(steps.map((s) => s.title)).toEqual(['B', 'A', 'C']);

		ok(await moveStep(sql, owner, c.id, 'down'), 'move C down past the end');
		expect((await listRoutineSteps(sql, owner, routine.id)).map((s) => s.title)).toEqual([
			'B',
			'A',
			'C'
		]);

		// A genuine identity crisis check: the underlying table never carried two
		// live rows at the same position, even transiently, or the unique index
		// would have raised during the swap above rather than after it.
		const rows = await sql<{ position: number }[]>`
			select position from routine_steps where routine_id = ${routine.id}::uuid and archived_at is null
		`;
		expect(rows.map((r) => r.position).sort()).toEqual([1, 2, 3]);
		void a;
	});

	it('archiving a step compacts the remaining live positions', async () => {
		const routine = await makeRoutine(owner);
		const a = await makeStep(owner, routine.id, { title: 'A' });
		const b = await makeStep(owner, routine.id, { title: 'B' });
		const c = await makeStep(owner, routine.id, { title: 'C' });

		ok(await setStepArchived(sql, owner, b.id, true), 'archive B');
		const steps = await listRoutineSteps(sql, owner, routine.id);
		expect(steps.map((s) => s.title)).toEqual(['A', 'C']);
		expect(steps.map((s) => s.position)).toEqual([1, 2]);
		void a;
		void c;
	});

	it('restoring an archived step appends it at the end rather than its old slot', async () => {
		const routine = await makeRoutine(owner);
		const a = await makeStep(owner, routine.id, { title: 'A' });
		const b = await makeStep(owner, routine.id, { title: 'B' });
		ok(await setStepArchived(sql, owner, a.id, true), 'archive A');
		ok(await setStepArchived(sql, owner, a.id, false), 'restore A');

		expect((await listRoutineSteps(sql, owner, routine.id)).map((s) => s.title)).toEqual([
			'B',
			'A'
		]);
		void b;
	});

	it('a household member who does not own the routine may not change its steps', async () => {
		const routine = await makeRoutine(owner); // owner-owned, household-visible by default.
		expect(
			await addStep(sql, partner, routine.id, {
				title: 'Sneak in a step',
				averageVersion: 'Should not land'
			})
		).toMatchObject({ ok: false, reason: 'not_found' });
	});
});

describe('completing a step', () => {
	it('records the completion, and undoing it removes it', async () => {
		const routine = await makeRoutine(owner);
		const step = await makeStep(owner, routine.id);

		const completed = ok(
			await completeStep(sql, owner, step.id, '2026-09-21', 'average'),
			'complete step'
		).record;
		expect(completed).toMatchObject({ stepId: step.id, userId: owner.userId, version: 'average' });
		expect(await stepCompletionsOn(sql, owner, routine.id, owner.userId, '2026-09-21')).toEqual(
			new Map([[step.id, 'average']])
		);

		expect(await uncompleteStep(sql, owner, step.id, '2026-09-21')).toBe(true);
		expect(await stepCompletionsOn(sql, owner, routine.id, owner.userId, '2026-09-21')).toEqual(
			new Map()
		);
		// Undoing an already-undone day is still success, not an error.
		expect(await uncompleteStep(sql, owner, step.id, '2026-09-21')).toBe(false);
	});

	it('logs the linked habit’s check-in in the same transaction, and undoing unlogs it', async () => {
		const routine = await makeRoutine(owner);
		const habit = ok(await createHabit(sql, owner, { name: 'Drink water' }), 'create habit').record;
		const step = await makeStep(owner, routine.id, { habitId: habit.id });

		ok(await completeStep(sql, owner, step.id, '2026-09-21', 'high'), 'complete linked step');
		const logs = await listHabitLogs(sql, owner, habit.id, {
			from: '2026-09-21',
			to: '2026-09-21'
		});
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({ onDate: '2026-09-21', completed: true });

		await uncompleteStep(sql, owner, step.id, '2026-09-21');
		expect(
			await listHabitLogs(sql, owner, habit.id, { from: '2026-09-21', to: '2026-09-21' })
		).toHaveLength(0);
	});

	it('leaves a check-in made on /habits alone: completing keeps its note, and undoing keeps it', async () => {
		const routine = await makeRoutine(owner);
		const habit = ok(await createHabit(sql, owner, { name: 'Stretch' }), 'create habit').record;
		const step = await makeStep(owner, routine.id, { habitId: habit.id });
		ok(
			await logHabit(sql, owner, { habitId: habit.id, onDate: '2026-09-21', note: 'Before work' }),
			'check in on /habits first'
		);
		const day = { from: '2026-09-21', to: '2026-09-21' };

		const completed = ok(
			await completeStep(sql, owner, step.id, '2026-09-21', 'average'),
			'complete the linked step'
		).record;
		// Nothing was logged on the step's behalf: the check-in was already there.
		expect(completed.loggedHabitId).toBeNull();
		expect(await listHabitLogs(sql, owner, habit.id, day)).toMatchObject([{ note: 'Before work' }]);

		await uncompleteStep(sql, owner, step.id, '2026-09-21');
		expect(await listHabitLogs(sql, owner, habit.id, day)).toMatchObject([{ note: 'Before work' }]);
	});

	it('undoing removes the check-in it logged, even after the step is relinked to another habit', async () => {
		const routine = await makeRoutine(owner);
		const first = ok(await createHabit(sql, owner, { name: 'Walk' }), 'create first habit').record;
		const second = ok(
			await createHabit(sql, owner, { name: 'Read' }),
			'create second habit'
		).record;
		const step = await makeStep(owner, routine.id, { habitId: first.id });
		const day = { from: '2026-09-21', to: '2026-09-21' };

		ok(await completeStep(sql, owner, step.id, '2026-09-21', 'average'), 'complete');
		ok(await updateStep(sql, owner, step.id, { habitId: second.id }), 'relink the step');
		ok(
			await logHabit(sql, owner, { habitId: second.id, onDate: '2026-09-21' }),
			'check in the second habit on /habits'
		);

		await uncompleteStep(sql, owner, step.id, '2026-09-21');
		expect(await listHabitLogs(sql, owner, first.id, day)).toHaveLength(0);
		expect(await listHabitLogs(sql, owner, second.id, day)).toHaveLength(1);
	});

	it('a routine shared with the household can be completed by either member', async () => {
		const routine = await makeRoutine(owner); // owner-owned, household-visible.
		const step = await makeStep(owner, routine.id);

		// Completing is readable, not writable: the partner may not add a step
		// (see the authorization test above) but may still do this one.
		const completed = ok(
			await completeStep(sql, partner, step.id, '2026-09-21', 'average'),
			'partner completes the shared step'
		).record;
		expect(completed.userId).toBe(partner.userId);

		// Each member's own history, not one shared tick.
		expect(await stepCompletionsOn(sql, owner, routine.id, owner.userId, '2026-09-21')).toEqual(
			new Map()
		);
		expect(await stepCompletionsOn(sql, owner, routine.id, partner.userId, '2026-09-21')).toEqual(
			new Map([[step.id, 'average']])
		);
	});

	it('skips the habit check-in, without failing, once the habit is no longer readable', async () => {
		const routine = await makeRoutine(owner); // household-visible.
		const habit = ok(
			await createHabit(sql, owner, { name: 'Shared habit' }),
			'create habit'
		).record;
		const step = await makeStep(owner, routine.id, { habitId: habit.id });

		// The owner makes their own habit private after linking it -- the step
		// itself is still household-visible and stays completable by the partner.
		await sql`update habits set visibility = 'private' where id = ${habit.id}::uuid`;

		const completed = ok(
			await completeStep(sql, partner, step.id, '2026-09-21', 'average'),
			'partner completes despite the now-private habit'
		).record;
		expect(completed.version).toBe('average');
		// The habit's own log was never written for the partner, because the
		// habit is not theirs to see -- and the completion above still succeeded.
		expect(
			await listHabitLogs(sql, owner, habit.id, {
				from: '2026-09-21',
				to: '2026-09-21',
				userId: partner.userId
			})
		).toHaveLength(0);
	});

	it('overwrites the version on a second completion for the same day', async () => {
		const routine = await makeRoutine(owner);
		const step = await makeStep(owner, routine.id);
		ok(await completeStep(sql, owner, step.id, '2026-09-21', 'minimal'), 'first pass');
		ok(await completeStep(sql, owner, step.id, '2026-09-21', 'high'), 'second pass');
		expect(await stepCompletionsOn(sql, owner, routine.id, owner.userId, '2026-09-21')).toEqual(
			new Map([[step.id, 'high']])
		);
	});
});

describe('today’s progress', () => {
	it('counts live steps done for a day, per routine, in one call', async () => {
		const routine = await makeRoutine(owner);
		const a = await makeStep(owner, routine.id, { title: 'A' });
		await makeStep(owner, routine.id, { title: 'B' });
		ok(
			await setStepArchived(
				sql,
				owner,
				(await makeStep(owner, routine.id, { title: 'C' })).id,
				true
			),
			'archive C'
		);

		ok(await completeStep(sql, owner, a.id, '2026-09-21', 'average'), 'complete A');

		const progress = await routineStepProgress(
			sql,
			owner,
			[routine.id],
			owner.userId,
			'2026-09-21'
		);
		// Two LIVE steps (A, B); the archived one does not count towards total.
		expect(progress.get(routine.id)).toEqual({ done: 1, total: 2 });
	});
});

describe('through a client configured the way the app’s is', () => {
	it('exercises every write path with no raw Date ever sent as a parameter', async () => {
		// `$lib/server/db` also hands its client to drizzle(), which replaces
		// the driver's timestamp serializers with pass-throughs: a JS Date sent
		// as a parameter then reaches the wire unconverted and throws. This is
		// the same regression health-measurements.test.ts guards against, run
		// here over routines' own write paths -- create, add/complete/uncomplete
		// a step, and archive -- since every one of them touches a timestamp or
		// a date.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const routine = ok(
				await createRoutine(appLike, owner, { name: 'Fictional Evening Routine' }),
				'create through the app-like client'
			).record;
			const step = ok(
				await addStep(appLike, owner, routine.id, {
					title: 'Lights out',
					averageVersion: 'Turn off the lights'
				}),
				'add a step through the app-like client'
			).record;
			ok(
				await updateRoutine(appLike, owner, routine.id, { notes: 'Wind down.' }, routine.updatedAt),
				'update through the app-like client'
			);
			ok(
				await completeStep(appLike, owner, step.id, '2026-09-21', 'average'),
				'complete through the app-like client'
			);
			expect(await uncompleteStep(appLike, owner, step.id, '2026-09-21')).toBe(true);
			ok(
				await setRoutineArchived(appLike, owner, routine.id, true),
				'archive through the app-like client'
			);
			const archived = await getRoutine(appLike, owner, routine.id);
			expect(archived?.archivedAt).toBeInstanceOf(Date);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
