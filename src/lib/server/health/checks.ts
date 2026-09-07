import { statfs } from 'node:fs/promises';
import { sql } from '../db';
import { env } from '../env';
import { logger } from '../logger';
import { worst, type Check, type Readiness } from './status';

/** Disk headroom thresholds, matching the OPS-014 alert levels. */
const DISK_WARN = 0.7;
const DISK_CRIT = 0.85;

/** A backup older than this is treated as a failure, not a warning. */
const BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;

async function checkDatabase(): Promise<Check> {
	try {
		await sql`select 1`;
		return { name: 'database', status: 'ok' };
	} catch (err) {
		return { name: 'database', status: 'fail', detail: (err as Error).message };
	}
}

async function checkMigrations(): Promise<Check> {
	try {
		const rows = await sql<{ count: number }[]>`
			select count(*)::int as count
			from information_schema.tables
			where table_schema = 'public' and table_name = 'schema_migrations'
		`;
		if (!rows[0]?.count) {
			return { name: 'migrations', status: 'fail', detail: 'migration table missing' };
		}
		return { name: 'migrations', status: 'ok' };
	} catch (err) {
		return { name: 'migrations', status: 'fail', detail: (err as Error).message };
	}
}

async function checkDisk(path: string): Promise<Check> {
	try {
		const s = await statfs(path);
		const used = 1 - Number(s.bavail) / Number(s.blocks);
		const pct = `${(used * 100).toFixed(1)}% used`;
		if (used >= DISK_CRIT) return { name: 'disk', status: 'fail', detail: pct };
		if (used >= DISK_WARN) return { name: 'disk', status: 'degraded', detail: pct };
		return { name: 'disk', status: 'ok', detail: pct };
	} catch (err) {
		return { name: 'disk', status: 'fail', detail: (err as Error).message };
	}
}

async function checkStorage(): Promise<Check> {
	try {
		await statfs(env.LIFEOS_UPLOAD_DIR);
		return { name: 'storage', status: 'ok' };
	} catch (err) {
		return { name: 'storage', status: 'fail', detail: (err as Error).message };
	}
}

async function checkBackupFreshness(): Promise<Check> {
	try {
		const rows = await sql<{ finished_at: Date | string | null }[]>`
			select finished_at from backup_runs
			where status = 'success' order by finished_at desc limit 1
		`;
		const last = rows[0]?.finished_at;
		if (!last) return { name: 'backup', status: 'degraded', detail: 'no successful backup' };
		// The bundled server's shared database client can return timestamptz as
		// an ISO string even though a bare postgres.js client returns a Date.
		// Accept both representations.
		const timestamp = last instanceof Date ? last.getTime() : Date.parse(last);
		if (!Number.isFinite(timestamp)) {
			return { name: 'backup', status: 'fail', detail: 'invalid backup timestamp' };
		}
		const age = Math.max(0, Date.now() - timestamp);
		const hours = `${Math.round(age / 3_600_000)}h old`;
		return age > BACKUP_MAX_AGE_MS
			? { name: 'backup', status: 'fail', detail: hours }
			: { name: 'backup', status: 'ok', detail: hours };
	} catch (err) {
		const error = err as Error & { code?: string };
		// Older installations legitimately predate backup bookkeeping. Keep
		// those degraded until migrations run, but do not hide permissions,
		// connectivity, or malformed-data failures behind the same message.
		if (error.code === '42P01') {
			return { name: 'backup', status: 'degraded', detail: 'not yet implemented' };
		}
		return { name: 'backup', status: 'fail', detail: error.message };
	}
}

export async function readiness(): Promise<Readiness> {
	const checks = await Promise.all([
		checkDatabase(),
		checkMigrations(),
		checkStorage(),
		checkDisk(env.LIFEOS_UPLOAD_DIR),
		checkBackupFreshness()
	]);
	const status = worst(checks);
	if (status !== 'ok') {
		logger.warn({ checks }, 'readiness check not ok');
	}
	return { status, checks };
}
