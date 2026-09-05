#!/usr/bin/env node
/**
 * Drops and recreates the end-to-end database.
 *
 * Run as the first step of the Playwright `webServer` command, not from
 * `globalSetup`: Playwright starts the web server *before* global setup, so a
 * reset there wipes the admin the server has already bootstrapped and the
 * sign-in cases fail against an empty users table.
 *
 * The suite genuinely needs a clean database — the bootstrap cases require an
 * empty `users` table and the last of them renames `admin`. Without this a
 * rerun reports *fewer tests* rather than failures, because a failure inside a
 * serial block takes the rest of the block with it, and a count sliding from
 * 23 to 22 is much easier to miss than something red.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL must be set');
	process.exit(1);
}

const target = new URL(url);
const database = decodeURIComponent(target.pathname.slice(1));
if (!database) {
	console.error('DATABASE_URL has no database name');
	process.exit(1);
}

const maintenance = new URL(url);
maintenance.pathname = '/postgres';

const sql = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
try {
	// `force` disconnects anything still attached from a previous run.
	await sql.unsafe(`drop database if exists "${database}" with (force)`);
	await sql.unsafe(`create database "${database}"`);
	console.log(`reset ${database}`);
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 }).catch(() => {});
}
