import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	archivedCounts,
	createArea,
	createTag,
	createTask,
	listArchived,
	listTasks,
	restore,
	setTagArchived,
	setTaskArchived
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

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
