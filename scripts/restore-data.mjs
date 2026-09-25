#!/usr/bin/env node
/**
 * Portable LifeOS household import/restore (MOVE-003).
 *
 * The default is a validation-only dry run. Applying data requires --apply,
 * an existing target household, and an explicit target owner. Credentials,
 * sessions, audit records, and server settings are never imported.
 *
 *   node scripts/restore-data.mjs --input var/exports/lifeos-... --dry-run
 *   node scripts/restore-data.mjs --input var/exports/lifeos-... \
 *     --owner-user admin --apply
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import postgres from 'postgres';

const argv = process.argv.slice(2);
const valueOf = (name, fallback = undefined) => {
	const index = argv.indexOf(name);
	return index === -1 ? fallback : argv[index + 1];
};
const input = valueOf('--input');
const collision = valueOf('--collision', 'merge');
const ownerUser = valueOf('--owner-user');
const targetHousehold = valueOf('--household-id');
const apply = argv.includes('--apply');
const collapseUsers = argv.includes('--collapse-users');

if (!input) {
	console.error('--input is required');
	process.exit(2);
}
if (!['skip', 'merge'].includes(collision)) {
	console.error(
		'--collision must be skip or merge; destructive replace is intentionally not supported'
	);
	process.exit(2);
}

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
	process.exit(1);
}

const root = resolve(input);
const uploadDir = resolve(process.env.LIFEOS_UPLOAD_DIR || 'var/uploads');
const sql = postgres(url, { max: 2, onnotice: () => {} });

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
	// Feature packs (migrations 0011-0015). Parents before dependants; the
	// link tables after both of their sides, so a foreign key never lands
	// before the row it points at.
	'health_vocabulary',
	'ingredients',
	'recipes',
	'meal_plans',
	'library_items',
	'people',
	'media_items',
	'bills',
	'prep_tasks',
	'wishlist_items',
	'life_assessments',
	'significant_events',
	'attachments',
	// Labs and visits (migration 0020). lab_markers and medical_visits carry no
	// dependency on each other; lab_results references both, so it comes after.
	'lab_markers',
	'medical_visits',
	'lab_results',
	'task_dependencies',
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
	'attachment_links'
];

const ORDER = [
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
	// Feature packs (migrations 0011-0015). Parents before dependants; the
	// link tables after both of their sides, so a foreign key never lands
	// before the row it points at.
	'health_vocabulary',
	'ingredients',
	'recipes',
	'meal_plans',
	'library_items',
	'people',
	'media_items',
	'bills',
	'prep_tasks',
	'wishlist_items',
	'life_assessments',
	'significant_events',
	'attachments',
	'lab_markers',
	'medical_visits',
	'lab_results',
	'task_dependencies',
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
	'attachment_links'
];

const jsonRows = async (table) => {
	const path = join(root, 'data', `${table}.ndjson`);
	try {
		const text = await readFile(path, 'utf8');
		return text.trim()
			? text
					.trim()
					.split('\n')
					.map((line, index) => {
						try {
							return JSON.parse(line);
						} catch (error) {
							throw new Error(`${path}:${index + 1}: invalid JSON (${error.message})`);
						}
					})
			: [];
	} catch (error) {
		if (error.code === 'ENOENT') throw new Error(`missing export table: ${path}`);
		throw error;
	}
};

async function readAndVerifyManifest() {
	const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
	if (manifest.format !== 'lifeos-portable' || manifest.formatVersion !== 1) {
		throw new Error('unsupported LifeOS portable export format');
	}
	if (!manifest.household?.id || !manifest.files) throw new Error('manifest is incomplete');
	for (const table of TABLES) {
		const required = `data/${table}.ndjson`;
		if (!Object.hasOwn(manifest.files, required)) {
			throw new Error(`manifest does not cover required payload: ${required}`);
		}
	}

	for (const [relativePath, expected] of Object.entries(manifest.files)) {
		const path = resolve(root, relativePath);
		if (!path.startsWith(`${root}${sep}`))
			throw new Error(`manifest path escapes export root: ${relativePath}`);
		const bytes = await readFile(path);
		const actual = createHash('sha256').update(bytes).digest('hex');
		if (actual !== expected.sha256 || bytes.length !== Number(expected.bytes)) {
			throw new Error(`checksum mismatch: ${relativePath}`);
		}
	}
	return manifest;
}

function mappedValue(table, column, value, targetOwner) {
	if (value === null || value === undefined) return value;
	if (column === 'sha256' && typeof value === 'string') return Buffer.from(value, 'hex');
	if (['owner_user_id', 'created_by', 'updated_by', 'started_by'].includes(column))
		return targetOwner;
	if (table === 'habit_logs' && column === 'user_id') return targetOwner;
	return value;
}

function quotedIdentifier(name) {
	if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe database identifier: ${name}`);
	return `"${name}"`;
}

async function insertRow(tx, table, original, householdId, targetOwner) {
	const row = { ...original };
	if (Object.hasOwn(row, 'household_id')) row.household_id = householdId;
	if (table === 'import_issues') delete row.id; // let the target sequence own this serial key
	for (const column of Object.keys(row))
		row[column] = mappedValue(table, column, row[column], targetOwner);

	const columns = Object.keys(row);
	if (!columns.length) return false;
	const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
	const names = columns.map(quotedIdentifier).join(', ');
	const values = columns.map((column) => row[column]);
	const hasId = columns.includes('id');
	const hasHousehold = columns.includes('household_id');
	let conflict = 'on conflict do nothing';
	if (collision === 'merge' && hasId) {
		const assignments = columns
			.filter((column) => column !== 'id')
			.map((column) => `${quotedIdentifier(column)} = excluded.${quotedIdentifier(column)}`)
			.join(', ');
		if (assignments) {
			const sameHousehold = hasHousehold
				? ` where ${quotedIdentifier(table)}."household_id" = excluded."household_id"`
				: '';
			conflict = `on conflict (id) do update set ${assignments}${sameHousehold}`;
		}
	}
	const result = await tx.unsafe(
		`insert into ${quotedIdentifier(table)} (${names}) values (${placeholders}) ${conflict} returning 1`,
		values
	);
	if (collision === 'merge' && hasId && hasHousehold && result.length === 0) {
		const existing = await tx.unsafe(
			`select household_id::text as household_id from ${quotedIdentifier(table)} where id = $1`,
			[row.id]
		);
		if (existing[0] && existing[0].household_id !== householdId) {
			throw new Error(`refusing to move ${table} ${row.id} from another household`);
		}
	}
	return result.length > 0;
}

/** Parents must exist before child rows satisfy tasks.parent_task_id. */
function orderTaskRows(rows) {
	const pending = new Map(rows.map((row) => [row.id, row]));
	const ordered = [];
	while (pending.size) {
		let moved = 0;
		for (const [id, row] of pending) {
			if (row.parent_task_id && pending.has(row.parent_task_id)) continue;
			ordered.push(row);
			pending.delete(id);
			moved++;
		}
		if (!moved) {
			throw new Error(`task parent cycle in export: ${[...pending.keys()].slice(0, 5).join(', ')}`);
		}
	}
	return ordered;
}

