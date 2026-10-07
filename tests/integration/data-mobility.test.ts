import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const baseUrl = new URL(process.env.DATABASE_URL!);
const suffix = String(process.pid);
const sourceName = `lifeos_mobility_source_${suffix}`;
const targetName = `lifeos_mobility_target_${suffix}`;
const sourceUrl = new URL(baseUrl);
const targetUrl = new URL(baseUrl);
sourceUrl.pathname = `/${sourceName}`;
targetUrl.pathname = `/${targetName}`;

const maintenanceUrl = new URL(baseUrl);
maintenanceUrl.pathname = '/postgres';
const maintenance = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => {} });

let workspace = '';
let sourceHousehold = '';
let targetHousehold = '';
let targetUser = '';

async function command(script: string, args: string[], databaseUrl: URL, uploadDir: string) {
	return run('node', [script, ...args], {
		cwd: root,
		env: {
			...process.env,
			DATABASE_URL: databaseUrl.toString(),
			MIGRATION_DATABASE_URL: '',
			LIFEOS_UPLOAD_DIR: uploadDir
		}
	});
}

beforeAll(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'lifeos-mobility-test-'));
	for (const name of [sourceName, targetName]) {
		await maintenance.unsafe(`drop database if exists "${name}" with (force)`);
		await maintenance.unsafe(`create database "${name}"`);
	}
	await command('scripts/migrate.mjs', [], sourceUrl, join(workspace, 'source-uploads'));
	await command('scripts/migrate.mjs', [], targetUrl, join(workspace, 'target-uploads'));

	const source = postgres(sourceUrl.toString(), { max: 1, onnotice: () => {} });
	try {
		const sourceHouseholds = await source<{ id: string }[]>`
			insert into households (name) values ('Portable source') returning id
		`;
		sourceHousehold = sourceHouseholds[0]!.id;
		const sourceUsers = await source<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash, must_change_credentials)
			values ('portable-source', 'Portable Source', 'admin', 'not-used-by-this-test', false)
			returning id
		`;
		const sourceUser = sourceUsers[0]!.id;
		await source`
			insert into household_members (household_id, user_id)
			values (${sourceHousehold}::uuid, ${sourceUser}::uuid)
		`;

		const parentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
		const childId = '00000000-0000-4000-8000-000000000001';
		await source`
			insert into tasks (id, household_id, owner_user_id, title, created_by, updated_by)
			values (${parentId}::uuid, ${sourceHousehold}::uuid, ${sourceUser}::uuid,
			        'Parent task', ${sourceUser}::uuid, ${sourceUser}::uuid)
		`;
		await source`
			insert into tasks (
				id, household_id, owner_user_id, title, parent_task_id, created_by, updated_by
			) values (
				${childId}::uuid, ${sourceHousehold}::uuid, ${sourceUser}::uuid,
				'Child task', ${parentId}::uuid, ${sourceUser}::uuid, ${sourceUser}::uuid
			)
		`;
		// migration 0038: a Today's Three pick, scoped through the task above
		// rather than by household_id -- no household_id column of its own,
		// the same shape bill_payments takes through bills. user_id has to be
		// remapped to the target account the same way habit_logs.user_id is.
		await source`
			insert into todays_three (user_id, on_date, slot, task_id)
			values (${sourceUser}::uuid, '2026-09-20', 'due', ${childId}::uuid)
		`;

		// Feature-pack rows, including both sides of a link table: the lists
		// agreeing that a table exists is not the same as its rows arriving.
		const recipes = await source<{ id: string }[]>`
			insert into recipes (household_id, name, servings, courses)
			values (${sourceHousehold}::uuid, 'Broccoli soup', 4, '{Lunch,Dinner}')
			returning id
		`;
		const ingredients = await source<{ id: string }[]>`
			insert into ingredients (household_id, name, status)
			values (${sourceHousehold}::uuid, 'Broccoli', 'shopping_list')
			returning id
		`;
		await source`
			insert into recipe_ingredients (recipe_id, ingredient_id, amount)
			values (${recipes[0]!.id}::uuid, ${ingredients[0]!.id}::uuid, '2 heads')
		`;
		// migration 0032: a food with its per-serving nutrients, and a log entry
		// against it that also exercises a per-entry override — owner_user_id is
		// NOT NULL here (unlike recipes/ingredients above), so this also proves
		// the generic owner remap (mappedValue) reaches a required column, not
		// only the optional ones the other fixtures below use.
		const foods = await source<{ id: string }[]>`
			insert into foods (household_id, name, protein_g, kcal_per_serving)
			values (${sourceHousehold}::uuid, 'Fictional Protein Bar', 20, 200)
			returning id
		`;
		await source`
			insert into food_log_entries (
				household_id, owner_user_id, eaten_on, meal, food_id, name, servings, kcal_override
			) values (
				${sourceHousehold}::uuid, ${sourceUser}::uuid, '2026-09-20', 'snack',
				${foods[0]!.id}::uuid, 'Fictional Protein Bar', 1.5, 999
			)
		`;
		const terms = await source<{ id: string }[]>`
			insert into health_vocabulary (household_id, kind, name)
			values (${sourceHousehold}::uuid, 'symptom', 'Nausea')
			returning id
		`;
		const logs = await source<{ id: string }[]>`
			insert into daily_logs (household_id, owner_user_id, on_date)
			values (${sourceHousehold}::uuid, ${sourceUser}::uuid, '2026-08-08')
			returning id
		`;
		await source`
			insert into daily_log_health (daily_log_id, vocabulary_id)
			values (${logs[0]!.id}::uuid, ${terms[0]!.id}::uuid)
		`;
		// migration 0019: a row that also exercises the optional link to a
		// daily log, so a restore that dropped it would show up as null here
		// rather than merely as a missing table.
		await source`
			insert into health_measurements (
				household_id, owner_user_id, measured_at, systolic, diastolic, weight, daily_log_id
			) values (
				${sourceHousehold}::uuid, ${sourceUser}::uuid, '2026-08-08T12:00:00Z'::timestamptz,
				118, 76, 71.4, ${logs[0]!.id}::uuid
			)
		`;

		const habits = await source<{ id: string }[]>`
			insert into habits (household_id, owner_user_id, name, created_by, updated_by)
			values (${sourceHousehold}::uuid, ${sourceUser}::uuid, 'Drink water',
			        ${sourceUser}::uuid, ${sourceUser}::uuid)
			returning id
		`;
		const habitId = habits[0]!.id;
		await source`
			insert into habit_logs (habit_id, user_id, on_date)
			values (${habitId}::uuid, ${sourceUser}::uuid, '2026-09-06')
		`;

		// migration 0031: a routine with one step linked to the habit above (so
		// the restore's generic id preservation is what has to make the link
		// resolve), and one completion -- the household-scoped table plus both
		// of the child tables that are scoped through it instead.
		const routines = await source<{ id: string }[]>`
			insert into routines (household_id, owner_user_id, name, created_by, updated_by)
			values (${sourceHousehold}::uuid, ${sourceUser}::uuid, 'Fictional Morning Routine',
			        ${sourceUser}::uuid, ${sourceUser}::uuid)
			returning id
		`;
		const routineId = routines[0]!.id;
		const steps = await source<{ id: string }[]>`
			insert into routine_steps (
				routine_id, position, title, average_version, habit_id, created_by, updated_by
			) values (
				${routineId}::uuid, 1, 'Drink water', 'Drink a full glass of water', ${habitId}::uuid,
				${sourceUser}::uuid, ${sourceUser}::uuid
			)
			returning id
		`;
		await source`
			insert into routine_step_completions (step_id, user_id, completed_on, version)
			values (${steps[0]!.id}::uuid, ${sourceUser}::uuid, '2026-09-06', 'average')
		`;

		// migration 0029 (PACK4-002): a bill with a payment against it, an
		// income entry, and a savings contribution attached to a goal — the
		// finance pack's own tables, exercising both the bill_payments child
		// table (scoped through bills, no household_id of its own) and the
		// goal_id link a savings contribution carries.
		const bills = await source<{ id: string }[]>`
			insert into bills (
				household_id, name, type, amount, frequency, next_due_on, url, trial_price,
				created_by, updated_by
			) values (
				${sourceHousehold}::uuid, 'Fictional Internet Co', 'subscription', 64.99, 'monthly',
				'2026-10-01', 'https://example.com/fictional-internet', 0,
				${sourceUser}::uuid, ${sourceUser}::uuid
			)
			returning id
		`;
		await source`
			insert into bill_payments (bill_id, amount_paid, paid_on, note, previous_next_due_on, created_by)
			values (${bills[0]!.id}::uuid, 64.99, '2026-09-01', 'Paid by card', '2026-09-01', ${sourceUser}::uuid)
		`;
		await source`
			insert into income_entries (
				household_id, owner_user_id, title, expected_amount, actual_amount, received_on,
				created_by, updated_by
			) values (
				${sourceHousehold}::uuid, ${sourceUser}::uuid, 'Fictional Paycheque', 2000, 1980,
				'2026-09-15', ${sourceUser}::uuid, ${sourceUser}::uuid
			)
		`;
		const goals = await source<{ id: string }[]>`
			insert into goals (household_id, title, created_by, updated_by)
			values (${sourceHousehold}::uuid, 'Fictional Emergency Fund', ${sourceUser}::uuid, ${sourceUser}::uuid)
			returning id
		`;
		await source`
			insert into savings_contributions (
				household_id, owner_user_id, title, amount, contributed_on, goal_id,
				created_by, updated_by
			) values (
				${sourceHousehold}::uuid, ${sourceUser}::uuid, 'Fictional transfer', 150, '2026-09-20',
				${goals[0]!.id}::uuid, ${sourceUser}::uuid, ${sourceUser}::uuid
			)
		`;

		// Reading Tracker (migration 0030): a series, an author and a genre —
		// none scoped through a parent, all three carry their own household_id
		// — a book belonging to all three, and both of the joins between them
		// (book_authors/book_genres, scoped through books the way
		// recipe_ingredients is scoped through recipes).
		const readingSeries = await source<{ id: string }[]>`
			insert into book_series (household_id, name, planned_count, created_by, updated_by)
			values (
				${sourceHousehold}::uuid, 'The Fictional Chronicles', 3, ${sourceUser}::uuid, ${sourceUser}::uuid
			)
			returning id
		`;
		const readingAuthors = await source<{ id: string }[]>`
			insert into authors (household_id, name, created_by, updated_by)
			values (${sourceHousehold}::uuid, 'Fictional Author', ${sourceUser}::uuid, ${sourceUser}::uuid)
			returning id
		`;
		const readingGenres = await source<{ id: string }[]>`
			insert into genres (household_id, name, created_by, updated_by)
			values (${sourceHousehold}::uuid, 'Speculative Fiction', ${sourceUser}::uuid, ${sourceUser}::uuid)
			returning id
		`;
		// migration 0037: storygraph_id is a plain column on an existing table,
		// not a new one -- the risk it adds to this script is `select *`
		// quietly falling behind the schema, not a missing join. Giving this
		// fixture row a value is what lets the assertion below prove the
		// column actually travels, rather than merely never being tested.
		const readingBooks = await source<{ id: string }[]>`
			insert into books (
				household_id, title, series_id, series_position, status, storygraph_id,
				created_by, updated_by
			) values (
				${sourceHousehold}::uuid, 'The Sample Saga', ${readingSeries[0]!.id}::uuid, 1, 'reading',
				'9780000000001', ${sourceUser}::uuid, ${sourceUser}::uuid
			)
			returning id
		`;
		await source`
			insert into book_authors (book_id, author_id, position)
			values (${readingBooks[0]!.id}::uuid, ${readingAuthors[0]!.id}::uuid, 0)
		`;
		await source`
			insert into book_genres (book_id, genre_id)
			values (${readingBooks[0]!.id}::uuid, ${readingGenres[0]!.id}::uuid)
		`;
		// migration 0033 (Reading Tracker R2): a finished read of that same
		// book, scoped through it exactly the way bill_payments is scoped
		// through bills — no household_id of its own — and carrying a NOT
		// NULL reader_user_id that has to be remapped the same way
		// food_log_entries.owner_user_id already is.
		await source`
			insert into book_reads (
				book_id, reader_user_id, status, started_on, finished_on, format, rating, review,
				created_by, updated_by
			) values (
				${readingBooks[0]!.id}::uuid, ${sourceUser}::uuid, 'finished', '2026-08-20', '2026-08-30',
				'ebook', 4.5, 'A satisfying read.', ${sourceUser}::uuid, ${sourceUser}::uuid
			)
		`;
		// migration 0035 (Reading Tracker R3): a challenge with a filled prompt,
		// scoped through it exactly the way book_reads above is scoped through
		// books -- no household_id of its own, and an owner_user_id that has to
		// be remapped the same way book_reads.reader_user_id already is.
		const readingChallenges = await source<{ id: string }[]>`
			insert into reading_challenges (
				household_id, owner_user_id, title, year, kind, target_count, created_by, updated_by
			) values (
				${sourceHousehold}::uuid, ${sourceUser}::uuid, 'The Fictional Reading Challenge', 2026,
				'prompts', null, ${sourceUser}::uuid, ${sourceUser}::uuid
			)
			returning id
		`;
		await source`
			insert into reading_challenge_items (
				challenge_id, position, prompt, book_id, completed_on, created_by, updated_by
			) values (
				${readingChallenges[0]!.id}::uuid, 1, 'A book with a fictional saga',
				${readingBooks[0]!.id}::uuid, '2026-08-30', ${sourceUser}::uuid, ${sourceUser}::uuid
			)
		`;

		// Life Admin HQ (migration 0036): a document held by a person --
		// documents.holder_person_id, restored under the same id as the
		// people row it points at (ids are preserved verbatim) -- and one
		// renewal against it, scoped through the document the way
		// bill_payments is scoped through bills: no household_id of its own.
		const documentPeople = await source<{ id: string }[]>`
			insert into people (household_id, name, kind, created_by, updated_by)
			values (${sourceHousehold}::uuid, 'Fictional Holder', 'person', ${sourceUser}::uuid, ${sourceUser}::uuid)
			returning id
		`;
		const documents = await source<{ id: string }[]>`
			insert into documents (
				household_id, owner_user_id, title, kind, holder_person_id, expires_on,
				renew_lead_days, created_by, updated_by
			) values (
				${sourceHousehold}::uuid, ${sourceUser}::uuid, 'Fictional Passport', 'id',
				${documentPeople[0]!.id}::uuid, '2030-01-01', 30, ${sourceUser}::uuid, ${sourceUser}::uuid
			)
			returning id
		`;
		await source`
			insert into document_renewals (
				document_id, renewed_on, previous_expires_on, new_expires_on, note, created_by
			) values (
				${documents[0]!.id}::uuid, '2026-01-01', '2025-01-01', '2030-01-01',
				'Renewed at the passport office', ${sourceUser}::uuid
			)
		`;
	} finally {
		await source.end({ timeout: 5 });
	}

	const target = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });
	try {
		const targetHouseholds = await target<{ id: string }[]>`
			insert into households (name) values ('Portable target') returning id
		`;
		targetHousehold = targetHouseholds[0]!.id;
		const targetUsers = await target<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash, must_change_credentials)
			values ('portable-target', 'Portable Target', 'admin', 'not-used-by-this-test', false)
			returning id
		`;
		targetUser = targetUsers[0]!.id;
		await target`
			insert into household_members (household_id, user_id)
			values (${targetHousehold}::uuid, ${targetUser}::uuid)
		`;
	} finally {
		await target.end({ timeout: 5 });
	}
}, 30_000);

