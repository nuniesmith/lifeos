import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { canRead, canWrite, type OwnedRecord, type Viewer } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import { householdToday } from '$lib/server/repositories/base';
import {
	archiveArea,
	createArea,
	listAreas,
	unarchiveArea,
	updateArea
} from '$lib/server/repositories/areas';
import {
	createDailyLog,
	getDailyLogForDate,
	listDailyLogs,
	updateDailyLog
} from '$lib/server/repositories/daily-logs';
import { createGoal, listGoals, updateGoal } from '$lib/server/repositories/goals';
import {
	createHabit,
	habitSummaries,
	habitSummary,
	listHabitLogs,
	logHabit,
	unlogHabit
} from '$lib/server/repositories/habits';
import {
	createImportantDate,
	upcomingImportantDates
} from '$lib/server/repositories/important-dates';
import { createProject, listProjects, updateProject } from '$lib/server/repositories/projects';
import {
	attachTag,
	createTag,
	detachTag,
	listTags,
	tagsForEntity,
	updateTag
} from '$lib/server/repositories/tags';
import {
	agenda,
	archiveTask,
	countTasks,
	createTask,
	getTask,
	listTasks,
	openTaskCountsByArea,
	openTaskCountsByProject,
	unarchiveTask,
	updateTask,
	type TaskRecord
} from '$lib/server/repositories/tasks';

/**
 * The repository boundary against a real database (MODEL-003).
 *
 * The authorization cases are written adversarially: every one of them is an
 * attempt to read or change something the viewer must not, because a suite
 * that only walks the happy path would pass just as well with the WHERE
 * clauses deleted. The household boundary in particular is checked on every
 * operation rather than once, since it is enforced per query and a single
 * missed clause is a whole-workspace disclosure.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let houseA: string;
let houseB: string;
let jordan: Viewer;
let partner: Viewer;
let adminA: Viewer;
let outsider: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

async function makeHousehold(name: string): Promise<string> {
	return one(
		await sql<{ id: string }[]>`
			insert into households (name, timezone) values (${name}, 'America/Toronto')
			returning id
		`,
		'household'
	).id;
}

async function makeUser(
	householdId: string,
	username: string,
	role: 'admin' | 'member'
): Promise<string> {
	const user = one(
		await sql<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash)
			values (${username}, ${username}, ${role}, 'not-a-real-hash')
			returning id
		`,
		'user'
	);
	await sql`
		insert into household_members (household_id, user_id)
		values (${householdId}::uuid, ${user.id}::uuid)
	`;
	return user.id;
}

beforeEach(async () => {
	await reset();
	houseA = await makeHousehold('House A');
	houseB = await makeHousehold('House B');
	jordan = {
		userId: await makeUser(houseA, 'jordan', 'member'),
		householdId: houseA,
		role: 'member'
	};
	partner = {
		userId: await makeUser(houseA, 'partner', 'member'),
		householdId: houseA,
		role: 'member'
	};
	adminA = { userId: await makeUser(houseA, 'admin', 'admin'), householdId: houseA, role: 'admin' };
	outsider = {
		userId: await makeUser(houseB, 'outsider', 'admin'),
		householdId: houseB,
		role: 'admin'
	};
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

/** Inserts a task directly, so ownership combinations the repository refuses to
 *  create can still be tested for readability. */
async function seedTask(
	householdId: string,
	ownerUserId: string | null,
	visibility: 'household' | 'private',
	title: string
): Promise<{ id: string; updatedAt: Date }> {
	const row = one(
		await sql<{ id: string; updated_at: Date }[]>`
			insert into tasks (household_id, owner_user_id, visibility, title, do_on)
			values (${householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title},
			        '2026-09-05'::date)
			returning id, updated_at
		`,
		'task'
	);
	return { id: row.id, updatedAt: new Date(row.updated_at) };
}

const ok = <T>(result: { ok: true; record: T } | { ok: false; reason: string }): T => {
	if (!result.ok) throw new Error(`expected success, got ${result.reason}`);
	return result.record;
};

// ───────────────────────────────────────────────────────────────────────────
// the authorization boundary
// ───────────────────────────────────────────────────────────────────────────

describe('household isolation', () => {
	it('hides every other household record from a list, including from an admin', async () => {
		await seedTask(houseB, outsider.userId, 'household', 'their shared task');
		await seedTask(houseA, jordan.userId, 'household', 'our task');

		expect((await listTasks(sql, jordan)).map((t) => t.title)).toEqual(['our task']);
		// The admin role governs accounts and operations, not other households.
		expect((await listTasks(sql, adminA)).map((t) => t.title)).toEqual(['our task']);
		expect((await listTasks(sql, outsider)).map((t) => t.title)).toEqual(['their shared task']);
	});

	it('refuses to fetch another household record by its id', async () => {
		const theirs = await seedTask(houseB, outsider.userId, 'household', 'their task');
		expect(await getTask(sql, jordan, theirs.id)).toBeNull();
		expect(await getTask(sql, adminA, theirs.id)).toBeNull();
	});

	it('refuses to change another household record, and leaves it untouched', async () => {
		const theirs = await seedTask(houseB, outsider.userId, 'household', 'their task');

		const attempt = await updateTask(
			sql,
			jordan,
			theirs.id,
			{ title: 'hijacked' },
			theirs.updatedAt
		);
		expect(attempt).toMatchObject({ ok: false, reason: 'not_found' });
		// Not "forbidden": telling a stranger the record exists is itself a leak.
		expect(attempt.ok === false && attempt.current).toBeUndefined();

		const archived = await archiveTask(sql, jordan, theirs.id);
		expect(archived).toMatchObject({ ok: false, reason: 'not_found' });

		const still = one(
			await sql<{ title: string; archived_at: Date | null }[]>`
				select title, archived_at from tasks where id = ${theirs.id}::uuid
			`
		);
		expect(still.title).toBe('their task');
		expect(still.archived_at).toBeNull();
	});

	it('keeps every other repository inside the household too', async () => {
		await createProject(sql, outsider, { name: 'their project' });
		await createArea(sql, outsider, { name: 'their area' });
		await createGoal(sql, outsider, { title: 'their goal' });
		await createTag(sql, outsider, { name: 'theirs' });
		await createDailyLog(sql, outsider, { onDate: '2026-09-05', note: 'their day' });
		await createImportantDate(sql, outsider, { title: 'their birthday', onDate: '2026-09-06' });

		expect(await listProjects(sql, jordan)).toHaveLength(0);
		expect(await listAreas(sql, jordan)).toHaveLength(0);
		expect(await listGoals(sql, jordan)).toHaveLength(0);
		expect(await listTags(sql, jordan)).toHaveLength(0);
		expect(await listDailyLogs(sql, jordan)).toHaveLength(0);
		expect(
			await upcomingImportantDates(sql, jordan, { today: '2026-09-05', days: 30 })
		).toHaveLength(0);
	});

	it('refuses to link a record to another household', async () => {
		const theirProject = ok(await createProject(sql, outsider, { name: 'their project' }));
		const attempt = await createTask(sql, jordan, {
			title: 'sneaky',
			projectId: theirProject.id
		});
		expect(attempt).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await countTasks(sql, jordan)).toBe(0);
	});
});