/**
 * Orders attachments so an image is inserted before any variant of it.
 *
 * `variant_of` is a self-reference, and the export orders attachments by id —
 * which puts a thumbnail before its original about half the time. The restore
 * then failed on the foreign key partway through, after staging the media.
 *
 * The same shape as orderTaskRows, and written the same way rather than as a
 * one-pass partition: nothing forbids a variant of a variant today, and a
 * cheap loop that handles it is better than a cheap assumption that does not.
 */
function orderAttachmentRows(rows) {
	const pending = new Map(rows.map((row) => [row.id, row]));
	const ordered = [];
	while (pending.size) {
		let moved = 0;
		for (const [id, row] of pending) {
			if (row.variant_of && pending.has(row.variant_of)) continue;
			ordered.push(row);
			pending.delete(id);
			moved++;
		}
		if (!moved) {
			throw new Error(
				`attachment variant cycle in export: ${[...pending.keys()].slice(0, 5).join(', ')}`
			);
		}
	}
	return ordered;
}

/**
 * Refuses a bundle the target database is too old to hold.
 *
 * The bundle records the migration it was exported at. If the target is behind
 * that, its tables are missing columns the rows carry, and the restore fails
 * partway through with a driver error naming a column — which says nothing
 * about the actual problem, and says it only after the media has been staged.
 * Checking up front turns that into one sentence, before anything is written.
 *
 * A target that is AHEAD is fine and expected: migrations here only add, so a
 * newer database holds an older bundle. It is reported, not refused.
 */
async function checkSchema(manifest) {
	const bundle = manifest.schemaVersion;
	// Bundles written before the manifest recorded a real version claimed a
	// frozen '0007' regardless of their true schema, so the field cannot be
	// trusted to mean anything. Those are readable but not checkable.
	if (!bundle || !/^\d{4}_/.test(bundle)) {
		console.log(`Schema check skipped: this bundle records no usable schema version.`);
		return;
	}
	const applied = await sql`select name from schema_migrations order by name desc limit 1`;
	const target = applied[0]?.name;
	if (!target) throw new Error('the target database has no migrations applied; run migrate first');

	if (target === bundle) {
		console.log(`Schema: ${target} on both sides.`);
	} else if (target < bundle) {
		throw new Error(
			`the target database is at ${target} but this bundle was exported at ${bundle}; run migrations on the target before restoring`
		);
	} else {
		console.log(`Schema: bundle ${bundle}, target ${target} (target is newer, which is fine).`);
	}
}

