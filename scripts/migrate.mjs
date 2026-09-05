#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Applies ordered .sql files from migrations/ inside a transaction, guarded by
 * a PostgreSQL advisory lock so two concurrent deploys cannot both migrate.
 *
 * Connects with MIGRATION_DATABASE_URL when set — the owner role that may
 * create and alter objects — falling back to DATABASE_URL for development,
 * where the two are the same. The application's runtime role deliberately
 * cannot run this.
 *
 *   node scripts/migrate.mjs            apply pending migrations
 *   node scripts/migrate.mjs --status   list applied and pending, apply nothing
 *   node scripts/migrate.mjs --verify   fail if any applied file has changed
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

// Arbitrary but fixed: two runners must pick the same key to exclude each other.
const LOCK_KEY = 0x1_1fe_05;

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
	process.exit(1);
}

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const verifyOnly = args.has('--verify');

const sql = postgres(url, { max: 1, onnotice: () => {} });

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function loadMigrations() {
	const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
	return Promise.all(
		files.map(async (name) => {
			const body = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
			return { name, body, checksum: sha256(body) };
		})
	);
}

async function ensureVersionTable() {
	// Created outside the migration set so the runner can record its own work
	// from the very first run against an empty database.
	await sql`
		create table if not exists schema_migrations (
			name        text        primary key,
			checksum    text        not null,
			applied_at  timestamptz not null default now(),
			duration_ms integer     not null
		)
	`;
}

async function main() {
	await ensureVersionTable();

	const migrations = await loadMigrations();
	const applied = new Map(
		(await sql`select name, checksum from schema_migrations`).map((r) => [r.name, r.checksum])
	);

	// A changed file that has already run means the database and the repository
	// disagree about what is deployed. Refuse rather than guess.
	const drifted = migrations.filter(
		(m) => applied.has(m.name) && applied.get(m.name) !== m.checksum
	);
	if (drifted.length) {
		console.error('Applied migrations have been modified since they ran:');
		for (const d of drifted) console.error(`  ${d.name}`);
		console.error('Add a new migration instead of editing an applied one.');
		process.exit(1);
	}

	const pending = migrations.filter((m) => !applied.has(m.name));

	if (verifyOnly) {
		console.log(`checksums ok (${applied.size} applied)`);
		return;
	}

	if (statusOnly) {
		for (const m of migrations) {
			console.log(`  ${applied.has(m.name) ? 'applied' : 'pending'}  ${m.name}`);
		}
		console.log(`${applied.size} applied, ${pending.length} pending`);
		return;
	}

	if (!pending.length) {
		console.log('no pending migrations');
		return;
	}

	// Serialise concurrent runners. The lock is released when this session ends,
	// including on crash, so a killed deploy cannot wedge the next one.
	const [{ pg_try_advisory_lock: got }] = await sql`select pg_try_advisory_lock(${LOCK_KEY})`;
	if (!got) {
		console.error('another migration run holds the advisory lock; not proceeding');
		process.exit(1);
	}

	try {
		for (const m of pending) {
			const started = Date.now();
			// Each migration is one transaction: it applies completely or not at
			// all, and its version row commits with it.
			await sql.begin(async (tx) => {
				await tx.unsafe(m.body);
				await tx`
					insert into schema_migrations (name, checksum, duration_ms)
					values (${m.name}, ${m.checksum}, ${Date.now() - started})
				`;
			});
			console.log(`  applied ${m.name} (${Date.now() - started}ms)`);
		}
		console.log(`${pending.length} migration(s) applied`);
	} finally {
		await sql`select pg_advisory_unlock(${LOCK_KEY})`;
	}
}

try {
	await main();
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 }).catch(() => {});
}