/**
 * Drops a temporary database, waiting out the lock rather than failing on it.
 *
 * `drop database ... with (force)` needs an exclusive lock, and on a server the
 * rest of the integration suite is working against it can lose that race to a
 * connection that appears between the terminate and the drop. That showed up as
 * an intermittent teardown timeout that looked like a product failure and was
 * not one: the work never changed, only how busy the server was.
 *
 * Retrying is right here and would be wrong in application code — this is
 * cleanup of something this file created, so the only question is whether it
 * eventually goes, and a database left behind would break the next run.
 */
async function dropDatabase(name: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await maintenance.unsafe(`drop database if exists "${name}" with (force)`);
			return;
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
		}
	}
	throw lastError;
}

afterAll(async () => {
	for (const name of [sourceName, targetName]) {
		await dropDatabase(name);
	}
	await maintenance.end({ timeout: 5 });
	if (workspace) await rm(workspace, { recursive: true, force: true });
	// Generous, and deliberately so: two DDL statements against a shared server
	// are not a 10-second proposition when the suite is busy.
}, 60_000);

/**
 * Tables that carry `household_id` but are deliberately NOT exported.
 *
 * Everything else that is household-scoped is the household's own data and
 * has to travel. This list is the reviewed exception, and the test below
 * fails if a new table appears in neither it nor the export.
 */