async function resolveTarget() {
	const household = (
		await sql`select id, name from households where ${targetHousehold ? sql`id = ${targetHousehold}::uuid` : sql`true`} order by created_at limit 1`
	)[0];
	if (!household)
		throw new Error(
			'No target household exists. Start the fresh LifeOS system once so bootstrap can create one.'
		);
	if (!ownerUser) {
		throw new Error(
			'--owner-user is required; choose the target account that should own imported private records'
		);
	}
	const users =
		await sql`select u.id, u.username from users u join household_members m on m.user_id = u.id where m.household_id = ${household.id} and (u.id::text = ${ownerUser} or lower(u.username::text) = lower(${ownerUser})) limit 1`;
	if (!users[0]) throw new Error(`target owner not found in household: ${ownerUser}`);
	return { household, user: users[0] };
}

async function copyMedia() {
	const attachments = await jsonRows('attachments');
	await mkdir(uploadDir, { recursive: true });
	for (const attachment of attachments) {
		const extension = attachment.content_type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
		const source = join(root, 'media', `${attachment.sha256}.${extension}`);
		const destination = resolve(uploadDir, attachment.storage_key);
		if (!destination.startsWith(`${uploadDir}${sep}`))
			throw new Error(`attachment storage key escapes upload directory: ${attachment.storage_key}`);
		const bytes = await readFile(source);
		const digest = createHash('sha256').update(bytes).digest('hex');
		if (digest !== attachment.sha256) throw new Error(`media checksum mismatch: ${source}`);
		await mkdir(resolve(destination, '..'), { recursive: true });
		// Content-addressed files are immutable. Existing identical files are fine.
		try {
			const existing = await readFile(destination);
			if (createHash('sha256').update(existing).digest('hex') !== digest)
				throw new Error(`existing upload differs: ${destination}`);
		} catch (error) {
			if (error.code === 'ENOENT') {
				await copyFile(source, destination);
			} else throw error;
		}
	}
}

async function main() {
	const info = await stat(root);
	if (!info.isDirectory()) throw new Error(`input is not a directory: ${root}`);
	const manifest = await readAndVerifyManifest();
	await checkSchema(manifest);
	const target = await resolveTarget();
	const rowsByTable = new Map();
	for (const table of TABLES) rowsByTable.set(table, await jsonRows(table));
	rowsByTable.set('tasks', orderTaskRows(rowsByTable.get('tasks')));
	rowsByTable.set('attachments', orderAttachmentRows(rowsByTable.get('attachments')));
	for (const attachment of rowsByTable.get('attachments')) {
		const extension = attachment.content_type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
		const mediaPath = `media/${attachment.sha256}.${extension}`;
		if (!Object.hasOwn(manifest.files, mediaPath)) {
			throw new Error(`manifest does not cover attachment payload: ${mediaPath}`);
		}
	}

	const sourceUserCount = manifest.members?.length ?? 0;
	if (sourceUserCount > 1 && !collapseUsers) {
		throw new Error(
			`export contains ${sourceUserCount} household members; add --collapse-users to explicitly map every source member to --owner-user, or use an operational database restore to preserve separate accounts`
		);
	}
	console.log(`${apply ? 'Applying' : 'Validating'} portable export from ${manifest.exportedAt}`);
	console.log(
		`Target household: ${target.household.name}; owner mapping: ${sourceUserCount} source member(s) -> ${target.user.username ?? target.user.id}`
	);
	if (!apply) console.log('Dry run only. Add --apply after reviewing the validated export.');
	// Stage immutable media before the database transaction. An extra
	// content-addressed file is harmless if the transaction later fails; a
	// committed row pointing at a file that could not be copied is not.
	if (apply) await copyMedia();

	let inserted = 0;
	let skipped = 0;
	const rollback = Symbol('rollback');
	try {
		await sql.begin(async (tx) => {
			for (const table of ORDER) {
				for (const row of rowsByTable.get(table)) {
					if (await insertRow(tx, table, row, target.household.id, target.user.id)) inserted++;
					else skipped++;
				}
			}
			if (!apply) throw rollback;
		});
	} catch (error) {
		if (error !== rollback) throw error;
	}

	console.log(
		`${apply ? 'Restored' : 'Validated'} ${inserted} row(s); ${skipped} existing/duplicate row(s)`
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
