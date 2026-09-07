import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import { OPEN_STATUSES, createTask, listTasks, updateTask } from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The inbox as a status (migration 0008), rather than as a view over unfiled
 * tasks. These cover the two things that make it a status: it survives the
 * CHECK constraint, and it counts as work rather than disappearing until
 * someone triages it.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let viewer: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	viewer = viewerOf(
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
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const make = async (title: string, status?: string) => {
	const result = await createTask(sql, viewer, { title, ...(status ? { status } : {}) });
	if (!result.ok) throw new Error(`could not create ${title}: ${JSON.stringify(result)}`);
	return result.record;
};

describe('the inbox', () => {
	it('accepts inbox as a status, so capture has somewhere to land', async () => {
		const task = await make('Sort this out later', 'inbox');
		expect(task.status).toBe('inbox');

		// Proves the CHECK constraint was actually widened rather than the value
		// being coerced somewhere on the way down.
		const stored = one(
			await sql<{ status: string }[]>`select status from tasks where id = ${task.id}::uuid`
		);
		expect(stored.status).toBe('inbox');
	});

	it('lists only what is waiting to be triaged', async () => {
		await make('Untriaged', 'inbox');
		await make('Already a to-do');

		const waiting = await listTasks(sql, viewer, { status: 'inbox' });
		expect(waiting.map((t) => t.title)).toEqual(['Untriaged']);
	});

	it('counts an untriaged task as open, so capture is not a black hole', async () => {
		// If `inbox` were excluded from the open statuses, dropping something in
		// would remove it from every list until it was filed — the one failure
		// mode that makes people stop trusting a capture box.
		expect(OPEN_STATUSES).toContain('inbox');

		await make('Untriaged', 'inbox');
		const open = await listTasks(sql, viewer, { status: 'open' });
		expect(open.map((t) => t.title)).toContain('Untriaged');
	});

	it('leaves the inbox when it is filed', async () => {
		const task = await make('Untriaged', 'inbox');

		const filed = await updateTask(sql, viewer, task.id, { status: 'todo' }, task.updatedAt);
		expect(filed).toMatchObject({ ok: true });

		expect(await listTasks(sql, viewer, { status: 'inbox' })).toHaveLength(0);
	});

	it('refuses a status the constraint does not know', async () => {
		const result = await createTask(sql, viewer, { title: 'Nonsense', status: 'sideways' });
		expect(result).toMatchObject({ ok: false, reason: 'invalid' });
	});
});
