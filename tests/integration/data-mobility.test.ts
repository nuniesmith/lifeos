import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const baseUrl = new URL(process.env.DATABASE_URL!);
const suffix = String(process.pid);
const sourceName = `lifeos_mobility_source_${suffix}`;
const targetName = `lifeos_mobility_target_${suffix}`;
const sourceUrl = new URL(baseUrl);
const targetUrl = new URL(baseUrl);
sourceUrl.pathname = `/${sourceName}`;
targetUrl.pathname = `/${targetName}`;

const maintenanceUrl = new URL(baseUrl);
maintenanceUrl.pathname = '/postgres';
const maintenance = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => {} });

let workspace = '';
let sourceHousehold = '';
let targetHousehold = '';
let targetUser = '';

async function command(script: string, args: string[], databaseUrl: URL, uploadDir: string) {
	return run('node', [script, ...args], {
		cwd: root,
		env: {
			...process.env,
			DATABASE_URL: databaseUrl.toString(),
			MIGRATION_DATABASE_URL: '',
			LIFEOS_UPLOAD_DIR: uploadDir
		}
	});
}

beforeAll(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'lifeos-mobility-test-'));
	for (const name of [sourceName, targetName]) {
		await maintenance.unsafe(`drop database if exists "${name}" with (force)`);
		await maintenance.unsafe(`create database "${name}"`);
	}
	await command('scripts/migrate.mjs', [], sourceUrl, join(workspace, 'source-uploads'));
	await command('scripts/migrate.mjs', [], targetUrl, join(workspace, 'target-uploads'));

	const source = postgres(sourceUrl.toString(), { max: 1, onnotice: () => {} });
	try {
		const sourceHouseholds = await source<{ id: string }[]>`
			insert into households (name) values ('Portable source') returning id
		`;
		sourceHousehold = sourceHouseholds[0]!.id;
		const sourceUsers = await source<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash, must_change_credentials)
			values ('portable-source', 'Portable Source', 'admin', 'not-used-by-this-test', false)
			returning id
		`;
		const sourceUser = sourceUsers[0]!.id;
		await source`
			insert into household_members (household_id, user_id)
			values (${sourceHousehold}::uuid, ${sourceUser}::uuid)
		`;

		const parentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
		const childId = '00000000-0000-4000-8000-000000000001';
		await source`
			insert into tasks (id, household_id, owner_user_id, title, created_by, updated_by)
			values (${parentId}::uuid, ${sourceHousehold}::uuid, ${sourceUser}::uuid,
			        'Parent task', ${sourceUser}::uuid, ${sourceUser}::uuid)
		`;
		await source`
			insert into tasks (
				id, household_id, owner_user_id, title, parent_task_id, created_by, updated_by
			) values (
				${childId}::uuid, ${sourceHousehold}::uuid, ${sourceUser}::uuid,
				'Child task', ${parentId}::uuid, ${sourceUser}::uuid, ${sourceUser}::uuid
			)
		`;

		const habits = await source<{ id: string }[]>`
			insert into habits (household_id, owner_user_id, name, created_by, updated_by)
			values (${sourceHousehold}::uuid, ${sourceUser}::uuid, 'Drink water',
			        ${sourceUser}::uuid, ${sourceUser}::uuid)
			returning id
		`;
		const habitId = habits[0]!.id;
		await source`
			insert into habit_logs (habit_id, user_id, on_date)
			values (${habitId}::uuid, ${sourceUser}::uuid, '2026-09-06')
		`;
	} finally {
		await source.end({ timeout: 5 });
	}

	const target = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });
	try {
		const targetHouseholds = await target<{ id: string }[]>`
			insert into households (name) values ('Portable target') returning id
		`;
		targetHousehold = targetHouseholds[0]!.id;
		const targetUsers = await target<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash, must_change_credentials)
			values ('portable-target', 'Portable Target', 'admin', 'not-used-by-this-test', false)
			returning id
		`;
		targetUser = targetUsers[0]!.id;
		await target`
			insert into household_members (household_id, user_id)
			values (${targetHousehold}::uuid, ${targetUser}::uuid)
		`;
	} finally {
		await target.end({ timeout: 5 });
	}
}, 30_000);

/**
 * Drops a temporary database, waiting out the lock rather than failing on it.
 *
 * `drop database ... with (force)` needs an exclusive lock, and on a server the
 * rest of the integration suite is working against it can lose that race to a
 * connection that appears between the terminate and the drop. That showed up as
 * an intermittent teardown timeout that looked like a product failure and was
 * not one: the work never changed, only how busy the server was.
 *
 * Retrying is right here and would be wrong in application code — this is
 * cleanup of something this file created, so the only question is whether it
 * eventually goes, and a database left behind would break the next run.
 */
