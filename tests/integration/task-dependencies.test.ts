import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addTaskDependency,
	createTask,
	listTaskDependencies,
	removeTaskDependency
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;
let householdId: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
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

describe('task dependencies', () => {
	it('records an edge and reports it from both ends', async () => {
		const a = await makeTask(owner, 'Ship the thing');
		const b = await makeTask(owner, 'Write the docs');

		expect(await addTaskDependency(sql, owner, a, b)).toMatchObject({ ok: true });

		const forA = await listTaskDependencies(sql, owner, a);
		expect(forA.blockedBy.map((d) => d.title)).toEqual(['Write the docs']);
		expect(forA.blocking).toHaveLength(0);

		// The same single row, seen from the other side.
		const forB = await listTaskDependencies(sql, owner, b);
		expect(forB.blocking.map((d) => d.title)).toEqual(['Ship the thing']);
		expect(forB.blockedBy).toHaveLength(0);
	});

	it('is idempotent', async () => {
		const a = await makeTask(owner, 'A');
		const b = await makeTask(owner, 'B');
		await addTaskDependency(sql, owner, a, b);
		await addTaskDependency(sql, owner, a, b);
		expect((await listTaskDependencies(sql, owner, a)).blockedBy).toHaveLength(1);
	});

	it('refuses a task depending on itself', async () => {
		const a = await makeTask(owner, 'A');
		expect(await addTaskDependency(sql, owner, a, a)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('refuses a direct cycle', async () => {
		const a = await makeTask(owner, 'A');
		const b = await makeTask(owner, 'B');
		await addTaskDependency(sql, owner, a, b);

		// b already waits on a transitively; closing the loop leaves neither
		// task ever actionable.
		expect(await addTaskDependency(sql, owner, b, a)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('refuses an indirect cycle three links long', async () => {
		const a = await makeTask(owner, 'A');
		const b = await makeTask(owner, 'B');
		const c = await makeTask(owner, 'C');
		await addTaskDependency(sql, owner, a, b);
		await addTaskDependency(sql, owner, b, c);

		expect(await addTaskDependency(sql, owner, c, a)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		// And the graph is unchanged by the refusal.
		expect((await listTaskDependencies(sql, owner, c)).blockedBy).toHaveLength(0);
	});

	it('allows a diamond, which is not a cycle', async () => {
		const top = await makeTask(owner, 'Top');
		const left = await makeTask(owner, 'Left');
		const right = await makeTask(owner, 'Right');
		await addTaskDependency(sql, owner, top, left);
		await addTaskDependency(sql, owner, top, right);
		const bottom = await makeTask(owner, 'Bottom');
		expect(await addTaskDependency(sql, owner, left, bottom)).toMatchObject({ ok: true });
		expect(await addTaskDependency(sql, owner, right, bottom)).toMatchObject({ ok: true });
	});

	it('removes an edge and reports whether there was one', async () => {
		const a = await makeTask(owner, 'A');
		const b = await makeTask(owner, 'B');
		await addTaskDependency(sql, owner, a, b);

		expect(await removeTaskDependency(sql, owner, a, b)).toBe(true);
		expect(await removeTaskDependency(sql, owner, a, b)).toBe(false);
		expect((await listTaskDependencies(sql, owner, a)).blockedBy).toHaveLength(0);
	});
});

describe('dependency authorization', () => {
	it('does not leak the title of a task the viewer cannot read', async () => {
		const shared = await makeTask(owner, 'Shared errand');
		const secret = await makeTask(owner, 'Therapy appointment', 'private');
		await addTaskDependency(sql, owner, shared, secret);

		// The owner sees the edge.
		expect((await listTaskDependencies(sql, owner, shared)).blockedBy).toHaveLength(1);

		// The partner can read `shared` but not the private task it waits on.
		// The edge must disappear rather than surface its title through a join.
		const seen = await listTaskDependencies(sql, partner, shared);
		expect(seen.blockedBy).toHaveLength(0);
		expect(JSON.stringify(seen)).not.toContain('Therapy');
	});

	it('refuses to add an edge from a task the viewer cannot write', async () => {
		const theirs = await makeTask(partner, 'Partner task', 'private');
		const mine = await makeTask(owner, 'My task');
		expect(await addTaskDependency(sql, owner, theirs, mine)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('refuses to remove an edge on a task the viewer cannot write', async () => {
		const theirs = await makeTask(partner, 'Partner task');
		const other = await makeTask(partner, 'Another partner task');
		await addTaskDependency(sql, partner, theirs, other);

		expect(await removeTaskDependency(sql, owner, theirs, other)).toBe(false);
		expect((await listTaskDependencies(sql, partner, theirs)).blockedBy).toHaveLength(1);
	});
});
