#!/usr/bin/env node
/**
 * Notion import CLI (IMP-009). Operator-only; never an HTTP endpoint.
 *
 *   node scripts/import.mjs --root data                  dry run (default)
 *   node scripts/import.mjs --root data --commit         actually write
 *
 * A dry run does all the same work inside a transaction and rolls it back, so
 * the report describes a real import rather than a simulation of one.
 */
import postgres from 'postgres';
import { runImport } from '../src/lib/server/import/run.ts';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
	process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};

const root = flag('--root', 'data');
const dryRun = !argv.includes('--commit');

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

	console.log(`> ${dryRun ? 'Dry run' : 'Import'} from ${root} into "${household.name}"`);
	const started = Date.now();
	const [owner] = await sql`
		select u.id from users u
		join household_members hm on hm.user_id = u.id
		where hm.household_id = ${household.id}
		order by u.created_at limit 1
	`;
	const s = await runImport(sql, {
		root,
		householdId: household.id,
		ownerUserId: owner?.id ?? null,
		startedBy: owner?.id ?? null,
		// Without this the importer fell back to a hardcoded relative
		// `var/uploads` and ignored LIFEOS_UPLOAD_DIR — the one variable that
		// says where this deployment keeps its media. On the server that
		// directory is the mounted volume at /srv/lifeos/data/uploads, so an
		// import run in the container wrote 207 attachment rows and put their
		// bytes inside the container's own filesystem: every image 404s from
		// the application, which reads LIFEOS_UPLOAD_DIR, and the files vanish
		// on the next deploy. The rows looked perfect throughout.
		uploadDir: process.env.LIFEOS_UPLOAD_DIR || 'var/uploads',
		dryRun
	});

	const row = (label, value, baseline) => {
		const ok = baseline === undefined || value === baseline;
		const mark = ok ? `${GREEN}ok${OFF}` : `${RED}XX${OFF}`;
		const note = baseline === undefined ? '' : `  (baseline ${baseline})`;
		console.log(`  ${mark} ${label.padEnd(24)} ${String(value).padStart(6)}${note}`);
	};

	console.log('');
	row('source files', s.files);
	row('databases', s.databases, 36);
	row('canonical rows', s.rows, 436);
	row('page files in export', s.pageFiles, 504);
	row('rows matched to a page', s.pageIds, s.rows - s.untitledRows);
	row('untitled rows (no page)', s.untitledRows);
	row('rows with page body', s.rowsWithBody);
	row('media files', s.mediaFiles, 525);
	row('unique media (sha256)', s.uniqueMedia, 298);
	row('media stored this run', s.mediaStored);
	row('media rejected', s.mediaRejected, 0);
	row('body image links', s.imageLinks);
	row('relation links', s.links);
	row('unresolved links', s.unresolvedLinks);
	console.log('');

	if (s.promoted) {
		console.log('  Promoted into domain tables:');
		for (const [table, n] of Object.entries(s.promoted.counts).sort()) {
			console.log(`    ${table.padEnd(18)} ${String(n).padStart(5)}`);
		}
		const rel = Object.entries(s.promoted.relations).sort();
		if (rel.length) {
			console.log('  Relations linked:');
			for (const [name, n] of rel) console.log(`    ${name.padEnd(18)} ${String(n).padStart(5)}`);
		}
		if (s.promoted.skippedWithoutPageId) {
			console.log(`    (${s.promoted.skippedWithoutPageId} row(s) skipped: no page id)`);
		}

		const refused = s.promoted.refusedByMapper ?? [];
		if (refused.length > 0) {
			const rows = refused.reduce((n, d) => n + d.rows, 0);
			console.log(`    (${rows} row(s) refused by their mapper: incomplete for their table)`);
			for (const d of refused.sort((a, b) => b.rows - a.rows)) {
				console.log(`       ${String(d.rows).padStart(3)}  ${d.database}`);
			}
		}

		const notImported = s.promoted.notImported ?? [];
		if (notImported.length > 0) {
			const rows = notImported.reduce((n, d) => n + d.rows, 0);
			console.log('');
			console.log(`  Not imported on purpose (${rows} row(s)):`);
			for (const d of notImported.sort((a, b) => b.rows - a.rows)) {
				console.log(`    ${String(d.rows).padStart(3)}  ${d.database}`);
				console.log(`         ${d.reason}`);
			}
		}

		// A database nobody has ruled on is the one thing here that needs a
		// person: it is either a new feature pack or a silent omission, and the
		// report must not let it pass unremarked.
		const unrecognised = s.promoted.unrecognised ?? [];
		if (unrecognised.length > 0) {
			console.log('');
			console.log(`  ${RED}NOT RECOGNISED${OFF} — no mapper and no recorded reason:`);
			for (const d of unrecognised.sort((a, b) => b.rows - a.rows)) {
				console.log(`    ${String(d.rows).padStart(3)}  ${d.database}`);
			}
			console.log('    Decide whether each is data to import or furniture to');
			console.log('    list in NOT_IMPORTED, then re-run.');
		}
		console.log('');
	}

	if (s.derived?.length) {
		console.log('  Formula/rollup replacements checked against the source:');
		const needs = [];
		for (const d of s.derived) {
			const ok = d.status === 'matches';
			const mark = ok ? `${GREEN}ok${OFF}` : `${RED}??${OFF}`;
			console.log(
				`    ${mark} ${(d.database + ' / ' + d.column).padEnd(42)}` +
					` ${d.agree}/${d.compared} agree`
			);
			if (!ok) {
				needs.push(`${d.database} / ${d.column}`);
				for (const e of d.examples) {
					console.log(
						`         ${String(e.title).slice(0, 34).padEnd(36)} source=${e.source} computed=${e.computed}`
					);
				}
			}
		}
		if (needs.length) {
			console.log('');
			console.log('    These columns carry a filter the export does not include.');
			console.log('    Capture their definition from live Notion (DISC-004) before');
			console.log('    trusting the replacement; do not infer it from the numbers.');
		}
		console.log('');
	}

	if (s.issues.length) {
		console.log('  Issues:');
		for (const i of s.issues) console.log(`    [${i.severity}] ${i.code}: ${i.message}`);
		console.log('');
	}

	console.log(`  run ${s.importRunId} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	if (dryRun) console.log('  Nothing was written. Re-run with --commit to keep it.');
} catch (err) {
	console.error(err.stack ?? err.message);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 }).catch(() => {});
}
