#!/usr/bin/env node
// Connects with DATABASE_URL from .env exactly as the app would. Used by
// `./run.sh doctor`; exits non-zero on any failure.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

let url = process.env.DATABASE_URL;
if (!url) {
	try {
		const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
			.split('\n')
			.find((l) => l.startsWith('DATABASE_URL='));
		url = line?.slice('DATABASE_URL='.length).trim();
	} catch {
		/* no .env; fall through to the missing-url error below */
	}
}
if (!url) {
	console.error('DATABASE_URL is not set and no .env was readable');
	process.exit(1);
}

const sql = postgres(url, { connect_timeout: 5, max: 1, onnotice: () => {} });
try {
	await sql`select 1`;
	process.exit(0);
} catch (err) {
	console.error(err.message);
	process.exit(1);
} finally {
	await sql.end({ timeout: 2 }).catch(() => {});
}
