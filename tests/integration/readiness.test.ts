import { mkdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The readiness probes (OPS-011) that /api/health/ready and the uptime monitor
 * read. health.test.ts covers how checks combine; this covers the checks.
 *
 * The env module parses process.env once, when first imported, so each case
 * that changes a variable imports the probes afresh.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

async function probes(env: Record<string, string> = {}) {
	vi.resetModules();
	for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
	return import('$lib/server/health/checks');
}

const backup = async (env: Record<string, string> = {}) =>
	(await (await probes(env)).readiness()).checks.find((c) => c.name === 'backup');

async function finishedBackup(hoursAgo: number) {
	await sql`
		insert into backup_runs (started_at, finished_at, status, kind)
		values (now() - make_interval(hours => ${hoursAgo}), now() - make_interval(hours => ${hoursAgo}),
		        'success', 'scheduled')
	`;
}

beforeAll(async () => {
	// The storage probe statfs's the upload directory (vite.config.ts sets it).
	await mkdir(process.env.LIFEOS_UPLOAD_DIR!, { recursive: true });
	await sql`delete from backup_runs`;
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await sql`delete from backup_runs`;
});

afterAll(async () => {
	await sql.end({ timeout: 5 });
});

describe('readiness', () => {
	it('has the database, migrations, storage and disk ok on a working install', async () => {
		const { readiness } = await probes();
		const { checks } = await readiness();
		for (const name of ['database', 'migrations', 'storage', 'disk']) {
			const check = checks.find((c) => c.name === name);
			// The disk can legitimately be degraded on a full development box;
			// what must never happen on a working install is a failure.
			expect(check?.status, `${name}: ${check?.detail}`).not.toBe('fail');
		}
	});

	it('is degraded with no successful backup at all', async () => {
		expect(await backup()).toEqual({
			name: 'backup',
			status: 'degraded',
			detail: 'no successful backup'
		});
	});

	it('ignores a backup that did not succeed', async () => {
		await sql`insert into backup_runs (finished_at, status) values (now(), 'failed')`;
		expect((await backup())?.status).toBe('degraded');
	});

	it('is ok with a backup from the last 36 hours, and says how old', async () => {
		await finishedBackup(5);
		expect(await backup()).toEqual({ name: 'backup', status: 'ok', detail: '5h old' });
	});

	it('fails once the newest backup is more than 36 hours old', async () => {
		await finishedBackup(40);
		expect(await backup()).toEqual({ name: 'backup', status: 'fail', detail: '40h old' });
	});

	it('expects no backup with LIFEOS_BACKUP_CHECK=off, and says so', async () => {
		await finishedBackup(400);
		expect(await backup({ LIFEOS_BACKUP_CHECK: 'off' })).toEqual({
			name: 'backup',
			status: 'ok',
			detail: 'not expected (LIFEOS_BACKUP_CHECK=off)'
		});
		// With it off, readiness is whatever the other checks make it. (Not
		// simply ok: the disk check is degraded on a development box over 70%.)
		const { readiness } = await probes({ LIFEOS_BACKUP_CHECK: 'off' });
		const { worst } = await import('$lib/server/health/status');
		const result = await readiness();
		expect(result.status).toBe(worst(result.checks.filter((c) => c.name !== 'backup')));
	});
});
