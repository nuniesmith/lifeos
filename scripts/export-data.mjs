#!/usr/bin/env node
/**
 * Portable LifeOS household export (MOVE-002).
 *
 * This is deliberately separate from backup.sh: it excludes credentials,
 * sessions, audit IPs, and server settings, so it can move application data
 * into a fresh LifeOS installation.
 *
 *   node scripts/export-data.mjs --output var/exports/lifeos-2026-09-06
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import postgres from 'postgres';

const argv = process.argv.slice(2);
const valueOf = (name, fallback = undefined) => {
	const index = argv.indexOf(name);
	return index === -1 ? fallback : argv[index + 1];
};

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
	process.exit(1);
}

const output = resolve(
	valueOf('--output', `var/exports/lifeos-${new Date().toISOString().replaceAll(':', '-')}`)
);
const uploadDir = resolve(process.env.LIFEOS_UPLOAD_DIR || 'var/uploads');
const householdId = valueOf('--household-id');

const TABLES = [
	'import_runs',
	'import_sources',
	'source_records',
	'source_links',
	'import_issues',
	'areas',
	'goals',
	'projects',
	'tasks',
	'important_dates',
	'daily_logs',
	'habits',
	'tags',
	'task_dependencies',
	'entity_tags',
	'habit_logs',
	'project_areas',
	'project_goals',
	'goal_areas',
	'goal_habits',
	'attachments',
	'attachment_links'
];

const sql = postgres(url, { max: 2, onnotice: () => {} });

const jsonReplacer = (_key, value) => (typeof value === 'bigint' ? String(value) : value);
const jsonLine = (value) => JSON.stringify(value, jsonReplacer);

function csvValue(value) {
	if (value === null || value === undefined) return '';
	const text = typeof value === 'object' ? JSON.stringify(value, jsonReplacer) : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
	if (!rows.length) return '';
	const columns = Object.keys(rows[0]);
	return (
		[
			columns.map(csvValue).join(','),
			...rows.map((row) => columns.map((column) => csvValue(row[column])).join(','))
		].join('\n') + '\n'
	);
}

async function rowsFor(db, table, id) {
	switch (table) {
		case 'import_runs':
			return db`select * from import_runs where household_id = ${id}::uuid order by id`;
		case 'import_sources':
			return db`select s.* from import_sources s join import_runs r on r.id = s.import_run_id where r.household_id = ${id}::uuid order by s.id`;
		case 'source_records':
			return db`select s.* from source_records s join import_runs r on r.id = s.import_run_id where r.household_id = ${id}::uuid order by s.id`;
		case 'source_links':
			return db`select l.* from source_links l join import_runs r on r.id = l.import_run_id where r.household_id = ${id}::uuid order by l.from_record_id, l.position`;
		case 'import_issues':
			return db`select i.* from import_issues i join import_runs r on r.id = i.import_run_id where r.household_id = ${id}::uuid order by i.id`;
		case 'areas':
			return db`select * from areas where household_id = ${id}::uuid order by id`;
		case 'goals':
			return db`select * from goals where household_id = ${id}::uuid order by id`;
		case 'projects':
			return db`select * from projects where household_id = ${id}::uuid order by id`;
		case 'tasks':
			return db`select * from tasks where household_id = ${id}::uuid order by id`;
		case 'important_dates':
			return db`select * from important_dates where household_id = ${id}::uuid order by id`;
		case 'daily_logs':
			return db`select * from daily_logs where household_id = ${id}::uuid order by id`;
		case 'habits':
			return db`select * from habits where household_id = ${id}::uuid order by id`;
		case 'tags':
			return db`select * from tags where household_id = ${id}::uuid order by id`;
		case 'task_dependencies':
			return db`select d.* from task_dependencies d join tasks t on t.id = d.blocked_task_id where t.household_id = ${id}::uuid order by d.blocked_task_id, d.blocking_task_id`;
		case 'entity_tags':
			return db`select e.* from entity_tags e where (e.entity_type = 'task' and exists (select 1 from tasks t where t.id = e.entity_id and t.household_id = ${id}::uuid)) or (e.entity_type = 'project' and exists (select 1 from projects p where p.id = e.entity_id and p.household_id = ${id}::uuid)) or (e.entity_type = 'goal' and exists (select 1 from goals g where g.id = e.entity_id and g.household_id = ${id}::uuid)) or (e.entity_type = 'area' and exists (select 1 from areas a where a.id = e.entity_id and a.household_id = ${id}::uuid)) or (e.entity_type = 'habit' and exists (select 1 from habits h where h.id = e.entity_id and h.household_id = ${id}::uuid)) or (e.entity_type = 'important_date' and exists (select 1 from important_dates d where d.id = e.entity_id and d.household_id = ${id}::uuid)) order by e.tag_id, e.entity_type, e.entity_id`;
		case 'habit_logs':
			return db`select l.* from habit_logs l join habits h on h.id = l.habit_id where h.household_id = ${id}::uuid order by l.id`;
		case 'project_areas':
			return db`select r.* from project_areas r join projects p on p.id = r.project_id where p.household_id = ${id}::uuid order by r.project_id, r.area_id`;
		case 'project_goals':
			return db`select r.* from project_goals r join projects p on p.id = r.project_id where p.household_id = ${id}::uuid order by r.project_id, r.goal_id`;
		case 'goal_areas':
			return db`select r.* from goal_areas r join goals g on g.id = r.goal_id where g.household_id = ${id}::uuid order by r.goal_id, r.area_id`;
		case 'goal_habits':
			return db`select r.* from goal_habits r join goals g on g.id = r.goal_id where g.household_id = ${id}::uuid order by r.goal_id, r.habit_id`;
		case 'attachments':
			return db`select id, household_id, encode(sha256, 'hex') as sha256, byte_size, content_type, width, height, original_name, storage_key, created_at, created_by, archived_at, purge_after from attachments where household_id = ${id}::uuid order by id`;
		case 'attachment_links':
			return db`select l.* from attachment_links l join attachments a on a.id = l.attachment_id where a.household_id = ${id}::uuid order by l.attachment_id, l.entity_type, l.entity_id`;
		default:
			throw new Error(`unsupported export table: ${table}`);
	}
}

async function allFiles(root) {
	const files = [];
	async function walk(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && relative(root, path) !== 'manifest.json') files.push(path);
		}
	}
	await walk(root);
	return files.sort();
}

async function main() {
	try {
		const existing = await readdir(output);
		if (existing.length) throw new Error(`output directory is not empty: ${output}`);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	await mkdir(join(output, 'data'), { recursive: true });
	await mkdir(join(output, 'csv'), { recursive: true });
	await mkdir(join(output, 'content'), { recursive: true });
	await mkdir(join(output, 'media'), { recursive: true });

	const counts = {};
	const relationshipCounts = {};
	let household;
	let members;
	let attachments = [];

	// Every table is read from one repeatable-read snapshot. Without this, an
	// active write between two table queries can produce a relationship whose
	// parent row is missing from the export.
	await sql.begin('isolation level repeatable read read only', async (tx) => {
		household = (
			await tx`select id, name, timezone, currency from households where ${householdId ? tx`id = ${householdId}::uuid` : tx`true`} order by created_at limit 1`
		)[0];
		if (!household) throw new Error('No household found. Start the application once first.');
		members =
			await tx`select u.id, u.username, u.display_name, u.role from users u join household_members m on m.user_id = u.id where m.household_id = ${household.id} order by u.created_at`;

		for (const table of TABLES) {
			const rows = await rowsFor(tx, table, household.id);
			counts[table] = rows.length;
			await writeFile(
				join(output, 'data', `${table}.ndjson`),
				rows.map(jsonLine).join('\n') + (rows.length ? '\n' : '')
			);
			await writeFile(join(output, 'csv', `${table}.csv`), csv(rows));
			if (
				[
					'task_dependencies',
					'entity_tags',
					'habit_logs',
					'project_areas',
					'project_goals',
					'goal_areas',
					'goal_habits',
					'attachment_links',
					'source_links'
				].includes(table)
			) {
				relationshipCounts[table] = rows.length;
			}

			if (table === 'tasks') {
				for (const row of rows) {
					if (row.notes)
						await writeFile(join(output, 'content', `task-${row.id}.md`), `${row.notes}\n`);
				}
			}
			if (table === 'daily_logs') {
				for (const row of rows) {
					if (row.note)
						await writeFile(join(output, 'content', `daily-log-${row.id}.md`), `${row.note}\n`);
				}
			}
			if (table === 'attachments') attachments = rows;
		}
	});

	// Uploads are immutable, so copying them after the database snapshot closes
	// avoids holding a transaction open for the potentially large media set.
	for (const row of attachments) {
		const source = resolve(uploadDir, row.storage_key);
		const relativeSource = relative(uploadDir, source);
		if (relativeSource.startsWith('..') || relativeSource.includes(`..${sep}`))
			throw new Error(`attachment storage key escapes upload directory: ${row.storage_key}`);
		try {
			const bytes = await readFile(source);
			const digest = createHash('sha256').update(bytes).digest('hex');
			if (digest !== row.sha256)
				throw new Error(`content checksum does not match attachment ${row.id}`);
			const extension = row.content_type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
			await writeFile(join(output, 'media', `${row.sha256}.${extension}`), bytes);
		} catch (error) {
			throw new Error(`could not export attachment ${row.id} at ${source}: ${error.message}`);
		}
	}

	const files = {};
	for (const file of await allFiles(output)) {
		const bytes = await readFile(file);
		files[relative(output, file).split(sep).join('/')] = {
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	}
	const manifest = {
		format: 'lifeos-portable',
		formatVersion: 1,
		schemaVersion: '0007',
		exportedAt: new Date().toISOString(),
		household,
		members,
		counts,
		relationshipCounts,
		files
	};
	await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(
		`Exported ${Object.values(counts).reduce((sum, count) => sum + count, 0)} rows to ${output}`
	);
	console.log(
		`Media: ${counts.attachments} attachment(s); files are content-addressed under media/`
	);
}

try {
	await main();
} catch (error) {
	console.error(error.stack ?? error.message);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 }).catch(() => {});
}
