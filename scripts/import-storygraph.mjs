#!/usr/bin/env node
/**
 * StoryGraph reading-history import (Reading Tracker R3b). Operator-only;
 * never an HTTP endpoint, same as scripts/import.mjs.
 *
 *   node scripts/import-storygraph.mjs --csv <path> --user <username>
 *   node scripts/import-storygraph.mjs --csv <path> --user <username> --commit
 *
 * A dry run (the default) does all the same work inside a transaction and
 * rolls it back, so the report describes a real import rather than a
 * simulation of one -- see storygraph.ts's `importStorygraph`, which is also
 * the only part of this file that touches the database. Nothing here reads
 * from `data/`: the CSV path is always the operator's own argument, and this
 * script carries no default for it, so the file this prints a report about
 * is always the one named on the command line.
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { importStorygraph } from '../src/lib/server/import/storygraph.ts';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
	process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

const csvPath = flag('--csv');
const username = flag('--user');
const commit = argv.includes('--commit');

if (!csvPath) {
	console.error('--csv <path> is required');
	process.exit(2);
}
if (!username) {
	console.error('--user <username> is required; this import always logs reads as one person');
	process.exit(2);
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

const sql = postgres(url, { max: 4, onnotice: () => {} });

try {
	const [household] = await sql`select id, name from households order by created_at limit 1`;
	if (!household) {
		console.error('No household exists yet. Start the application once to bootstrap it.');
		process.exit(1);
	}

	// Scoped to this household, the same join scripts/restore-data.mjs uses to
	// resolve --owner-user, so a username that exists but belongs to no one in
	// this household is refused exactly like one that does not exist at all
	// (hard rule: "refuse to run with no --user, or a user not in the
	// database").
	const [user] = await sql`
		select u.id, u.display_name from users u
		join household_members hm on hm.user_id = u.id
		where hm.household_id = ${household.id} and lower(u.username::text) = lower(${username})
		limit 1
	`;
	if (!user) {
		console.error(`No user "${username}" in "${household.name}".`);
		process.exit(1);
	}

	const csvText = await readFile(csvPath, 'utf8');

	console.log(
		`> ${commit ? 'Importing' : 'Dry run'} ${csvPath} as ${user.display_name} into "${household.name}"`
	);
	const started = Date.now();
	const summary = await importStorygraph(sql, csvText, {
		householdId: household.id,
		userId: user.id,
		dryRun: !commit
	});

	console.log('');
	console.log(`  rows read              ${String(summary.rowsRead).padStart(6)}`);
	console.log(`  books created          ${String(summary.booksCreated).padStart(6)}`);
	console.log(`  books skipped (dup)    ${String(summary.booksSkipped).padStart(6)}`);
	const failedMark = summary.booksFailed > 0 ? RED : GREEN;
	console.log(
		`  books failed           ${failedMark}${String(summary.booksFailed).padStart(6)}${OFF}`
	);
	console.log(`  keyed by title+author  ${String(summary.booksKeyedByTitle).padStart(6)}`);
	console.log(`  authors created        ${String(summary.authorsCreated).padStart(6)}`);
	console.log('');
	console.log('  reads created by status:');
	for (const [status, count] of Object.entries(summary.readsByStatus)) {
		console.log(`    ${status.padEnd(10)} ${String(count).padStart(6)}`);
	}

	const counted = Object.entries(summary.warningCounts).sort((a, b) => b[1] - a[1]);
	if (counted.length > 0) {
		console.log('');
		// Field name and a fixed message per kind, never cell content.
		console.log('  warnings by kind:');
		for (const [kind, count] of counted) {
			console.log(`    ${String(count).padStart(6)}  ${kind}`);
		}
	}

	if (summary.warnings.length > 0) {
		console.log('');
		// Row number and field name only -- never the title or any other cell
		// content (hard rule 1): this report ends up in a terminal and in logs.
		console.log(`  warnings (first ${summary.warnings.length}):`);
		for (const w of summary.warnings) {
			console.log(`    row ${w.row}, ${w.field}: ${w.message}`);
		}
	}

	console.log('');
	console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	if (!commit) console.log('  Nothing was written. Re-run with --commit to keep it.');
} catch (err) {
	console.error(err.stack ?? err.message);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 }).catch(() => {});
}
