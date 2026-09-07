import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '$lib/server/db';
import { readiness } from '$lib/server/health/checks';

/**
 * Runs against a real PostgreSQL (the CI `postgres` service, or `./run.sh up`
 * locally). These assertions are the counterpart to the e2e smoke tests,
 * which cover the database-unreachable case.
 */

afterAll(async () => {
	await sql.end({ timeout: 5 });
});

describe('database connection', () => {
	it('connects and executes a query', async () => {
		const rows = await sql<{ one: number }[]>`select 1 as one`;
		expect(rows[0]?.one).toBe(1);
	});

	it('applies the configured statement_timeout to the session', async () => {
		// Guards the `connection` option in db/index.ts: postgres.js silently
		// ignores unknown top-level options, so a misplaced setting would look
		// fine while leaving queries able to pin a connection indefinitely.
		// SHOW names the result column after the setting itself. The server
		// default is '0' (no timeout), so '15s' proves our value was applied
		// rather than merely read back.
		const rows = await sql<{ statement_timeout: string }[]>`show statement_timeout`;
		expect(rows[0]?.statement_timeout).toBe('15s');
	});
});

describe('readiness against a live database', () => {
	it('reports the database check as ok', async () => {
		const result = await readiness();
		const db = result.checks.find((c) => c.name === 'database');
		expect(db?.status).toBe('ok');
	});

	it('reports the custom migration runner as applied', async () => {
		// CI runs scripts/migrate.mjs before integration tests. The health check
		// must inspect that runner's schema_migrations table rather than the
		// unrelated default table name used by Drizzle Kit.
		const result = await readiness();
		const migrations = result.checks.find((c) => c.name === 'migrations');
		expect(migrations?.status).toBe('ok');
	});

	it('reports a fresh successful backup as healthy', async () => {
		const [backup] = await sql<{ id: string }[]>`
			insert into backup_runs (status, kind, finished_at)
			values ('success', 'manual', now())
			returning id
		`;

		try {
			const result = await readiness();
			const check = result.checks.find((c) => c.name === 'backup');
			expect(check?.status).toBe('ok');
			expect(check?.detail).toBe('0h old');
		} finally {
			if (backup) await sql`delete from backup_runs where id = ${backup.id}`;
		}
	});
});