async function dropDatabase(name: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await maintenance.unsafe(`drop database if exists "${name}" with (force)`);
			return;
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
		}
	}
	throw lastError;
}

afterAll(async () => {
	for (const name of [sourceName, targetName]) {
		await dropDatabase(name);
	}
	await maintenance.end({ timeout: 5 });
	if (workspace) await rm(workspace, { recursive: true, force: true });
	// Generous, and deliberately so: two DDL statements against a shared server
	// are not a 10-second proposition when the suite is busy.
}, 60_000);

describe('portable data mobility', () => {
	it('dry-runs and restores parented tasks and habit ownership onto a fresh system', async () => {
		const exportDir = join(workspace, 'export');
		await command(
			'scripts/export-data.mjs',
			['--output', exportDir, '--household-id', sourceHousehold],
			sourceUrl,
			join(workspace, 'source-uploads')
		);

		await command(
			'scripts/restore-data.mjs',
			[
				'--input',
				exportDir,
				'--household-id',
				targetHousehold,
				'--owner-user',
				'portable-target',
				'--dry-run'
			],
			targetUrl,
			join(workspace, 'target-uploads')
		);

		const target = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });
		try {
			const before = await target`select count(*)::int as count from tasks`;
			expect(before[0]?.count).toBe(0);
		} finally {
			await target.end({ timeout: 5 });
		}

		await command(
			'scripts/restore-data.mjs',
			[
				'--input',
				exportDir,
				'--household-id',
				targetHousehold,
				'--owner-user',
				'portable-target',
				'--apply'
			],
			targetUrl,
			join(workspace, 'target-uploads')
		);

		const restored = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });
		try {
			const tasks = await restored`
				select title, parent_task_id::text as parent_task_id, owner_user_id::text as owner_user_id
				from tasks order by title
			`;
			expect(tasks).toHaveLength(2);
			expect(tasks.find((row) => row.title === 'Child task')?.parent_task_id).toBe(
				'ffffffff-ffff-4fff-8fff-ffffffffffff'
			);
			expect(tasks.every((row) => row.owner_user_id === targetUser)).toBe(true);

			const logs = await restored`select user_id::text as user_id from habit_logs`;
			expect(logs).toEqual([{ user_id: targetUser }]);

			const otherHouseholds = await restored<{ id: string }[]>`
				insert into households (name) values ('Other target') returning id
			`;
			const otherUsers = await restored<{ id: string }[]>`
				insert into users (username, display_name, role, password_hash, must_change_credentials)
				values ('portable-other', 'Portable Other', 'admin', 'not-used-by-this-test', false)
				returning id
			`;
			await restored`
				insert into household_members (household_id, user_id)
				values (${otherHouseholds[0]!.id}::uuid, ${otherUsers[0]!.id}::uuid)
			`;

			await expect(
				command(
					'scripts/restore-data.mjs',
					[
						'--input',
						exportDir,
						'--household-id',
						otherHouseholds[0]!.id,
						'--owner-user',
						'portable-other',
						'--apply'
					],
					targetUrl,
					join(workspace, 'target-uploads')
				)
			).rejects.toMatchObject({ stderr: expect.stringContaining('refusing to move tasks') });
		} finally {
			await restored.end({ timeout: 5 });
		}
	});

	it('requires explicit consent before collapsing multiple source users', async () => {
		const source = postgres(sourceUrl.toString(), { max: 1, onnotice: () => {} });
		try {
			const users = await source<{ id: string }[]>`
				insert into users (username, display_name, role, password_hash, must_change_credentials)
				values ('portable-source-two', 'Portable Source Two', 'member', 'not-used-by-this-test', false)
				returning id
			`;
			await source`
				insert into household_members (household_id, user_id)
				values (${sourceHousehold}::uuid, ${users[0]!.id}::uuid)
			`;
		} finally {
			await source.end({ timeout: 5 });
		}

		const exportDir = join(workspace, 'multi-user-export');
		await command(
			'scripts/export-data.mjs',
			['--output', exportDir, '--household-id', sourceHousehold],
			sourceUrl,
			join(workspace, 'source-uploads')
		);

		const restoreArgs = [
			'--input',
			exportDir,
			'--household-id',
			targetHousehold,
			'--owner-user',
			'portable-target',
			'--dry-run'
		];
		await expect(
			command('scripts/restore-data.mjs', restoreArgs, targetUrl, join(workspace, 'target-uploads'))
		).rejects.toMatchObject({ stderr: expect.stringContaining('add --collapse-users') });

		await expect(
			command(
				'scripts/restore-data.mjs',
				[...restoreArgs, '--collapse-users'],
				targetUrl,
				join(workspace, 'target-uploads')
			)
		).resolves.toMatchObject({ stdout: expect.stringContaining('Validated') });
	});
});