describe('private records', () => {
	it('hides one member private record from the other member', async () => {
		const secret = await seedTask(houseA, partner.userId, 'private', 'partner private task');
		expect(await getTask(sql, jordan, secret.id)).toBeNull();
		expect((await listTasks(sql, jordan)).map((t) => t.title)).toEqual([]);
		// Its owner still sees it.
		expect((await listTasks(sql, partner)).map((t) => t.title)).toEqual(['partner private task']);
	});

	it('hides it from an admin of the same household as well', async () => {
		// Administration covers accounts and system operations, not reading
		// somebody's journal.
		const secret = await seedTask(houseA, partner.userId, 'private', 'partner private task');
		expect(await getTask(sql, adminA, secret.id)).toBeNull();
		expect(await listTasks(sql, adminA)).toHaveLength(0);
	});

	it('keeps a private daily log out of the other member reach', async () => {
		const log = ok(
			await createDailyLog(sql, partner, { onDate: '2026-09-05', note: 'a private entry' })
		);
		expect(log.visibility).toBe('private');

		expect(await listDailyLogs(sql, jordan)).toHaveLength(0);
		expect(await getDailyLogForDate(sql, jordan, '2026-09-05', partner.userId)).toBeNull();
		const attempt = await updateDailyLog(sql, jordan, log.id, { note: 'read' }, log.updatedAt);
		expect(attempt).toMatchObject({ ok: false, reason: 'not_found' });
	});

	it('refuses to create a private record nobody could read', async () => {
		const attempt = await createTask(sql, jordan, {
			title: 'unreadable',
			ownerUserId: null,
			visibility: 'private'
		});
		expect(attempt).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses to create a record owned by the other member', async () => {
		const attempt = await createTask(sql, jordan, {
			title: 'yours now',
			ownerUserId: partner.userId
		});
		expect(attempt).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

describe('writing a shared record', () => {
	it('lets the other member read it but not change it', async () => {
		const shared = ok(await createTask(sql, jordan, { title: 'jordan shared task' }));
		expect(shared.visibility).toBe('household');

		// Readable by both.
		expect((await getTask(sql, partner, shared.id))?.title).toBe('jordan shared task');

		const attempt = await updateTask(
			sql,
			partner,
			shared.id,
			{ title: 'changed by partner' },
			shared.updatedAt
		);
		expect(attempt).toMatchObject({ ok: false, reason: 'forbidden' });
		// The refusal may return what is there, since the partner may read it.
		expect(attempt.ok === false && attempt.current?.title).toBe('jordan shared task');
		expect((await getTask(sql, jordan, shared.id))?.title).toBe('jordan shared task');
	});

	it('refuses the non-owner an archive as well as an edit', async () => {
		const shared = ok(await createTask(sql, jordan, { title: 'jordan shared task' }));
		expect(await archiveTask(sql, partner, shared.id)).toMatchObject({
			ok: false,
			reason: 'forbidden'
		});
		expect((await getTask(sql, jordan, shared.id))?.archivedAt).toBeNull();
	});

	it('lets either member change an unowned household record', async () => {
		const shared = ok(
			await createTask(sql, jordan, { title: 'the shared shopping run', ownerUserId: null })
		);
		const changed = ok(
			await updateTask(sql, partner, shared.id, { title: 'ours together' }, shared.updatedAt)
		);
		expect(changed.title).toBe('ours together');
		expect(changed.updatedBy).toBe(partner.userId);
	});

	it('refuses to hand a record to the other member by editing its owner', async () => {
		const shared = ok(await createTask(sql, jordan, { title: 'mine' }));
		const attempt = await updateTask(
			sql,
			jordan,
			shared.id,
			{ ownerUserId: partner.userId },
			shared.updatedAt
		);
		expect(attempt).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

describe('the SQL scope agrees with the pure rule', () => {
	/**
	 * The strongest form of the check: build every ownership combination that
	 * can exist, then compare the rows the database returns against what
	 * `canRead` says, and the writes it accepts against `canWrite`. A drift
	 * between the two definitions is exactly the bug that leaks a record.
	 */
	it('over every combination of household, owner and visibility', async () => {
		const combos: { record: OwnedRecord; title: string }[] = [];
		for (const [householdId, owners] of [
			[houseA, [jordan.userId, partner.userId, null]],
			[houseB, [outsider.userId, null]]
		] as const) {
			for (const ownerUserId of owners) {
				for (const visibility of ['household', 'private'] as const) {
					const title = `${householdId === houseA ? 'A' : 'B'}/${ownerUserId ?? 'none'}/${visibility}`;
					combos.push({ record: { householdId, ownerUserId, visibility }, title });
				}
			}
		}
		expect(combos).toHaveLength(10);

		const seeded = new Map<string, { id: string; updatedAt: Date }>();
		for (const combo of combos) {
			seeded.set(
				combo.title,
				await seedTask(
					combo.record.householdId,
					combo.record.ownerUserId,
					combo.record.visibility,
					combo.title
				)
			);
		}

		for (const viewer of [jordan, partner, adminA, outsider]) {
			const expectedReadable = combos
				.filter((c) => canRead(c.record, viewer))
				.map((c) => c.title)
				.sort();
			const actualReadable = (await listTasks(sql, viewer, { order: 'title' }))
				.map((t) => t.title)
				.sort();
			expect(actualReadable).toEqual(expectedReadable);

			for (const combo of combos) {
				const seed = seeded.get(combo.title)!;
				// Read the live version each time: an earlier viewer in this loop
				// may legitimately have written the row, and a stale version
				// would report a conflict instead of the authorization answer.
				const version = one(
					await sql<{ updated_at: Date }[]>`
						select updated_at from tasks where id = ${seed.id}::uuid
					`
				).updated_at;
				const result = await updateTask(
					sql,
					viewer,
					seed.id,
					{ notes: `touched by ${viewer.userId}` },
					version
				);
				const expected = canWrite(combo.record, viewer)
					? 'ok'
					: canRead(combo.record, viewer)
						? 'forbidden'
						: 'not_found';
				const actual = result.ok ? 'ok' : result.reason;
				expect(`${combo.title} -> ${actual}`).toBe(`${combo.title} -> ${expected}`);
			}
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// optimistic concurrency
// ───────────────────────────────────────────────────────────────────────────

describe('optimistic concurrency', () => {
	it('rejects a write made against a version that has moved on', async () => {
		const task = ok(await createTask(sql, jordan, { title: 'original' }));
		const stale = task.updatedAt;

		const first = ok(await updateTask(sql, jordan, task.id, { title: 'first edit' }, stale));
		expect(first.title).toBe('first edit');
		expect(first.updatedAt.getTime()).toBeGreaterThan(stale.getTime());

		const second = await updateTask(sql, jordan, task.id, { title: 'second edit' }, stale);
		expect(second).toMatchObject({ ok: false, reason: 'conflict' });
		// The conflict carries the current state, so a form can show what it lost.
		expect(second.ok === false && second.current?.title).toBe('first edit');

		// The rejected write left nothing behind.
		expect((await getTask(sql, jordan, task.id))?.title).toBe('first edit');
	});

	it('accepts the same write once it is retried against the current version', async () => {
		const task = ok(await createTask(sql, jordan, { title: 'original' }));
		const first = ok(await updateTask(sql, jordan, task.id, { title: 'first' }, task.updatedAt));
		const retried = ok(
			await updateTask(sql, jordan, task.id, { title: 'second' }, first.updatedAt)
		);
		expect(retried.title).toBe('second');
	});

	it('survives the round trip through the driver, which loses microseconds', async () => {
		// PostgreSQL stores updated_at to the microsecond and a JS Date holds
		// milliseconds, so an exact equality precondition would never match and
		// every second save would look like a conflict.
		const task = ok(await createTask(sql, jordan, { title: 'precision' }));
		const reread = await getTask(sql, jordan, task.id);
		expect(reread).not.toBeNull();
		const saved = ok(await updateTask(sql, jordan, task.id, { title: 'saved' }, reread!.updatedAt));
		expect(saved.title).toBe('saved');
	});

	it('accepts an ISO string as well as a Date', async () => {
		const task = ok(await createTask(sql, jordan, { title: 'string version' }));
		const saved = ok(
			await updateTask(sql, jordan, task.id, { title: 'ok' }, task.updatedAt.toISOString())
		);
		expect(saved.title).toBe('ok');
	});

	it('guards archiving too, when a version is supplied', async () => {
		const task = ok(await createTask(sql, jordan, { title: 'to archive' }));
		const stale = task.updatedAt;
		ok(await updateTask(sql, jordan, task.id, { title: 'edited elsewhere' }, stale));

		expect(await archiveTask(sql, jordan, task.id, stale)).toMatchObject({
			ok: false,
			reason: 'conflict'
		});
		expect((await getTask(sql, jordan, task.id))?.archivedAt).toBeNull();
	});

	it('applies across the other repositories, not only to tasks', async () => {
		const area = ok(await createArea(sql, jordan, { name: 'Health' }));
		ok(await updateArea(sql, jordan, area.id, { name: 'Health & fitness' }, area.updatedAt));
		expect(await updateArea(sql, jordan, area.id, { name: 'again' }, area.updatedAt)).toMatchObject(
			{ ok: false, reason: 'conflict' }
		);

		const project = ok(await createProject(sql, jordan, { name: 'Kitchen' }));
		ok(await updateProject(sql, jordan, project.id, { name: 'Kitchen redo' }, project.updatedAt));
		expect(
			await updateProject(sql, jordan, project.id, { name: 'again' }, project.updatedAt)
		).toMatchObject({ ok: false, reason: 'conflict' });

		const goal = ok(await createGoal(sql, jordan, { title: 'Run a 10k' }));
		ok(await updateGoal(sql, jordan, goal.id, { status: 'paused' }, goal.updatedAt));
		expect(
			await updateGoal(sql, jordan, goal.id, { status: 'active' }, goal.updatedAt)
		).toMatchObject({ ok: false, reason: 'conflict' });

		const tag = ok(await createTag(sql, jordan, { name: 'errand' }));
		ok(await updateTag(sql, jordan, tag.id, { name: 'errands' }, tag.updatedAt));
		expect(await updateTag(sql, jordan, tag.id, { name: 'again' }, tag.updatedAt)).toMatchObject({
			ok: false,
			reason: 'conflict'
		});
	});
});

// ───────────────────────────────────────────────────────────────────────────
// records and archiving
// ───────────────────────────────────────────────────────────────────────────

describe('creating and changing records', () => {
	it('round-trips a task through the driver without losing a field', async () => {
		const created = ok(
			await createTask(sql, jordan, {
				title: 'Call the clinic',
				notes: 'ask about the referral',
				kind: 'milestone',
				status: 'in_progress',
				doOn: '2026-09-05',
				deadlineOn: '2026-09-09',
				isImportant: true,
				energy: 'low',
				context: 'phone',
				sortOrder: 3
			})
		);

		expect(created).toMatchObject({
			title: 'Call the clinic',
			notes: 'ask about the referral',
			kind: 'milestone',
			status: 'in_progress',
			doOn: '2026-09-05',
			deadlineOn: '2026-09-09',
			isImportant: true,
			isUrgent: false,
			energy: 'low',
			context: 'phone',
			sortOrder: 3,
			householdId: houseA,
			ownerUserId: jordan.userId,
			visibility: 'household'
		});
		expect(created.createdAt).toBeInstanceOf(Date);
		expect(created.updatedAt).toBeInstanceOf(Date);
		expect(created.archivedAt).toBeNull();
		expect(created.completedAt).toBeNull();

		// A date column must come back as the day that was written, not shifted
		// by whatever timezone the process happens to run in.
		const raw = one(
			await sql<{ do_on: string }[]>`
				select do_on::text as do_on from tasks where id = ${created.id}::uuid
			`
		);
		expect(raw.do_on).toBe('2026-09-05');
	});

	it('clears a field when the patch sets it to null, and leaves absent fields alone', async () => {
		const task = ok(
			await createTask(sql, jordan, { title: 'with a date', doOn: '2026-09-05', notes: 'keep me' })
		);
		const cleared = ok(await updateTask(sql, jordan, task.id, { doOn: null }, task.updatedAt));
		expect(cleared.doOn).toBeNull();
		expect(cleared.notes).toBe('keep me');
	});

	it('dates a task when it is finished and undates it when it is reopened', async () => {
		const task = ok(await createTask(sql, jordan, { title: 'finish me' }));
		const done = ok(await updateTask(sql, jordan, task.id, { status: 'done' }, task.updatedAt));
		expect(done.completedAt).toBeInstanceOf(Date);

		const reopened = ok(await updateTask(sql, jordan, task.id, { status: 'todo' }, done.updatedAt));
		expect(reopened.completedAt).toBeNull();
	});

	it('refuses a blank title and an unknown status', async () => {
		expect(await createTask(sql, jordan, { title: '   ' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		expect(await createTask(sql, jordan, { title: 'ok', status: 'sideways' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('refuses a parent that would close a loop', async () => {
		const root = ok(await createTask(sql, jordan, { title: 'root' }));
		const child = ok(await createTask(sql, jordan, { title: 'child', parentTaskId: root.id }));
		const grandchild = ok(
			await createTask(sql, jordan, { title: 'grandchild', parentTaskId: child.id })
		);

		// The table's own constraint only stops a task parenting itself.
		const attempt = await updateTask(
			sql,
			jordan,
			root.id,
			{ parentTaskId: grandchild.id },
			root.updatedAt
		);
		expect(attempt).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('returns not found for a malformed id instead of raising', async () => {
		expect(await getTask(sql, jordan, 'not-a-uuid')).toBeNull();
		expect(await updateTask(sql, jordan, 'not-a-uuid', { title: 'x' }, new Date())).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});
});

describe('archiving', () => {
	it('hides a record from the default list and brings it back on request', async () => {
		const task = ok(await createTask(sql, jordan, { title: 'archive me' }));
		ok(await archiveTask(sql, jordan, task.id, task.updatedAt));

		expect(await listTasks(sql, jordan)).toHaveLength(0);
		const archived = await listTasks(sql, jordan, { includeArchived: true });
		expect(archived).toHaveLength(1);
		expect(archived[0]!.archivedAt).toBeInstanceOf(Date);

		// Recoverable, not destroyed: the row never left the table.
		const restored = ok(await unarchiveTask(sql, jordan, task.id));
		expect(restored.archivedAt).toBeNull();
		expect(await listTasks(sql, jordan)).toHaveLength(1);
	});

	it('works the same way for the other repositories', async () => {
		const area = ok(await createArea(sql, jordan, { name: 'Old area' }));
		ok(await archiveArea(sql, jordan, area.id, area.updatedAt));
		expect(await listAreas(sql, jordan)).toHaveLength(0);
		expect(await listAreas(sql, jordan, { includeArchived: true })).toHaveLength(1);
		ok(await unarchiveArea(sql, jordan, area.id));
		expect(await listAreas(sql, jordan)).toHaveLength(1);
	});
});

describe('filters', () => {
	it('selects by status, project, importance and free text', async () => {
		const project = ok(await createProject(sql, jordan, { name: 'Kitchen' }));
		ok(await createTask(sql, jordan, { title: 'Buy tiles', projectId: project.id }));
		ok(await createTask(sql, jordan, { title: 'Grout', projectId: project.id, status: 'done' }));
		ok(await createTask(sql, jordan, { title: 'Book the dentist', isImportant: true }));
		ok(await createTask(sql, jordan, { title: 'A template', isTemplate: true }));

		expect((await listTasks(sql, jordan, { status: 'open' })).map((t) => t.title).sort()).toEqual([
			'Book the dentist',
			'Buy tiles'
		]);
		expect(await listTasks(sql, jordan, { projectId: project.id })).toHaveLength(2);
		expect(await listTasks(sql, jordan, { projectId: null })).toHaveLength(1);
		expect(await listTasks(sql, jordan, { isImportant: true })).toHaveLength(1);
		expect((await listTasks(sql, jordan, { search: 'dent' })).map((t) => t.title)).toEqual([
			'Book the dentist'
		]);
		// A template is a stencil, not work, so it stays out unless asked for.
		expect(await listTasks(sql, jordan, { includeTemplates: true })).toHaveLength(4);
		expect(await countTasks(sql, jordan)).toBe(3);
	});

	it('treats a search term literally, wildcards included', async () => {
		ok(await createTask(sql, jordan, { title: '100% cotton sheets' }));
		ok(await createTask(sql, jordan, { title: 'Anything else' }));
		ok(await createTask(sql, jordan, { title: 'A_B testing' }));

		expect((await listTasks(sql, jordan, { search: '100%' })).map((t) => t.title)).toEqual([
			'100% cotton sheets'
		]);
		// A bare wildcard finds the row that literally contains one, not every
		// row — the pattern metacharacters belong to us, not to the searcher.
		expect((await listTasks(sql, jordan, { search: '%' })).map((t) => t.title)).toEqual([
			'100% cotton sheets'
		]);
		expect((await listTasks(sql, jordan, { search: 'A_B' })).map((t) => t.title)).toEqual([
			'A_B testing'
		]);
		expect(await listTasks(sql, jordan, { search: 'A%B' })).toHaveLength(0);
	});

	it('pages without dropping or repeating a row', async () => {
		for (let i = 0; i < 5; i++) {
			ok(await createTask(sql, jordan, { title: `task ${i}`, sortOrder: i }));
		}
		const first = await listTasks(sql, jordan, { order: 'manual', limit: 2 });
		const second = await listTasks(sql, jordan, { order: 'manual', limit: 2, offset: 2 });
		expect(first.map((t) => t.title)).toEqual(['task 0', 'task 1']);
		expect(second.map((t) => t.title)).toEqual(['task 2', 'task 3']);
	});

	it('finds either calendar date even when the earlier one is outside the window', async () => {
		ok(
			await createTask(sql, jordan, {
				title: 'deadline in September',
				doOn: '2026-08-01',
				deadlineOn: '2026-09-15'
			})
		);

		const tasks = await listTasks(sql, jordan, {
			scheduledFrom: '2026-09-01',
			scheduledTo: '2026-09-30'
		});
		expect(tasks.map((task) => task.title)).toEqual(['deadline in September']);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// derived queries
// ───────────────────────────────────────────────────────────────────────────

describe('what is due', () => {
	const TODAY = '2026-09-05'; // a Saturday; its week runs Mon 31 Aug – Sun 6 Sep

	async function seedAgenda() {
		ok(await createTask(sql, jordan, { title: 'overdue', doOn: '2026-09-01' }));
		ok(await createTask(sql, jordan, { title: 'today', doOn: TODAY }));
		ok(await createTask(sql, jordan, { title: 'tomorrow', doOn: '2026-09-06' }));
		ok(await createTask(sql, jordan, { title: 'next week', doOn: '2026-09-08' }));
		ok(await createTask(sql, jordan, { title: 'undated' }));
		ok(await createTask(sql, jordan, { title: 'done', doOn: '2026-09-01', status: 'done' }));
		ok(
			await createTask(sql, jordan, {
				title: 'deadline only',
				deadlineOn: '2026-09-06'
			})
		);
	}

	it('splits overdue, today and the rest of the week into disjoint buckets', async () => {
		await seedAgenda();
		const result = await agenda(sql, jordan, { today: TODAY });

		expect(result.week).toEqual({ start: '2026-08-31', end: '2026-09-06' });
		expect(result.overdue.map((t) => t.title)).toEqual(['overdue']);
		expect(result.dueToday.map((t) => t.title)).toEqual(['today']);
		expect(result.dueThisWeek.map((t) => t.title).sort()).toEqual(['deadline only', 'tomorrow']);

		// Disjoint: nothing appears in two buckets.
		const all = [...result.overdue, ...result.dueToday, ...result.dueThisWeek].map((t) => t.id);
		expect(new Set(all).size).toBe(all.length);

		// Finished, undated and next week's work are all out of scope.
		expect(all).toHaveLength(4);
	});

	it('uses the earlier of the do date and the deadline', async () => {
		ok(
			await createTask(sql, jordan, {
				title: 'starts today, due next week',
				doOn: TODAY,
				deadlineOn: '2026-09-30'
			})
		);
		const result = await agenda(sql, jordan, { today: TODAY });
		expect(result.dueToday.map((t) => t.title)).toEqual(['starts today, due next week']);
	});

	it('leaves out archived work and other people private work', async () => {
		ok(await createTask(sql, jordan, { title: 'mine', doOn: TODAY }));
		const archived = ok(await createTask(sql, jordan, { title: 'archived', doOn: TODAY }));
		ok(await archiveTask(sql, jordan, archived.id, archived.updatedAt));
		await seedTask(houseA, partner.userId, 'private', 'partner private');
		await seedTask(houseB, outsider.userId, 'household', 'other household');

		const result = await agenda(sql, jordan, { today: TODAY });
		expect(result.dueToday.map((t) => t.title)).toEqual(['mine']);
	});

	it('shows my own and the household unowned work, not my partner shared list', async () => {
		ok(await createTask(sql, jordan, { title: 'mine', doOn: TODAY }));
		ok(await createTask(sql, jordan, { title: 'ours', doOn: TODAY, ownerUserId: null }));
		ok(await createTask(sql, partner, { title: 'theirs', doOn: TODAY }));

		const mine = await agenda(sql, jordan, { today: TODAY });
		expect(mine.dueToday.map((t) => t.title).sort()).toEqual(['mine', 'ours']);

		// The partner's shared task is readable, so it can still be asked for.
		const everyone = await agenda(sql, jordan, { today: TODAY, assignee: 'anyone' });
		expect(everyone.dueToday.map((t) => t.title).sort()).toEqual(['mine', 'ours', 'theirs']);
	});

	it('resolves today from the household timezone', async () => {
		const day = await householdToday(sql, houseA);
		expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe('open task counts', () => {
	it('counts per project and per area, including the empty ones', async () => {
		const project = ok(await createProject(sql, jordan, { name: 'Kitchen' }));
		const empty = ok(await createProject(sql, jordan, { name: 'Nothing here' }));
		const area = ok(await createArea(sql, jordan, { name: 'Home' }));

		ok(await createTask(sql, jordan, { title: 'a', projectId: project.id, areaId: area.id }));
		ok(await createTask(sql, jordan, { title: 'b', projectId: project.id, status: 'done' }));
		ok(await createTask(sql, jordan, { title: 'c', projectId: project.id, status: 'dropped' }));
		ok(
			await createTask(sql, jordan, {
				title: 'late',
				projectId: project.id,
				doOn: '2026-09-01'
			})
		);

		const byProject = await openTaskCountsByProject(sql, jordan, { today: '2026-09-05' });
		const kitchen = byProject.find((c) => c.id === project.id)!;
		expect(kitchen).toMatchObject({ openCount: 2, totalCount: 4, overdueCount: 1 });
		expect(byProject.find((c) => c.id === empty.id)).toMatchObject({
			openCount: 0,
			totalCount: 0
		});

		const byArea = await openTaskCountsByArea(sql, jordan);
		expect(byArea.find((c) => c.id === area.id)).toMatchObject({ openCount: 1, totalCount: 1 });
	});

	it('does not let a private task raise a count the other member can see', async () => {
		// A number that moves is a disclosure: it says a record exists.
		const project = ok(
			await createProject(sql, jordan, { name: 'Shared project', ownerUserId: null })
		);
		await sql`
			insert into tasks (household_id, owner_user_id, visibility, title, project_id)
			values (${houseA}::uuid, ${jordan.userId}::uuid, 'private', 'private task',
			        ${project.id}::uuid)
		`;

		const asOwner = await openTaskCountsByProject(sql, jordan);
		expect(asOwner.find((c) => c.id === project.id)).toMatchObject({ openCount: 1 });

		const asPartner = await openTaskCountsByProject(sql, partner);
		expect(asPartner.find((c) => c.id === project.id)).toMatchObject({
			openCount: 0,
			totalCount: 0
		});
	});

	it('says nothing at all about another household', async () => {
		const theirs = ok(await createProject(sql, outsider, { name: 'their project' }));
		ok(await createTask(sql, outsider, { title: 'their task', projectId: theirs.id }));
		expect(await openTaskCountsByProject(sql, jordan)).toHaveLength(0);
	});
});

describe('habits', () => {
	it('reports the last day logged, and nudges a return once a day is missed', async () => {
		const habit = ok(await createHabit(sql, jordan, { name: 'Stretch' }));
		for (const day of ['2026-09-01', '2026-09-02', '2026-09-03']) {
			ok(await logHabit(sql, jordan, { habitId: habit.id, onDate: day }));
		}

		const summary = await habitSummary(sql, jordan, habit.id, {
			from: '2026-09-01',
			to: '2026-09-07',
			today: '2026-09-04'
		});
		expect(summary).not.toBeNull();
		expect(summary!.lastLoggedOn).toBe('2026-09-03');
		expect(summary!.planTheReturn).toBe(false);
		expect(summary!.completedCount).toBe(3);
		expect(summary!.expectedCount).toBe(7);

		// A whole day missed — not merely today still being open — is what the
		// nudge is for.
		const later = await habitSummary(sql, jordan, habit.id, {
			from: '2026-09-01',
			to: '2026-09-07',
			today: '2026-09-06'
		});
		expect(later!.lastLoggedOn).toBe('2026-09-03');
		expect(later!.planTheReturn).toBe(true);
	});

	it('is idempotent per day and can be undone', async () => {
		const habit = ok(await createHabit(sql, jordan, { name: 'Stretch' }));
		ok(await logHabit(sql, jordan, { habitId: habit.id, onDate: '2026-09-01' }));
		ok(await logHabit(sql, jordan, { habitId: habit.id, onDate: '2026-09-01', note: 'again' }));

		const logs = await listHabitLogs(sql, jordan, habit.id, {
			from: '2026-09-01',
			to: '2026-09-07'
		});
		expect(logs).toHaveLength(1);
		expect(logs[0]!.note).toBe('again');
		expect(logs[0]!.onDate).toBe('2026-09-01');

		expect(await unlogHabit(sql, jordan, habit.id, '2026-09-01')).toBe(true);
		expect(
			await listHabitLogs(sql, jordan, habit.id, { from: '2026-09-01', to: '2026-09-07' })
		).toHaveLength(0);
	});

	it('keeps each person check-ins to themselves', async () => {
		const habit = ok(await createHabit(sql, jordan, { name: 'Walk', ownerUserId: null }));
		ok(await logHabit(sql, jordan, { habitId: habit.id, onDate: '2026-09-01' }));
		ok(await logHabit(sql, partner, { habitId: habit.id, onDate: '2026-09-01' }));
		ok(await logHabit(sql, partner, { habitId: habit.id, onDate: '2026-09-02' }));

		const mine = await habitSummary(sql, jordan, habit.id, {
			from: '2026-09-01',
			to: '2026-09-02',
			today: '2026-09-02'
		});
		const theirs = await habitSummary(sql, partner, habit.id, {
			from: '2026-09-01',
			to: '2026-09-02',
			today: '2026-09-02'
		});
		expect(mine!.completedCount).toBe(1);
		expect(theirs!.completedCount).toBe(2);
	});

	it('refuses a check-in against another household habit', async () => {
		const theirs = ok(await createHabit(sql, outsider, { name: 'Their habit' }));
		expect(await logHabit(sql, jordan, { habitId: theirs.id, onDate: '2026-09-01' })).toMatchObject(
			{ ok: false, reason: 'not_found' }
		);
		expect(
			await habitSummary(sql, jordan, theirs.id, {
				from: '2026-09-01',
				to: '2026-09-07',
				today: '2026-09-05'
			})
		).toBeNull();
		expect(
			one(await sql<{ count: number }[]>`select count(*)::int as count from habit_logs`).count
		).toBe(0);
	});

	it('refuses a check-in against the other member private habit', async () => {
		const secret = ok(
			await createHabit(sql, partner, { name: 'Private habit', visibility: 'private' })
		);
		expect(await logHabit(sql, jordan, { habitId: secret.id, onDate: '2026-09-01' })).toMatchObject(
			{ ok: false, reason: 'not_found' }
		);
	});

	it('summarises every active habit in one pass', async () => {
		const a = ok(await createHabit(sql, jordan, { name: 'Water' }));
		ok(await createHabit(sql, jordan, { name: 'Retired', active: false }));
		ok(await logHabit(sql, jordan, { habitId: a.id, onDate: '2026-09-01' }));

		const all = await habitSummaries(sql, jordan, {
			from: '2026-09-01',
			to: '2026-09-07',
			today: '2026-09-01'
		});
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ habitId: a.id, lastLoggedOn: '2026-09-01' });
	});
});

describe('important dates', () => {
	const TODAY = '2026-09-05';

	it('resolves recurrence into the window rather than filtering on the stored date', async () => {
		ok(await createImportantDate(sql, jordan, { title: 'Dentist', onDate: '2026-09-10' }));
		ok(
			await createImportantDate(sql, jordan, {
				title: 'Birthday',
				onDate: '1985-09-08',
				recurrence: 'yearly'
			})
		);
		ok(
			await createImportantDate(sql, jordan, {
				title: 'Far off birthday',
				onDate: '1985-11-20',
				recurrence: 'yearly'
			})
		);
		ok(await createImportantDate(sql, jordan, { title: 'Long past', onDate: '2026-08-01' }));

		const soon = await upcomingImportantDates(sql, jordan, { today: TODAY, days: 30 });
		expect(soon.map((u) => u.record.title)).toEqual(['Birthday', 'Dentist']);
		expect(soon[0]!.nextOn).toBe('2026-09-08');
		expect(soon[0]!.daysAway).toBe(3);

		const wider = await upcomingImportantDates(sql, jordan, { today: TODAY, days: 120 });
		expect(wider.map((u) => u.record.title)).toEqual(['Birthday', 'Dentist', 'Far off birthday']);
	});

	it('flags a reminder once its lead time is reached', async () => {
		ok(
			await createImportantDate(sql, jordan, {
				title: 'Anniversary',
				onDate: '2026-09-12',
				remindDaysBefore: 7
			})
		);
		const [entry] = await upcomingImportantDates(sql, jordan, { today: TODAY, days: 30 });
		expect(entry!.daysAway).toBe(7);
		expect(entry!.reminderDue).toBe(true);
	});

	it('keeps the other member private dates out of the list', async () => {
		ok(
			await createImportantDate(sql, partner, {
				title: 'A private date',
				onDate: '2026-09-06',
				visibility: 'private'
			})
		);
		expect(await upcomingImportantDates(sql, jordan, { today: TODAY, days: 30 })).toHaveLength(0);
		expect(await upcomingImportantDates(sql, partner, { today: TODAY, days: 30 })).toHaveLength(1);
	});
});

describe('tags', () => {
	it('are shared by the household and attach to a record', async () => {
		const tag = ok(await createTag(sql, jordan, { name: 'errands' }));
		const task = ok(await createTask(sql, jordan, { title: 'Post the parcel' }));

		ok(await attachTag(sql, jordan, tag.id, 'task', task.id));
		expect((await tagsForEntity(sql, jordan, 'task', task.id)).map((t) => t.name)).toEqual([
			'errands'
		]);
		// The partner can see the household's tags and the shared task's tags.
		expect(await tagsForEntity(sql, partner, 'task', task.id)).toHaveLength(1);
		expect(await listTasks(sql, jordan, { tagId: tag.id })).toHaveLength(1);

		// Attaching twice is the same as attaching once.
		ok(await attachTag(sql, jordan, tag.id, 'task', task.id));
		expect(await tagsForEntity(sql, jordan, 'task', task.id)).toHaveLength(1);

		expect(await detachTag(sql, jordan, tag.id, 'task', task.id)).toBe(true);
		expect(await tagsForEntity(sql, jordan, 'task', task.id)).toHaveLength(0);
	});

	it('cannot be attached across a household boundary', async () => {
		const ourTag = ok(await createTag(sql, jordan, { name: 'ours' }));
		const theirTask = ok(await createTask(sql, outsider, { title: 'their task' }));
		expect(await attachTag(sql, jordan, ourTag.id, 'task', theirTask.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(
			one(await sql<{ count: number }[]>`select count(*)::int as count from entity_tags`).count
		).toBe(0);
	});

	it('cannot be attached to a record the viewer may not change', async () => {
		const tag = ok(await createTag(sql, partner, { name: 'partner tag' }));
		const jordanTask = ok(await createTask(sql, jordan, { title: 'jordan task' }));
		expect(await attachTag(sql, partner, tag.id, 'task', jordanTask.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('refuses an entity type that is not taggable', async () => {
		const tag = ok(await createTag(sql, jordan, { name: 'x' }));
		const result = await attachTag(
			sql,
			jordan,
			tag.id,
			'sessions' as 'task',
			'11111111-1111-1111-1111-111111111111'
		);
		expect(result).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses a duplicate name in the same household but allows it in another', async () => {
		ok(await createTag(sql, jordan, { name: 'shared name' }));
		expect(await createTag(sql, partner, { name: 'shared name' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		expect(await createTag(sql, outsider, { name: 'shared name' })).toMatchObject({ ok: true });
	});
});

describe('daily logs', () => {
	it('holds one entry per person per day', async () => {
		ok(await createDailyLog(sql, jordan, { onDate: '2026-09-05', note: 'a good day' }));
		expect(await createDailyLog(sql, jordan, { onDate: '2026-09-05' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		// The other member's day is their own record.
		expect(await createDailyLog(sql, partner, { onDate: '2026-09-05' })).toMatchObject({
			ok: true
		});
	});

	it('round-trips the day and the energy level', async () => {
		const log = ok(
			await createDailyLog(sql, jordan, {
				onDate: '2026-09-05',
				energyLevel: 4,
				mood: 'steady',
				gratitude: 'quiet morning'
			})
		);
		expect(log).toMatchObject({ onDate: '2026-09-05', energyLevel: 4, mood: 'steady' });
		const found = await getDailyLogForDate(sql, jordan, '2026-09-05');
		expect(found?.id).toBe(log.id);

		const updated = ok(
			await updateDailyLog(sql, jordan, log.id, { energyLevel: 2 }, log.updatedAt)
		);
		expect(updated.energyLevel).toBe(2);
		expect(updated.gratitude).toBe('quiet morning');
	});

	it('refuses an energy level outside the scale the column allows', async () => {
		expect(
			await createDailyLog(sql, jordan, { onDate: '2026-09-05', energyLevel: 9 })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

// ───────────────────────────────────────────────────────────────────────────
// transactions
// ───────────────────────────────────────────────────────────────────────────

describe('composing inside a transaction', () => {
	it('writes several records atomically', async () => {
		const titles = await sql.begin(async (tx) => {
			const project = ok(await createProject(tx, jordan, { name: 'Weekend' }));
			ok(await createTask(tx, jordan, { title: 'Buy paint', projectId: project.id }));
			ok(await createTask(tx, jordan, { title: 'Move furniture', projectId: project.id }));
			return (await listTasks(tx, jordan)).map((t: TaskRecord) => t.title);
		});
		expect(titles.sort()).toEqual(['Buy paint', 'Move furniture']);
		expect(await countTasks(sql, jordan)).toBe(2);
	});

	it('leaves nothing behind when the transaction rolls back', async () => {
		await expect(
			sql.begin(async (tx) => {
				ok(await createProject(tx, jordan, { name: 'Abandoned' }));
				ok(await createTask(tx, jordan, { title: 'Never happened' }));
				throw new Error('rolled back on purpose');
			})
		).rejects.toThrow('rolled back on purpose');

		expect(await countTasks(sql, jordan)).toBe(0);
		expect(await listProjects(sql, jordan)).toHaveLength(0);
	});

	it('refuses a scoped write inside a transaction just as it does outside', async () => {
		const theirs = await seedTask(houseB, outsider.userId, 'household', 'their task');
		await sql.begin(async (tx) => {
			expect(
				await updateTask(tx, jordan, theirs.id, { title: 'x' }, theirs.updatedAt)
			).toMatchObject({ ok: false, reason: 'not_found' });
		});
	});
});

describe('task theme and category (migration 0038)', () => {
	it('saves both, filters by either, and leaves them independent of each other', async () => {
		const rent = ok(
			await createTask(sql, jordan, {
				title: 'Pay rent',
				theme: 'money_admin',
				category: 'hard_deadline'
			})
		);
		const plants = ok(
			await createTask(sql, jordan, { title: 'Water the plants', theme: 'home_environment' })
		);
		ok(await createTask(sql, jordan, { title: 'Untouched task' }));

		expect(rent).toMatchObject({ theme: 'money_admin', category: 'hard_deadline' });
		expect(plants).toMatchObject({ theme: 'home_environment', category: null });

		expect((await listTasks(sql, jordan, { theme: 'money_admin' })).map((t) => t.title)).toEqual([
			'Pay rent'
		]);
		expect(
			(await listTasks(sql, jordan, { category: 'hard_deadline' })).map((t) => t.title)
		).toEqual(['Pay rent']);
		expect(
			(await listTasks(sql, jordan, { theme: 'home_environment' })).map((t) => t.title)
		).toEqual(['Water the plants']);

		// Changing one leaves the other exactly as it was.
		const recategorised = ok(
			await updateTask(sql, jordan, rent.id, { category: 'parking_lot' }, rent.updatedAt)
		);
		expect(recategorised).toMatchObject({ theme: 'money_admin', category: 'parking_lot' });
	});

	it('refuses a theme or category outside the known set', async () => {
		expect(
			await createTask(sql, jordan, { title: 'Bad theme', theme: 'not-a-theme' })
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect(
			await createTask(sql, jordan, { title: 'Bad category', category: 'not-a-category' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

describe('daily log check-in, daily life and reflection (migration 0038)', () => {
	it('round-trips every new field', async () => {
		const created = ok(
			await createDailyLog(sql, jordan, {
				onDate: '2026-10-05',
				intention: 'Get the taxes filed',
				patternTags: ['Low energy', 'Rainy day', 'low energy'],
				theme: 'money_admin',
				activation: 2,
				effectiveness: 4,
				headSpace: 'Foggy but willing',
				water: 6,
				caffeine: 2,
				carbonation: 1,
				wins: 'Filed one form',
				challenges: 'Kept putting it off',
				worthKeeping: 'Did it anyway',
				anythingElse: 'Tomorrow: the rest'
			})
		);
		expect(created).toMatchObject({
			intention: 'Get the taxes filed',
			// Deduped case-insensitively, keeping the first spelling -- the
			// same rule reading.ts's own moods/tags already follow.
			patternTags: ['Low energy', 'Rainy day'],
			theme: 'money_admin',
			activation: 2,
			effectiveness: 4,
			headSpace: 'Foggy but willing',
			water: 6,
			caffeine: 2,
			carbonation: 1,
			wins: 'Filed one form',
			challenges: 'Kept putting it off',
			worthKeeping: 'Did it anyway',
			anythingElse: 'Tomorrow: the rest'
		});

		const edited = ok(
			await updateDailyLog(sql, jordan, created.id, { water: 8, theme: 'reset' }, created.updatedAt)
		);
		// Editing one field leaves the rest exactly as they were.
		expect(edited).toMatchObject({
			water: 8,
			theme: 'reset',
			intention: 'Get the taxes filed',
			patternTags: ['Low energy', 'Rainy day']
		});
	});

	it('refuses activation, effectiveness, water, caffeine and carbonation out of range', async () => {
		const bad = (field: string, value: unknown) =>
			createDailyLog(sql, jordan, { onDate: '2026-10-06', [field]: value });
		expect(await bad('activation', 0)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await bad('activation', 6)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await bad('effectiveness', 0)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await bad('effectiveness', 6)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await bad('water', 51)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await bad('water', -1)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await bad('caffeine', 51)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await bad('carbonation', 51)).toMatchObject({ ok: false, reason: 'invalid' });
		// None of the refusals above left a row behind to collide with this one.
		expect(await createDailyLog(sql, jordan, { onDate: '2026-10-06', water: 10 })).toMatchObject({
			ok: true
		});
	});

	it('refuses a theme outside the known set', async () => {
		expect(
			await createDailyLog(sql, jordan, { onDate: '2026-10-07', theme: 'not-a-theme' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

describe('through a client configured the way the app’s is', () => {
	it('writes the new task and daily-log fields without sending a bare JS Date', async () => {
		// `$lib/server/db` also hands its client to drizzle(), which replaces
		// the driver's timestamp serializers with pass-throughs, so a JS Date
		// sent as a parameter reaches the wire unconverted and throws. Neither
		// write path below ever builds one; this is what proves it, the same
		// way health-measurements.test.ts proves it for its own two.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const log = ok(
				await createDailyLog(appLike, jordan, {
					onDate: '2026-10-08',
					intention: 'Through a drizzle-wrapped client',
					activation: 3
				})
			);
			const editedLog = ok(
				await updateDailyLog(appLike, jordan, log.id, { water: 4 }, log.updatedAt)
			);
			expect(editedLog).toMatchObject({ water: 4, activation: 3 });

			const task = ok(
				await createTask(appLike, jordan, {
					title: 'Through a drizzle-wrapped client',
					theme: 'reset'
				})
			);
			const editedTask = ok(
				await updateTask(appLike, jordan, task.id, { category: 'parking_lot' }, task.updatedAt)
			);
			expect(editedTask).toMatchObject({ theme: 'reset', category: 'parking_lot' });
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