const NOT_PORTABLE: Record<string, string> = {
	households: 'the destination household already exists; it is the target, not cargo',
	household_members: 'membership is rebuilt against the destination users',
	invites: 'single-use and time-bound; carrying them across would be a security hole',
	app_settings: 'per-install configuration, not content',
	change_log: 'an audit of edits to rows that are themselves being copied',
	backup_runs: 'bookkeeping about this install\u2019s backups',
	daily_log_health: 'exported, but scoped through daily_logs rather than by household_id',
	medication_doses: 'exported, but scoped through medications rather than by household_id',
	routine_steps: 'exported, but scoped through routines rather than by household_id',
	routine_step_completions:
		'exported, but scoped through routine_steps and routines rather than by household_id'
};

describe('everything household-scoped is portable', () => {
	it('exports every table carrying household data, or names why not', async () => {
		const source = postgres(sourceUrl.toString(), { max: 1, onnotice: () => {} });
		try {
			const scoped = await source<{ table_name: string }[]>`
				select table_name from information_schema.columns
				where table_schema = 'public' and column_name = 'household_id'
				order by table_name
			`;

			const script = await readFile('scripts/export-data.mjs', 'utf8');
			const list = script.slice(script.indexOf('const TABLES = ['));
			const exported = new Set(
				(list.slice(0, list.indexOf('];')).match(/'([a-z_]+)'/g) ?? []).map((t) => t.slice(1, -1))
			);

			const missing = scoped
				.map((r) => r.table_name)
				.filter((t) => !exported.has(t) && !(t in NOT_PORTABLE));

			// The failure this catches: five feature packs were added and the
			// exporter knew about none of them, so "take your data elsewhere"
			// would have quietly handed over a third of it.
			expect(missing, `not exported and not excused: ${missing.join(', ')}`).toEqual([]);
		} finally {
			await source.end({ timeout: 5 });
		}
	});

	it('restores in an order that never lands a row before its parent', async () => {
		const script = await readFile('scripts/restore-data.mjs', 'utf8');
		const listOf = (name: string) => {
			const from = script.slice(script.indexOf(`const ${name} = [`));
			return (from.slice(0, from.indexOf('];')).match(/'([a-z_]+)'/g) ?? []).map((t) =>
				t.slice(1, -1)
			);
		};
		const order = listOf('ORDER');

		// A child inserted before its parent fails on a foreign key, which on a
		// restore means a partial copy and a confusing error rather than a
		// clear refusal.
		const before = (child: string, parent: string) =>
			expect(order.indexOf(child), `${child} must be restored after ${parent}`).toBeGreaterThan(
				order.indexOf(parent)
			);

		before('todays_three', 'tasks');
		before('prep_tasks', 'recipes');
		before('wishlist_items', 'people');
		before('life_assessments', 'areas');
		before('significant_events', 'areas');
		before('recipe_ingredients', 'ingredients');
		before('recipe_ingredients', 'recipes');
		before('food_log_entries', 'foods');
		before('food_log_entries', 'recipes');
		before('meal_plan_recipes', 'meal_plans');
		before('meal_plan_recipes', 'recipes');
		before('daily_log_health', 'daily_logs');
		before('daily_log_health', 'health_vocabulary');
		before('health_measurements', 'daily_logs');
		before('books', 'book_series');
		before('book_authors', 'books');
		before('book_authors', 'authors');
		before('book_genres', 'books');
		before('book_genres', 'genres');
		before('book_reads', 'books');
		before('reading_challenge_items', 'reading_challenges');
		before('reading_challenge_items', 'books');
		before('routine_steps', 'routines');
		before('routine_steps', 'habits');
		before('routine_step_completions', 'routine_steps');
		before('documents', 'people');
		before('document_renewals', 'documents');

		expect(listOf('TABLES').sort()).toEqual([...order].sort());
	});
});

