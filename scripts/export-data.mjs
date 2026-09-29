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
	// Feature packs (migrations 0011-0015). Parents before the tables that
	// reference them; the link tables come after both of their sides.
	'health_vocabulary',
	// migration 0018: replaces the old `vitamin` health_vocabulary kind.
	// `medication_doses` has no household_id of its own — scoped through
	// `medications` the same way `daily_log_health` is scoped through
	// `daily_logs` — so it is listed here for real (dose history is still the
	// household's data) even though data-mobility.test.ts's household_id scan
	// would not have caught its absence.
	'medications',
	'medication_doses',
	// migration 0019: after daily_logs, whose id it optionally carries.
	'health_measurements',
	'ingredients',
	'recipes',
	'meal_plans',
	'library_items',
	'people',
	'media_items',
	// migration 0025: media_viewings carries its own household_id (like
	// lab_results, not like library_links) but still has to follow the
	// title it logs a viewing of.
	'media_viewings',
	'bills',
	// migration 0029: bill_payments has no household_id of its own — scoped
	// through bills the same way medication_doses is scoped through
	// medications — so it is listed here for real (a household's own payment
	// history is still its data) even though data-mobility.test.ts's
	// household_id scan would not have caught its absence.
	'bill_payments',
	'income_entries',
	'savings_contributions',
	'prep_tasks',
	'wishlist_items',
	'life_assessments',
	'significant_events',
	// Labs and visits (migration 0020). lab_markers and medical_visits carry no
	// dependency on each other; lab_results references both, so it comes after.
	'lab_markers',
	'medical_visits',
	'lab_results',
	'task_dependencies',
	// migration 0023: library_links has no household_id of its own — scoped
	// through library_items the same way task_dependencies is scoped through
	// tasks — so it is listed here for real (a household's links between its
	// own entries are still its data) even though data-mobility.test.ts's
	// household_id scan would not have caught its absence.
	'library_links',
	'entity_tags',
	'habit_logs',
	'project_areas',
	'project_goals',
	'goal_areas',
	'goal_habits',
	'daily_log_health',
	'recipe_ingredients',
	'meal_plan_recipes',
	'medical_visit_symptoms',
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
		case 'library_links':
			return db`select l.* from library_links l join library_items t on t.id = l.item_a_id where t.household_id = ${id}::uuid order by l.item_a_id, l.item_b_id`;
		case 'entity_tags':
			return db`select e.* from entity_tags e where (e.entity_type = 'task' and exists (select 1 from tasks t where t.id = e.entity_id and t.household_id = ${id}::uuid)) or (e.entity_type = 'project' and exists (select 1 from projects p where p.id = e.entity_id and p.household_id = ${id}::uuid)) or (e.entity_type = 'goal' and exists (select 1 from goals g where g.id = e.entity_id and g.household_id = ${id}::uuid)) or (e.entity_type = 'area' and exists (select 1 from areas a where a.id = e.entity_id and a.household_id = ${id}::uuid)) or (e.entity_type = 'habit' and exists (select 1 from habits h where h.id = e.entity_id and h.household_id = ${id}::uuid)) or (e.entity_type = 'important_date' and exists (select 1 from important_dates d where d.id = e.entity_id and d.household_id = ${id}::uuid)) or (e.entity_type = 'daily_log' and exists (select 1 from daily_logs dl where dl.id = e.entity_id and dl.household_id = ${id}::uuid)) or (e.entity_type = 'library_item' and exists (select 1 from library_items li where li.id = e.entity_id and li.household_id = ${id}::uuid)) order by e.tag_id, e.entity_type, e.entity_id`;
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
		case 'health_vocabulary':
		case 'medications':
		case 'health_measurements':
		case 'ingredients':
		case 'recipes':
		case 'meal_plans':
		case 'library_items':
		case 'people':
		case 'media_items':
		case 'bills':
		case 'income_entries':
		case 'savings_contributions':
		case 'prep_tasks':
		case 'wishlist_items':
		case 'life_assessments':
		case 'significant_events':
		case 'lab_markers':
		case 'medical_visits':
		case 'lab_results':
		case 'media_viewings':
			// All carry household_id directly, so one branch serves them.
			return db`select * from ${db(table)} where household_id = ${id}::uuid order by id`;
		case 'bill_payments':
			return db`select p.* from bill_payments p join bills b on b.id = p.bill_id where b.household_id = ${id}::uuid order by p.bill_id, p.paid_on, p.created_at`;
		case 'daily_log_health':
			return db`select h.* from daily_log_health h join daily_logs l on l.id = h.daily_log_id where l.household_id = ${id}::uuid order by h.daily_log_id, h.vocabulary_id`;
		case 'medication_doses':
			return db`select d.* from medication_doses d join medications m on m.id = d.medication_id where m.household_id = ${id}::uuid order by d.medication_id, d.on_date, d.slot`;
		case 'recipe_ingredients':
			return db`select r.* from recipe_ingredients r join recipes x on x.id = r.recipe_id where x.household_id = ${id}::uuid order by r.recipe_id, r.ingredient_id`;
		case 'meal_plan_recipes':
			return db`select m.* from meal_plan_recipes m join meal_plans p on p.id = m.meal_plan_id where p.household_id = ${id}::uuid order by m.meal_plan_id, m.recipe_id, m.slot`;
		case 'medical_visit_symptoms':
			return db`select s.* from medical_visit_symptoms s join medical_visits v on v.id = s.medical_visit_id where v.household_id = ${id}::uuid order by s.medical_visit_id, s.vocabulary_id`;
		case 'attachments':
			// Every other table is `select *`, which picks up new columns for
			// free. This one could not be, because sha256 is bytea and has to
			// travel as hex — so it carried a hand-written column list, and
			// migration 0017 added `variant_of` and `variant_kind` without it.
			// The export dropped them silently: 179 image variants restored with
			// no parent, which is not a broken variant but no variant at all.
			//
			// `select a.*` first, then the encoded sha256 after it, so the later
			// column wins and the list can never fall behind the schema again.
			return db`select a.*, encode(a.sha256, 'hex') as sha256 from attachments a where a.household_id = ${id}::uuid order by a.id`;
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

			// Whatever the query was, it must have produced every column the
			// table has. A hand-written list that falls behind a migration is
			// invisible otherwise: the export succeeds, the restore succeeds,
			// and a column's worth of data is simply gone.
			if (rows.length > 0) {
				const declared = (
					await tx`
						select column_name from information_schema.columns
						where table_schema = 'public' and table_name = ${table}
					`
				).map((r) => r.column_name);
				const exported = new Set(Object.keys(rows[0]));
				const missing = declared.filter((c) => !exported.has(c));
				if (missing.length > 0) {
					throw new Error(
						`export of ${table} is missing column(s) the table has: ${missing.join(', ')}`
					);
				}
			}
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
	// The schema this bundle was actually taken from, read from the database
	// rather than written down. It was a string literal — '0007' — frozen at
	// whatever migration existed the day the script was written, so a bundle
	// exported at 0016 still claimed 0007. A version field that cannot change
	// records nothing, and nothing read it either; see restore-data.mjs, which
	// now refuses a bundle whose schema is ahead of the target database.
	// Ordered by name, not applied_at: the filenames carry the sequence, and a
	// database restored from a dump has every row's timestamp bunched together.
	const applied = await sql`
		select name from schema_migrations order by name desc limit 1
	`;
	const schemaVersion = applied[0]?.name;
	if (!schemaVersion) throw new Error('no migrations are applied; nothing to export');

	const manifest = {
		format: 'lifeos-portable',
		formatVersion: 1,
		schemaVersion,
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
