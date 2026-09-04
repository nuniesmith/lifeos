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

	it('reports migrations as failing before any migration has run', async () => {
		// Phase 2 introduces migrations. Until then this must fail rather than
		// pass silently, or the deploy gate would accept an unmigrated database.
		const result = await readiness();
		const migrations = result.checks.find((c) => c.name === 'migrations');
		expect(migrations?.status).toBe('fail');
		expect(result.status).toBe('fail');
	});
});