describe('portable data mobility', () => {
	it('dry-runs and restores parented tasks and habit ownership onto a fresh system', async () => {
		const exportDir = join(workspace, 'export');
		await command(
			'scripts/export-data.mjs',
			['--output', exportDir, '--household-id', sourceHousehold],
			sourceUrl,
			join(workspace, 'source-uploads')
		);

		await command(
			'scripts/restore-data.mjs',
			[
				'--input',
				exportDir,
				'--household-id',
				targetHousehold,
				'--owner-user',
				'portable-target',
				'--dry-run'
			],
			targetUrl,
			join(workspace, 'target-uploads')
		);

		const target = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });
		try {
			const before = await target`select count(*)::int as count from tasks`;
			expect(before[0]?.count).toBe(0);
		} finally {
			await target.end({ timeout: 5 });
		}

		await command(
			'scripts/restore-data.mjs',
			[
				'--input',
				exportDir,
				'--household-id',
				targetHousehold,
				'--owner-user',
				'portable-target',
				'--apply'
			],
			targetUrl,
			join(workspace, 'target-uploads')
		);

		const restored = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });
		try {
			const tasks = await restored`
				select title, parent_task_id::text as parent_task_id, owner_user_id::text as owner_user_id
				from tasks order by title
			`;
			expect(tasks).toHaveLength(2);
			expect(tasks.find((row) => row.title === 'Child task')?.parent_task_id).toBe(
				'ffffffff-ffff-4fff-8fff-ffffffffffff'
			);
			expect(tasks.every((row) => row.owner_user_id === targetUser)).toBe(true);

			// migration 0038: the pick travels, resolving through task_id (ids
			// are preserved verbatim, like tasks.parent_task_id above) with
			// user_id remapped to the target account the same way
			// habit_logs.user_id already is.
			const picks = await restored<{ slot: string; on_date: string; user_id: string }[]>`
				select tt.slot, tt.on_date::text as on_date, tt.user_id::text as user_id
				from todays_three tt
				join tasks t on t.id = tt.task_id
				where t.title = 'Child task'
			`;
			expect(picks).toEqual([{ slot: 'due', on_date: '2026-09-20', user_id: targetUser }]);

			// The feature packs travel too, link tables included. Without this
			// the export could list the tables and still carry none of them.
			const recipe = await restored<{ name: string; courses: string[] }[]>`
				select name, courses from recipes
			`;
			expect(recipe[0]?.name).toBe('Broccoli soup');
			expect(recipe[0]?.courses).toEqual(['Lunch', 'Dinner']);

			const pairing = await restored<{ amount: string; ingredient: string }[]>`
				select ri.amount, i.name as ingredient
				from recipe_ingredients ri join ingredients i on i.id = ri.ingredient_id
			`;
			expect(pairing[0]).toEqual({ amount: '2 heads', ingredient: 'Broccoli' });

			// migration 0032: the food, and the entry logged against it — its
			// food_id still resolves (ids are preserved verbatim), its override
			// travelled, and its owner_user_id — NOT NULL, unlike ingredients'
			// or recipes' optional owner above — was remapped to the target
			// account the same way tasks' owner_user_id was.
			const food = await restored<{ name: string; protein_g: string }[]>`
				select name, protein_g from foods
			`;
			expect(food[0]?.name).toBe('Fictional Protein Bar');
			expect(Number(food[0]?.protein_g)).toBe(20);

			const entry = await restored<
				{
					name: string;
					servings: string;
					kcal_override: string;
					owner_user_id: string;
					food_name: string;
				}[]
			>`
				select e.name, e.servings, e.kcal_override, e.owner_user_id::text as owner_user_id,
				       f.name as food_name
				from food_log_entries e join foods f on f.id = e.food_id
			`;
			expect(entry[0]).toMatchObject({
				name: 'Fictional Protein Bar',
				owner_user_id: targetUser,
				food_name: 'Fictional Protein Bar'
			});
			expect(Number(entry[0]?.kcal_override)).toBe(999);
			expect(Number(entry[0]?.servings)).toBe(1.5);

			const logged = await restored<{ name: string }[]>`
				select v.name from daily_log_health h
				join health_vocabulary v on v.id = h.vocabulary_id
			`;
			expect(logged.map((r) => r.name)).toEqual(['Nausea']);

			// The reading travels, and its link to the day it was logged near
			// still resolves: ids are preserved verbatim by this restore (see
			// insertRow), so the daily log it points at exists in the target
			// under the same id rather than the link dangling.
			const measurement = await restored<
				{ systolic: number; weight: string; daily_log_id: string }[]
			>`
				select systolic, weight, daily_log_id::text as daily_log_id from health_measurements
			`;
			expect(measurement[0]).toMatchObject({ systolic: 118 });
			expect(Number(measurement[0]?.weight)).toBe(71.4);
			const [restoredLog] = await restored<{ id: string }[]>`select id from daily_logs`;
			expect(measurement[0]?.daily_log_id).toBe(restoredLog?.id);

			const logs = await restored`select user_id::text as user_id from habit_logs`;
			expect(logs).toEqual([{ user_id: targetUser }]);

			// migration 0031: the routine and its habit-linked step travel with
			// their ids preserved verbatim (the same discipline the daily log
			// link above already relies on), so the step's habit_id still names
			// the very row that habit_logs.habit_id above does. The
			// completion's user_id is remapped the same way habit_logs' is.
			const routine = await restored<{ name: string }[]>`select name from routines`;
			expect(routine[0]?.name).toBe('Fictional Morning Routine');

			const [habitRow] = await restored<{ id: string }[]>`select id from habits`;
			const step = await restored<{ title: string; habit_id: string | null }[]>`
				select title, habit_id::text as habit_id from routine_steps
			`;
			expect(step[0]).toMatchObject({ title: 'Drink water' });
			expect(step[0]?.habit_id).toBe(habitRow?.id);

			const completions = await restored<{ user_id: string; version: string }[]>`
				select user_id::text as user_id, version from routine_step_completions
			`;
			expect(completions).toEqual([{ user_id: targetUser, version: 'average' }]);

			// Finance (migration 0029): the bill, its payment, the income entry
			// and the savings contribution all travelled, owner columns remapped
			// to the target account, and the payment/contribution still resolve
			// through their links (bill_payments.bill_id, savings_contributions.
			// goal_id) rather than landing before the row they point at.
			const bill = await restored<{ name: string; type: string; owner_user_id: string | null }[]>`
				select name, type, owner_user_id::text as owner_user_id from bills
				where name = 'Fictional Internet Co'
			`;
			expect(bill[0]).toMatchObject({ name: 'Fictional Internet Co', type: 'subscription' });

			const payment = await restored<{ amount_paid: string; bill_name: string }[]>`
				select p.amount_paid, b.name as bill_name
				from bill_payments p join bills b on b.id = p.bill_id
			`;
			expect(payment[0]?.bill_name).toBe('Fictional Internet Co');
			expect(Number(payment[0]?.amount_paid)).toBe(64.99);

			const income = await restored<{ title: string; owner_user_id: string }[]>`
				select title, owner_user_id::text as owner_user_id from income_entries
			`;
			expect(income[0]).toMatchObject({ title: 'Fictional Paycheque', owner_user_id: targetUser });

			const saving = await restored<{ title: string; goal_title: string }[]>`
				select s.title, g.title as goal_title
				from savings_contributions s join goals g on g.id = s.goal_id
			`;
			expect(saving[0]).toMatchObject({
				title: 'Fictional transfer',
				goal_title: 'Fictional Emergency Fund'
			});

			// Reading Tracker (migration 0030): the book, its series and both
			// joins (book_authors/book_genres) travelled, resolving through the
			// same ids restore-data.mjs preserves verbatim rather than landing
			// before the rows they point at.
			const book = await restored<
				{
					title: string;
					series_name: string;
					author_name: string;
					genre_name: string;
					storygraph_id: string | null;
				}[]
			>`
				select bk.title, bs.name as series_name, a.name as author_name, g.name as genre_name,
				       bk.storygraph_id
				from books bk
				join book_series bs on bs.id = bk.series_id
				join book_authors ba on ba.book_id = bk.id
				join authors a on a.id = ba.author_id
				join book_genres bg on bg.book_id = bk.id
				join genres g on g.id = bg.genre_id
				where bk.title = 'The Sample Saga'
			`;
			expect(book[0]).toMatchObject({
				title: 'The Sample Saga',
				series_name: 'The Fictional Chronicles',
				author_name: 'Fictional Author',
				genre_name: 'Speculative Fiction',
				// migration 0037: a plain column on an existing table, carried by
				// this script's `select *` with no code change of its own needed
				// -- this is what proves that, rather than merely asserting it.
				storygraph_id: '9780000000001'
			});

			// migration 0033 (Reading Tracker R2): the read travelled, resolving
			// through book_id the same way the joins above resolve, and its
			// reader_user_id — NOT NULL, like food_log_entries.owner_user_id — was
			// remapped to the target account rather than left pointing at a user
			// that does not exist on this database.
			const read = await restored<
				{
					status: string;
					started_on: string;
					finished_on: string;
					format: string;
					rating: string;
					review: string;
					reader_user_id: string;
					book_title: string;
				}[]
			>`
				select r.status, r.started_on::text as started_on, r.finished_on::text as finished_on,
				       r.format, r.rating, r.review, r.reader_user_id::text as reader_user_id,
				       bk.title as book_title
				from book_reads r join books bk on bk.id = r.book_id
			`;
			expect(read[0]).toMatchObject({
				status: 'finished',
				started_on: '2026-08-20',
				finished_on: '2026-08-30',
				format: 'ebook',
				review: 'A satisfying read.',
				reader_user_id: targetUser,
				book_title: 'The Sample Saga'
			});
			expect(Number(read[0]?.rating)).toBe(4.5);

			// migration 0035 (Reading Tracker R3): the challenge and its filled
			// prompt travelled, the prompt resolving through both challenge_id and
			// book_id (ids preserved verbatim, like book_reads.book_id above), and
			// the challenge's owner_user_id remapped to the target account the
			// same way every other owner column already is.
			const challenge = await restored<
				{ title: string; year: number; kind: string; owner_user_id: string }[]
			>`
				select title, year, kind, owner_user_id::text as owner_user_id from reading_challenges
			`;
			expect(challenge[0]).toMatchObject({
				title: 'The Fictional Reading Challenge',
				year: 2026,
				kind: 'prompts',
				owner_user_id: targetUser
			});

			const item = await restored<{ prompt: string; completed_on: string; book_title: string }[]>`
				select i.prompt, i.completed_on::text as completed_on, bk.title as book_title
				from reading_challenge_items i
				join reading_challenges c on c.id = i.challenge_id
				join books bk on bk.id = i.book_id
				where c.title = 'The Fictional Reading Challenge'
			`;
			expect(item[0]).toMatchObject({
				prompt: 'A book with a fictional saga',
				completed_on: '2026-08-30',
				book_title: 'The Sample Saga'
			});

			// migration 0036 (Life Admin HQ): the document travels with its
			// holder_person_id still resolving -- ids are preserved verbatim,
			// the same discipline the daily log / health measurement link above
			// already relies on -- and its renewal, scoped through it exactly
			// the way bill_payments is scoped through bills, with no
			// household_id of its own.
			const [restoredHolder] = await restored<{ id: string }[]>`
				select id from people where name = 'Fictional Holder'
			`;
			const document = await restored<
				{ title: string; kind: string; expires_on: string; holder_person_id: string }[]
			>`
				select title, kind, expires_on::text as expires_on,
				       holder_person_id::text as holder_person_id
				from documents where title = 'Fictional Passport'
			`;
			expect(document[0]).toMatchObject({
				title: 'Fictional Passport',
				kind: 'id',
				expires_on: '2030-01-01',
				holder_person_id: restoredHolder?.id
			});

			const renewal = await restored<
				{ renewed_on: string; previous_expires_on: string; new_expires_on: string; note: string }[]
			>`
				select r.renewed_on::text as renewed_on,
				       r.previous_expires_on::text as previous_expires_on,
				       r.new_expires_on::text as new_expires_on, r.note
				from document_renewals r
				join documents d on d.id = r.document_id
				where d.title = 'Fictional Passport'
			`;
			expect(renewal[0]).toMatchObject({
				renewed_on: '2026-01-01',
				previous_expires_on: '2025-01-01',
				new_expires_on: '2030-01-01',
				note: 'Renewed at the passport office'
			});

			const otherHouseholds = await restored<{ id: string }[]>`
				insert into households (name) values ('Other target') returning id
			`;
			const otherUsers = await restored<{ id: string }[]>`
				insert into users (username, display_name, role, password_hash, must_change_credentials)
				values ('portable-other', 'Portable Other', 'admin', 'not-used-by-this-test', false)
				returning id
			`;
			await restored`
				insert into household_members (household_id, user_id)
				values (${otherHouseholds[0]!.id}::uuid, ${otherUsers[0]!.id}::uuid)
			`;

			await expect(
				command(
					'scripts/restore-data.mjs',
					[
						'--input',
						exportDir,
						'--household-id',
						otherHouseholds[0]!.id,
						'--owner-user',
						'portable-other',
						'--apply'
					],
					targetUrl,
					join(workspace, 'target-uploads')
				)
				// Not pinned to a specific table: which one collides first depends on
				// ORDER, and migration 0029's fixture rows above added a `goals` row
				// that now collides before `tasks` does. The guard itself — refusing
				// to move ANY row into a household that is not the one that already
				// has it — is what this proves, not which table happens to hit it.
			).rejects.toMatchObject({ stderr: expect.stringContaining('refusing to move') });
		} finally {
			await restored.end({ timeout: 5 });
		}
	});

	it('requires explicit consent before collapsing multiple source users', async () => {
		const source = postgres(sourceUrl.toString(), { max: 1, onnotice: () => {} });
		try {
			const users = await source<{ id: string }[]>`
				insert into users (username, display_name, role, password_hash, must_change_credentials)
				values ('portable-source-two', 'Portable Source Two', 'member', 'not-used-by-this-test', false)
				returning id
			`;
			await source`
				insert into household_members (household_id, user_id)
				values (${sourceHousehold}::uuid, ${users[0]!.id}::uuid)
			`;
		} finally {
			await source.end({ timeout: 5 });
		}

		const exportDir = join(workspace, 'multi-user-export');
		await command(
			'scripts/export-data.mjs',
			['--output', exportDir, '--household-id', sourceHousehold],
			sourceUrl,
			join(workspace, 'source-uploads')
		);

		const restoreArgs = [
			'--input',
			exportDir,
			'--household-id',
			targetHousehold,
			'--owner-user',
			'portable-target',
			'--dry-run'
		];
		await expect(
			command('scripts/restore-data.mjs', restoreArgs, targetUrl, join(workspace, 'target-uploads'))
		).rejects.toMatchObject({ stderr: expect.stringContaining('add --collapse-users') });

		await expect(
			command(
				'scripts/restore-data.mjs',
				[...restoreArgs, '--collapse-users'],
				targetUrl,
				join(workspace, 'target-uploads')
			)
		).resolves.toMatchObject({ stdout: expect.stringContaining('Validated') });
	});
});
