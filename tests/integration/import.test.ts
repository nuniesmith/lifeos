import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { count as countOf, one } from '$lib/server/db/scalar';
import { runImport } from '$lib/server/import/run';
import type { PromoteSummary } from '$lib/server/import/promote';

/**
 * Runs the importer against a sanitised miniature export (DISC-009) that
 * carries each verified source hazard: a BOM, a colon in a title, a comma
 * inside a quoted field, an embedded newline, duplicate titles, a relation,
 * and two byte-identical images under different names.
 */

const FIXTURE = 'tests/fixtures/export';
const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let householdId: string;
let userId: string;
let uploadDir: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	userId = one(await sql<{ id: string }[]>`select id from users limit 1`).id;
	uploadDir = await mkdtemp(join(tmpdir(), 'lifeos-import-'));
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

/**
 * The promotion summary, or a clear failure.
 *
 * `promoted` is optional on the run summary because a run can stop before it
 * promotes anything. A test that reads it wants to say so rather than thread
 * an optional through every assertion.
 */
function promotionOf(summary: { promoted?: PromoteSummary }): PromoteSummary {
	if (!summary.promoted) throw new Error('the run reported no promotion summary');
	return summary.promoted;
}

const run = (dryRun: boolean) =>
	runImport(sql, {
		root: FIXTURE,
		householdId,
		ownerUserId: userId,
		startedBy: userId,
		dryRun,
		uploadDir
	});

describe('dry run', () => {
	it('reports real numbers but writes nothing', async () => {
		const summary = await run(true);
		expect(summary.rows).toBe(31);
		expect(summary.databases).toBe(16);

		// The transaction was rolled back, so nothing survives.
		expect(countOf(await sql<{ count: number }[]>`select count(*)::int from tasks`)).toBe(0);
		expect(countOf(await sql<{ count: number }[]>`select count(*)::int from source_records`)).toBe(
			0
		);
	});
});

describe('committed import', () => {
	it('stages every canonical row', async () => {
		await run(false);
		expect(countOf(await sql<{ count: number }[]>`select count(*)::int from source_records`)).toBe(
			31
		);
	});

	it('parses a quoted comma and an embedded newline as single fields', async () => {
		await run(false);
		const titles = (
			await sql<{ title: string }[]>`select title from source_records order by title`
		).map((r) => r.title);
		expect(titles).toContain('Call Mira Castellan, NP');
		expect(titles).toContain('Multi\nline task');
	});

	it('matches a title whose filename had an illegal character removed', async () => {
		await run(false);
		// "Environment: House & Home" is stored as "Environment House & Home".
		const area = one(
			await sql<{ notion_page_id: string | null }[]>`
				select notion_page_id from areas where name = 'Environment: House & Home'
			`
		);
		expect(area.notion_page_id).not.toBeNull();
	});

	it('gives duplicate titles distinct page ids rather than collapsing them', async () => {
		await run(false);
		const rows = await sql<{ notion_page_id: string | null }[]>`
			select notion_page_id from tasks where title = 'New Task TEMPLATE'
		`;
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.notion_page_id)).size).toBe(2);
	});

	it('promotes a relation into a foreign key', async () => {
		await run(false);
		const task = one(
			await sql<{ area_id: string | null }[]>`
				select area_id from tasks where title = 'Call Mira Castellan, NP'
			`
		);
		expect(task.area_id).not.toBeNull();
	});

	it('carries typed values through, not just titles', async () => {
		await run(false);
		const task = one(
			await sql<{ do_on: unknown; is_important: boolean; status: string }[]>`
				select do_on, is_important, status from tasks where title = 'Call Mira Castellan, NP'
			`
		);
		// The whole workspace once imported with every field null while the
		// report claimed success; this is the assertion that would have caught it.
		expect(task.do_on).not.toBeNull();
		expect(task.is_important).toBe(true);
		expect(task.status).toBe('todo');
	});

	it('maps Notion\u2019s own inbox status rather than collapsing it to todo', async () => {
		await run(false);
		// 'In inbox' is the largest single status group in the real export — 14
		// of 32 tasks. It was absent from the import's status table, so every
		// one of them landed on the 'todo' fallback and the inbox imported
		// empty while the run reported success.
		const task = one(
			await sql<{ status: string }[]>`
				select status from tasks where title = 'Sort this out later'
			`
		);
		expect(task.status).toBe('inbox');
	});

	it('promotes the health vocabularies into one table, keyed by kind', async () => {
		await run(false);
		const terms = await sql<{ kind: string; name: string }[]>`
			select kind, name from health_vocabulary order by name
		`;
		// Six Notion databases collapse to one vocabulary; which list a term
		// came from is its kind, not its table.
		expect(terms).toEqual([
			{ kind: 'symptom', name: 'Headache' },
			{ kind: 'symptom', name: 'Nausea' }
		]);
	});

	it('carries the daily log readings that still live there', async () => {
		// Blood Glucose, Systolic BP and Heart Rate are also in this fixture's
		// Daily Log CSV — the pre-2026-09-24 export shape — but migration 0019
		// moved those three to health_measurements, and this export has no
		// Health Measurements database for the importer to promote them from.
		// `upsertDailyLogs` no longer reads any of the three, so they are staged
		// (in source_records) and simply not promoted anywhere, which is the
		// correct outcome for an export the app has out-evolved rather than a
		// bug — see the "Health Measurements import" suite below for the
		// current shape, and health.test.ts for the hand-over itself.
		await run(false);
		const log = one(
			await sql<
				{
					water: number | null;
					caffeine: boolean | null;
					intimacy: boolean | null;
					head_space: string | null;
				}[]
			>`
				select water, caffeine, intimacy, head_space
				from daily_logs where on_date = '2026-08-08'
			`
		);
		expect(log.water).toBe(32);
		expect(log.caffeine).toBe(true);
		// No is a recorded No, not an absent value.
		expect(log.intimacy).toBe(false);
		expect(log.head_space).toBe('Engaged');
	});

	it('leaves a reading null when the source did not record one', async () => {
		await run(false);
		const log = one(
			await sql<{ heart_rate_variability: number | null; activation: number | null }[]>`
				select heart_rate_variability, activation from daily_logs where on_date = '2026-08-08'
			`
		);
		// Absent must not fold to 0, which would look like a real measurement.
		expect(log.heart_rate_variability).toBeNull();
		expect(log.activation).toBeNull();
	});

	it('keeps "not recorded" distinct from a recorded No', async () => {
		await run(false);
		const [busy, quiet] = await sql<{ caffeine: boolean | null; on_date: string }[]>`
			select caffeine, on_date::text as on_date from daily_logs order by on_date
		`;
		// A day nobody wrote anything down on is not a day without caffeine.
		// Folding an absent checkbox to false invents a measurement.
		expect(busy?.caffeine).toBe(true);
		expect(quiet?.caffeine).toBeNull();
	});

	it('links the symptoms a day logged, from a column whose name has a trailing space', async () => {
		await run(false);
		const logged = await sql<{ name: string }[]>`
			select v.name
			from daily_log_health h
			join health_vocabulary v on v.id = h.vocabulary_id
			order by v.name
		`;
		expect(logged.map((r) => r.name)).toEqual(['Headache', 'Nausea']);
	});

	it('reads an ingredient status spelled with an emoji', async () => {
		await run(false);
		const rows = await sql<{ name: string; status: string }[]>`
			select name, status from ingredients order by name
		`;
		// The options are "✅ In Stock", "🛒 Shopping List", "⚡️ Use up!". An
		// exact lookup misses all three and falls back to in_stock, which would
		// have quietly emptied the shopping list.
		expect(rows).toEqual([
			{ name: 'Broccoli', status: 'shopping_list' },
			{ name: 'Buttermilk', status: 'use_up' },
			{ name: 'Cheddar', status: 'in_stock' }
		]);
	});

	it('splits a multi-select course into an array', async () => {
		await run(false);
		const soup = one(
			await sql<{ courses: string[]; seasons: string[] }[]>`
				select courses, seasons from recipes where name = 'Broccoli Cheese Soup'
			`
		);
		expect(soup.courses).toEqual(['Lunch', 'Dinner']);
		expect(soup.seasons).toEqual(['Fall', 'Winter']);
	});

	it('keeps a decimal macro, and derives no total it was not given', async () => {
		await run(false);
		const soup = one(
			await sql<{ protein_g: unknown; prep_minutes: number; cook_minutes: number }[]>`
				select protein_g, prep_minutes, cook_minutes from recipes
				where name = 'Broccoli Cheese Soup'
			`
		);
		expect(Number(soup.protein_g)).toBe(16.5);
		expect(soup.prep_minutes).toBe(10);
		expect(soup.cook_minutes).toBe(25);
	});

	it('joins a recipe to the ingredients it calls for', async () => {
		await run(false);
		const rows = await sql<{ name: string }[]>`
			select i.name from recipe_ingredients ri
			join ingredients i on i.id = ri.ingredient_id
			join recipes r on r.id = ri.recipe_id
			where r.name = 'Broccoli Cheese Soup'
			order by i.name
		`;
		expect(rows.map((r) => r.name)).toEqual(['Broccoli', 'Cheddar']);
	});

	it('takes the meal slot from the property name, not the recipe', async () => {
		await run(false);
		const rows = await sql<{ slot: string; name: string }[]>`
			select m.slot, r.name from meal_plan_recipes m
			join recipes r on r.id = m.recipe_id
			order by m.slot
		`;
		// The same recipe could be breakfast one day and dinner the next; only
		// the column it was filed under says which.
		expect(rows).toEqual([
			{ slot: 'breakfast', name: 'Fluffy Buttermilk Pancakes' },
			{ slot: 'dinner', name: 'Broccoli Cheese Soup' }
		]);
	});

	it('places a menu on its date', async () => {
		await run(false);
		const menu = one(
			await sql<{ on_date: string; name: string }[]>`
				select on_date::text as on_date, name from meal_plans
			`
		);
		expect(menu.on_date).toBe('2026-08-24');
		expect(menu.name).toBe('Monday\u2019s Menu');
	});

	it('promotes the library, keeping the time of day on last interaction', async () => {
		await run(false);
		const book = one(
			await sql<
				{
					title: string;
					author: string;
					entry_type: string;
					status: string;
					highlight_count: number;
					last_interaction_at: Date | string | null;
				}[]
			>`
				select title, author, entry_type, status, highlight_count, last_interaction_at
				from library_items where title = 'Why We Sleep'
			`
		);
		expect(book.author).toBe('Matthew Walker');
		expect(book.entry_type).toBe('book');
		// "On Reading List" is not an exact match for any status value.
		expect(book.status).toBe('reading_list');
		expect(book.highlight_count).toBe(15);
		// A date() read would have discarded the time and broken the ordering
		// the Knowledge Hub's "rediscover" list depends on.
		const at = book.last_interaction_at;
		const ms = at instanceof Date ? at.getTime() : Date.parse(String(at));
		expect(new Date(ms).toISOString()).toBe('2026-08-11T19:20:00.000Z');
	});

	it('defaults an entry with nothing filled in rather than refusing it', async () => {
		await run(false);
		const note = one(
			await sql<{ entry_type: string; status: string; highlight_count: number }[]>`
				select entry_type, status, highlight_count from library_items
				where title = 'A note to self'
			`
		);
		expect(note.entry_type).toBe('note');
		expect(note.status).toBe('inbox');
		// An absent count is none, which for a count is the honest zero.
		expect(note.highlight_count).toBe(0);
	});

	it('attaches tags, which no relation handler used to do at all', async () => {
		await run(false);
		const rows = await sql<{ entity_type: string; name: string; title: string }[]>`
			select e.entity_type, t.name, l.title
			from entity_tags e
			join tags t on t.id = e.tag_id
			join library_items l on l.id = e.entity_id
		`;
		// Every "Tags & Topics" link in the export was counted and then dropped;
		// entity_tags came out of a full import empty.
		expect(rows).toEqual([{ entity_type: 'library_item', name: 'Sleep', title: 'Why We Sleep' }]);
	});

	it('splits a money amount from the currency written into it', async () => {
		await run(false);
		const bills = await sql<{ name: string; amount: unknown; currency: string }[]>`
			select name, amount, currency from bills order by name
		`;
		// "CA$24.99" read as a number is NaN, and kept as a string can never be
		// totalled. Both halves are needed, apart.
		expect(bills.map((b) => [b.name, Number(b.amount), b.currency])).toEqual([
			['Costco Membership', 150, 'CAD'],
			['Netflix', 24.99, 'CAD'],
			['Readwise', 14.99, 'CAD']
		]);
	});

	it('counts a star rating rather than storing the stars', async () => {
		await run(false);
		const rows = await sql<{ name: string; rating: number | null; status: string }[]>`
			select name, rating, status from media_items order by name
		`;
		expect(rows).toEqual([
			{ name: 'Project Hail Mary', rating: 5, status: 'watched' },
			// Unrated is null, not zero: nobody gave this nought stars.
			{ name: 'Survivor', rating: null, status: 'watching' }
		]);
	});

	it('maps a status whose source spelling matches nothing exactly', async () => {
		await run(false);
		const survivor = one(
			await sql<{ status: string; total_seasons: number }[]>`
				select status, total_seasons from media_items where name = 'Survivor'
			`
		);
		// "Currently Watching" and "Active/Current" are not values in any of
		// these tables; both have to be recognised by their words.
		expect(survivor.status).toBe('watching');
		expect(survivor.total_seasons).toBe(50);

		const netflix = one(
			await sql<{ status: string; frequency: string }[]>`
				select status, frequency from bills where name = 'Netflix'
			`
		);
		expect(netflix.status).toBe('active');
		expect(netflix.frequency).toBe('monthly');

		const readwise = one(
			await sql<{ status: string }[]>`select status from bills where name = 'Readwise'`
		);
		expect(readwise.status).toBe('free_trial');
	});

	it('points a wishlist item at the person it is for', async () => {
		await run(false);
		const row = one(
			await sql<{ item: string; person: string; occasion: string }[]>`
				select w.name as item, p.name as person, w.occasion
				from wishlist_items w join people p on p.id = w.for_person_id
			`
		);
		expect(row).toEqual({ item: 'Thermomix', person: 'Jordan Smith', occasion: 'Birthday' });
	});

	it('reads a person\u2019s groups as a list', async () => {
		await run(false);
		const person = one(
			await sql<{ groups: string[]; kind: string }[]>`
				select groups, kind from people where name = 'Jordan Smith'
			`
		);
		expect(person.groups).toEqual(['Family', 'Friends']);
		expect(person.kind).toBe('person');
	});

	it('refuses a wheel entry with no score, and keeps the one that has it', async () => {
		await run(false);
		const rows = await sql<{ focus: string; rating: number; area: string | null }[]>`
			select w.focus, w.rating, a.name as area
			from life_assessments w left join areas a on a.id = w.area_id
		`;
		// A wheel entry without a rating is not an assessment of anything, so it
		// is skipped rather than stored as a zero.
		expect(rows).toEqual([{ focus: 'Physical health', rating: 6, area: 'Health' }]);
	});

	it('places a significant event on the day it happened', async () => {
		await run(false);
		const row = one(
			await sql<{ title: string; on_date: string; area: string | null }[]>`
				select e.title, e.on_date::text as on_date, a.name as area
				from significant_events e left join areas a on a.id = e.area_id
			`
		);
		expect(row).toEqual({
			title: 'Adopted a greyhound',
			on_date: '2026-05-19',
			area: 'Environment: House & Home'
		});
	});

	it('accounts for every canonical row: promoted, refused, or ruled out', async () => {
		const summary = await run(false);
		const p = promotionOf(summary);
		const promoted = Object.values(p.counts).reduce((a, b) => a + b, 0);
		const notImported = p.notImported.reduce((n, d) => n + d.rows, 0);
		const refused = p.refusedByMapper.reduce((n, d) => n + d.rows, 0);

		// The invariant that makes a silent drop impossible. Against the real
		// export this balances at 448 = 390 + 51 + 7; here it balances on the
		// fixture. A row that goes missing has to show up as a gap.
		expect(promoted + notImported + refused + p.skippedWithoutPageId).toBe(summary.rows);

		// The refusal is the wheel entry with no score — deliberate, and now
		// visible rather than silently absent.
		expect(p.refusedByMapper).toEqual([{ database: 'Wheel of Life Database', rows: 1 }]);
	});

	it('names the databases it deliberately does not import', async () => {
		const summary = await run(false);
		expect(promotionOf(summary).notImported).toEqual([
			{
				database: 'Master Dashboards',
				rows: 1,
				reason: 'Notion page furniture — dashboards, navigation bars and widgets'
			}
		]);
		// And nothing is unaccounted for: a database with no mapper and no
		// recorded reason is the one case that needs a person to look.
		expect(promotionOf(summary).unrecognised).toEqual([]);
	});

	it('stores raw source values as a JSON object, not a JSON string', async () => {
		await run(false);
		const row = one(
			await sql<{ kind: string; keys: number }[]>`
				select jsonb_typeof(raw) as kind,
				       (select count(*)::int from jsonb_object_keys(raw)) as keys
				from source_records limit 1
			`
		);
		expect(row.kind).toBe('object');
		expect(row.keys).toBeGreaterThan(1);
	});

	it('deduplicates byte-identical media under different names', async () => {
		const summary = await run(false);
		// Three files, two of which are identical.
		// Four files now: three in media/ plus the page's own scan.
		expect(summary.mediaFiles).toBe(4);
		expect(summary.uniqueMedia).toBe(3);
		expect(summary.mediaStored).toBe(3);
		expect(countOf(await sql<{ count: number }[]>`select count(*)::int from attachments`)).toBe(3);
	});

	it('detects content type from bytes', async () => {
		await run(false);
		const rows = await sql<{ content_type: string }[]>`select content_type from attachments`;
		expect(rows.every((r) => r.content_type === 'image/png')).toBe(true);
	});
});

describe('rerunning', () => {
	it('does not duplicate anything', async () => {
		await run(false);
		const after = async () => ({
			tasks: countOf(await sql<{ count: number }[]>`select count(*)::int from tasks`),
			areas: countOf(await sql<{ count: number }[]>`select count(*)::int from areas`),
			media: countOf(await sql<{ count: number }[]>`select count(*)::int from attachments`)
		});
		const first = await after();

		await run(false);
		expect(await after()).toEqual(first);
	});

	it('stores no new media on the second run', async () => {
		await run(false);
		const second = await run(false);
		expect(second.mediaStored).toBe(0);
	});
});

afterAll(async () => {
	if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

describe('page bodies and their images', () => {
	it('promotes the page body into the task notes', async () => {
		await run(false);
		const task = one(
			await sql<{ notes: string | null }[]>`
				select notes from tasks where title = 'Call Mira Castellan, NP'
			`
		);
		expect(task.notes).toContain('bring the paperwork');
		// Property lines must not leak in; they once did, on 200 real pages.
		expect(task.notes).not.toContain('Status: To Do');
		expect(task.notes).not.toContain('Life Area:');
	});

	it('links a body image whose filename contains parentheses', async () => {
		await run(false);
		const rows = await sql<{ role: string }[]>`
			select l.role from attachment_links l
			join source_records r on r.id = l.entity_id
			where r.title = 'Call Mira Castellan, NP' and l.entity_type = 'source_record'
		`;
		// scan_(1).png: stopping at the first ')' produced a path matching nothing.
		expect(rows).toHaveLength(1);
		expect(rows[0]!.role).toBe('body_image');
	});
});

/**
 * The CLI, run the way a person actually runs it.
 *
 * Every other test in this file calls `runImport` directly and passes
 * `uploadDir`, which is precisely why a real bug lived here undetected: the
 * option was always supplied by the caller in tests, and never supplied by
 * `scripts/import.mjs`. The importer fell back to a hardcoded relative
 * `var/uploads` and ignored LIFEOS_UPLOAD_DIR — the one variable that says
 * where a deployment keeps its media.
 *
 * On the server that directory is the mounted volume. An import run in the
 * container therefore wrote correct attachment rows and put their bytes inside
 * the container's own filesystem, where the application cannot serve them and
 * the next deploy discards them. Nothing about the database looked wrong.
 *
 * So this drives the entry point as a subprocess with the environment set, and
 * checks the bytes landed where the configuration said. A test that imports
 * `src/` cannot catch a mistake made in the script that wires `src/` up.
 */
describe('the import CLI', () => {
	it('writes media to LIFEOS_UPLOAD_DIR, not to a hardcoded path', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'lifeos-cli-uploads-'));
		try {
			const result = spawnSync(
				process.execPath,
				['scripts/import.mjs', '--root', FIXTURE, '--commit'],
				{
					encoding: 'utf8',
					env: {
						...process.env,
						LIFEOS_UPLOAD_DIR: dir
					}
				}
			);
			expect(result.status, result.stderr).toBe(0);

			const stored = one(
				await sql<{ count: number }[]>`select count(*)::int as count from attachments`
			).count;
			expect(stored).toBeGreaterThan(0);

			// Every row's bytes must be reachable at the configured location.
			const rows = await sql<{ storage_key: string }[]>`select storage_key from attachments`;
			for (const row of rows) {
				expect(existsSync(join(dir, row.storage_key)), `${row.storage_key} is not in ${dir}`).toBe(
					true
				);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

/**
 * Exports whose SHAPE changed between two runs, as the 2026-09-24 export's
 * did: a database renamed, columns moved elsewhere, placeholders filled in,
 * and date-mention titles whose filenames are written relative to the export
 * day. Each test writes miniature exports carrying the REAL database ids, since
 * recognising a renamed database by its id is part of what is under test.
 */
describe('exports whose shape changed between imports', () => {
	const DAILY_LOG = { name: 'Daily Log Database', id: '3b7879a556f180788365fc81070ab3bf' };
	const SYMPTOMS_ID = '3bc879a556f1801a97e8d6ab23727d35';
	const SERIES = { name: 'Series Database', id: '3d4879a556f180869fdac9138875a432' };
	const INCOME = { name: 'Income Database', id: '3d3879a556f180b98b18d283ba9a94fb' };
	const page = (n: number) => 'e'.repeat(28) + n.toString(16).padStart(4, '0');
	const uuid = (hex: string) =>
		`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

	interface Row {
		page?: string;
		/** The page file's title when Notion names it differently from the row. */
		file?: string;
		cells: Record<string, string>;
		body?: string;
	}
	interface Database {
		name: string;
		id: string;
		headers: string[];
		rows: Row[];
	}

	const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
	const roots: string[] = [];

	async function exportOf(databases: Database[]): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), 'lifeos-shape-'));
		roots.push(root);
		const dir = join(root, 'Life OS', 'System');
		for (const db of databases) {
			await mkdir(join(dir, db.name), { recursive: true });
			const lines = [db.headers, ...db.rows.map((r) => db.headers.map((h) => r.cells[h] ?? ''))];
			await writeFile(
				join(dir, `${db.name} ${db.id}_all.csv`),
				'﻿' + lines.map((l) => l.map(cell).join(',')).join('\n')
			);
			for (const r of db.rows) {
				if (!r.page) continue; // an untitled row has no page file
				const title = r.file ?? r.cells[db.headers[0]!]!;
				const props = db.headers
					.slice(1)
					.filter((h) => r.cells[h])
					.map((h) => `${h}: ${r.cells[h]}`);
				await writeFile(
					join(dir, db.name, `${title} ${r.page}.md`),
					`# ${title}\n\n${props.join('\n')}\n\n${r.body ?? ''}\n`
				);
			}
		}
		return root;
	}

	const importFrom = (root: string) =>
		runImport(sql, {
			root,
			householdId,
			ownerUserId: userId,
			startedBy: userId,
			dryRun: false,
			uploadDir
		});

	const waterOf = async (hex: string) =>
		(
			await sql<{ water: number | null }[]>`
				select water from daily_logs where notion_page_id = ${uuid(hex)}
			`
		)[0]?.water;

	afterAll(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true });
	});

	it('keeps a value whose column left the export, and clears one that was emptied', async () => {
		// Water, not Systolic BP: this is the GENERIC carryForwardRemovedColumns
		// mechanism, exercised with a column that stays on daily_logs (a sync
		// glitch that drops a column temporarily is the scenario it defends
		// against). The specific, permanent case — Systolic BP and its three
		// siblings actually leaving for good — is covered in the "Health
		// Measurements import" suite below, which asserts the stronger claim:
		// not just "unread", but "never resurrected onto daily_logs at all".
		const day = page(1);
		const withReading = (reading: string | null): Database => ({
			...DAILY_LOG,
			headers:
				reading === null ? ['Day', 'Date', 'Caffeine'] : ['Day', 'Date', 'Water', 'Caffeine'],
			rows: [
				{
					page: day,
					cells: {
						Day: 'Aug 5',
						Date: 'August 5, 2026',
						...(reading === null ? {} : { Water: reading }),
						Caffeine: 'No'
					}
				}
			]
		});

		await importFrom(await exportOf([withReading('32')]));
		expect(await waterOf(day)).toBe(32);

		// The export temporarily dropped the column — a paused sync, say.
		const moved = await importFrom(await exportOf([withReading(null)]));
		expect(await waterOf(day)).toBe(32);
		expect(promotionOf(moved).carriedColumns).toContainEqual({
			database: 'Daily Log Database',
			columns: ['Water']
		});

		// The column is back, and the cell is empty: that is a real edit.
		await importFrom(await exportOf([withReading('')]));
		expect(await waterOf(day)).toBeNull();
	});

	it('keeps importing a database that was renamed, found by its id', async () => {
		await importFrom(
			await exportOf([
				{
					name: 'Symptoms Database',
					id: SYMPTOMS_ID,
					headers: ['Name'],
					rows: [{ page: page(10), cells: { Name: 'Headache' } }]
				}
			])
		);
		const renamed = promotionOf(
			await importFrom(
				await exportOf([
					{
						name: 'Symptom Library Database',
						id: SYMPTOMS_ID,
						headers: ['Name', 'Category'],
						rows: [
							{ page: page(10), cells: { Name: 'Headache' } },
							{ page: page(11), cells: { Name: 'Nausea', Category: 'Digestive' } }
						]
					}
				])
			)
		);

		expect(renamed.renamed).toContainEqual({
			database: 'Symptom Library Database',
			knownAs: 'Symptoms Database'
		});
		expect(renamed.unrecognised.map((d) => d.database)).not.toContain('Symptom Library Database');
		const names = await sql<{ name: string }[]>`
			select name from health_vocabulary where kind = 'symptom' order by name
		`;
		expect(names.map((n) => n.name)).toEqual(['Headache', 'Nausea']);
	});

	it('reports an empty placeholder that gained real rows instead of skipping it', async () => {
		const promoted = promotionOf(
			await importFrom(
				await exportOf([
					{
						...SERIES,
						headers: ['Series', 'Books Released'],
						rows: [{ page: page(20), cells: { Series: 'A Series', 'Books Released': '3' } }]
					},
					{ ...INCOME, headers: ['Name', 'Amount'], rows: [{ cells: { Name: '', Amount: '' } }] }
				])
			)
		);

		const series = promoted.unrecognised.find((d) => d.database === 'Series Database');
		expect(series?.note).toMatch(/placeholder/);
		expect(promoted.notImported.map((d) => d.database)).not.toContain('Series Database');
		// Still empty, so still skipped on purpose.
		expect(promoted.notImported.map((d) => d.database)).toContain('Income Database');
	});

	it("matches a row to its page by properties when the page's filename is relative to the export day", async () => {
		const tuesday = page(30);
		const summary = await importFrom(
			await exportOf([
				{
					...DAILY_LOG,
					headers: ['Day', 'Date', 'Caffeine', 'Intimacy'],
					rows: [
						{
							page: tuesday,
							// What Notion wrote on the Thursday it was exported.
							file: 'Tuesday, @Tuesday',
							cells: {
								Day: 'Tuesday, @September 22, 2026',
								Date: 'September 22, 2026',
								Caffeine: 'No',
								Intimacy: 'Yes'
							},
							body: 'The whole of that day.'
						},
						{
							page: page(31),
							cells: { Day: 'Aug 5', Date: 'August 5, 2026', Caffeine: 'Yes', Intimacy: 'No' }
						}
					]
				}
			])
		);

		const [log] = await sql<{ note: string | null }[]>`
			select note from daily_logs where notion_page_id = ${uuid(tuesday)}
		`;
		expect(log?.note).toContain('The whole of that day.');
		expect(summary.issues.map((i) => i.code)).toContain(
			'title_matched_no_page_resolved_by_properties'
		);
		expect(summary.issues.map((i) => i.code)).not.toContain('row_without_page_id');
	});
});

describe('medications import (migration 0018)', () => {
	// The real database id (`DATABASE_NAMES_BY_ID`'s 'Vitamins Database'), so
	// this exercises the actual lookup the live export goes through. Every
	// name, dose and date below is invented for this test.
	const VITAMINS = {
		name: 'Vitamins & Medications Database',
		id: '3bc879a556f1808c8f0ed230d152b08f'
	};
	const DAILY_LOG = { name: 'Daily Log Database', id: '3b7879a556f180788365fc81070ab3bf' };
	const page = (n: number) => 'd'.repeat(28) + n.toString(16).padStart(4, '0');

	interface Row {
		page?: string;
		cells: Record<string, string>;
		body?: string;
	}
	interface Database {
		name: string;
		id: string;
		headers: string[];
		rows: Row[];
	}

	const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
	const roots: string[] = [];

	async function exportOf(databases: Database[]): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), 'lifeos-meds-'));
		roots.push(root);
		const dir = join(root, 'Life OS', 'System');
		for (const db of databases) {
			await mkdir(join(dir, db.name), { recursive: true });
			const lines = [db.headers, ...db.rows.map((r) => db.headers.map((h) => r.cells[h] ?? ''))];
			await writeFile(
				join(dir, `${db.name} ${db.id}_all.csv`),
				'﻿' + lines.map((l) => l.map(cell).join(',')).join('\n')
			);
			for (const r of db.rows) {
				if (!r.page) continue;
				const title = r.cells[db.headers[0]!]!;
				const props = db.headers
					.slice(1)
					.filter((h) => r.cells[h])
					.map((h) => `${h}: ${r.cells[h]}`);
				await writeFile(
					join(dir, db.name, `${title} ${r.page}.md`),
					`# ${title}\n\n${props.join('\n')}\n\n${r.body ?? ''}\n`
				);
			}
		}
		return root;
	}

	const importFrom = (root: string) =>
		runImport(sql, {
			root,
			householdId,
			ownerUserId: userId,
			startedBy: userId,
			dryRun: false,
			uploadDir
		});

	afterAll(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true });
	});

	const MED_HEADERS = [
		'Name',
		'Type',
		'Dose',
		'Unit',
		'Brand',
		'Routine',
		'Scheduled Weekday',
		'Frequency',
		'Start Date',
		'End Date',
		'Status',
		'Running Low',
		'Notes',
		'Archive',
		'Essential Calcium',
		'Sodium'
	];

	it('maps type, dose, schedule and running-low into a medication row', async () => {
		const morning = page(1);
		const promoted = promotionOf(
			await importFrom(
				await exportOf([
					{
						...VITAMINS,
						headers: MED_HEADERS,
						rows: [
							{
								page: morning,
								cells: {
									Name: 'Testamine',
									Type: 'Prescription',
									Dose: '10',
									Unit: 'mg',
									Brand: 'Acme',
									Routine: 'Daily - AM',
									Status: 'Taking',
									'Running Low': 'Yes',
									Notes: 'take with food'
								}
							}
						]
					}
				])
			)
		);

		expect(promoted.counts.medications).toBe(1);
		const row = one(
			await sql<
				{
					type: string;
					dose: string;
					unit: string;
					brand: string;
					schedule_kind: string;
					status: string;
					running_low: boolean;
					notes: string | null;
				}[]
			>`
				select type, dose, unit, brand, schedule_kind, status, running_low, notes
				from medications where notion_page_id = ${uuidOf(morning)}
			`
		);
		expect(row).toMatchObject({
			type: 'prescription',
			dose: '10',
			unit: 'mg',
			brand: 'Acme',
			schedule_kind: 'daily_am',
			status: 'taking',
			running_low: true
		});
		expect(row.notes).toContain('take with food');
	});

	it('reads a scheduled weekday, and derives an interval from Frequency when there is no weekday', async () => {
		const weekly = page(2);
		const monthly = page(3);
		await importFrom(
			await exportOf([
				{
					...VITAMINS,
					headers: MED_HEADERS,
					rows: [
						{
							page: weekly,
							cells: {
								Name: 'Weeklamine',
								Type: 'Prescription',
								Routine: 'Scheduled',
								'Scheduled Weekday': 'Friday',
								Frequency: 'Weekly'
							}
						},
						{
							page: monthly,
							cells: {
								Name: 'Monthalol',
								Type: 'Prescription',
								Routine: 'Scheduled',
								Frequency: 'Monthly'
							}
						}
					]
				}
			])
		);

		const rows = await sql<
			{ notion_page_id: string; scheduled_weekday: number | null; interval_days: number | null }[]
		>`
			select notion_page_id, scheduled_weekday, interval_days from medications
			where notion_page_id in (${uuidOf(weekly)}, ${uuidOf(monthly)})
		`;
		const byId = new Map(rows.map((r) => [r.notion_page_id, r]));
		expect(byId.get(uuidOf(weekly))).toMatchObject({ scheduled_weekday: 5, interval_days: null });
		expect(byId.get(uuidOf(monthly))).toMatchObject({ scheduled_weekday: null, interval_days: 30 });
	});

	it('falls back to vitamin / as_needed for a blank Type or Routine rather than refusing the row', async () => {
		const blank = page(4);
		const promoted = promotionOf(
			await importFrom(
				await exportOf([
					{
						...VITAMINS,
						headers: MED_HEADERS,
						rows: [{ page: blank, cells: { Name: 'Unlabelledine' } }]
					}
				])
			)
		);
		expect(promoted.refusedByMapper).toEqual([]);
		const row = one(
			await sql<{ type: string; schedule_kind: string }[]>`
				select type, schedule_kind from medications where notion_page_id = ${uuidOf(blank)}
			`
		);
		expect(row).toMatchObject({ type: 'vitamin', schedule_kind: 'as_needed' });
	});

	it('turns the Daily Log relation into a dose on the log’s own date', async () => {
		const med = page(5);
		const logPage = page(6);
		const promoted = promotionOf(
			await importFrom(
				await exportOf([
					{
						...VITAMINS,
						headers: MED_HEADERS,
						rows: [
							{
								page: med,
								cells: { Name: 'Relatedine', Type: 'Supplement', Routine: 'Daily - PM' }
							}
						]
					},
					{
						...DAILY_LOG,
						headers: ['Day', 'Date', 'Medications & Vitamins'],
						rows: [
							{
								page: logPage,
								cells: {
									Day: 'Sep 24',
									Date: 'September 24, 2026',
									'Medications & Vitamins': `Relatedine (${VITAMINS.name}/Relatedine ${med}.md)`
								}
							}
						]
					}
				])
			)
		);

		expect(promoted.relations['medication.dose']).toBe(1);
		const dose = one(
			await sql<{ on_date: string; slot: string }[]>`
				select d.on_date::text as on_date, d.slot
				from medication_doses d
				join medications m on m.id = d.medication_id
				where m.notion_page_id = ${uuidOf(med)}
			`
		);
		expect(dose).toMatchObject({ on_date: '2026-09-24', slot: 'pm' });
	});

	it('does not duplicate a dose on a rerun', async () => {
		const med = page(7);
		const logPage = page(8);
		const build = () =>
			exportOf([
				{
					...VITAMINS,
					headers: MED_HEADERS,
					rows: [{ page: med, cells: { Name: 'Rerunnable', Type: 'OTC', Routine: 'As Needed' } }]
				},
				{
					...DAILY_LOG,
					headers: ['Day', 'Date', 'Medications & Vitamins'],
					rows: [
						{
							page: logPage,
							cells: {
								Day: 'Sep 24',
								Date: 'September 24, 2026',
								'Medications & Vitamins': `Rerunnable (${VITAMINS.name}/Rerunnable ${med}.md)`
							}
						}
					]
				}
			]);

		await importFrom(await build());
		await importFrom(await build());

		const count = countOf(
			await sql<{ count: number }[]>`
				select count(*)::int from medication_doses d
				join medications m on m.id = d.medication_id
				where m.notion_page_id = ${uuidOf(med)}
			`
		);
		expect(count).toBe(1);
	});
});

/** `page()` above returns a bare 32-hex id; the database stores it as a uuid. */
function uuidOf(hex: string): string {
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe('Health Measurements import', () => {
	// New 2026-09-24: Systolic BP / Diastolic BP / Heart Rate / Blood Glucose
	// moved out of the Daily Log database into this one (migration 0019). The
	// id below is the real Notion database id (public metadata, not personal
	// data); every reading value in this suite is invented.
	const MEASUREMENTS = {
		name: 'Health Measurements Database',
		id: '3e3879a556f180afa421f50bbf3c5b2a'
	};
	const DAILY_LOG = { name: 'Daily Log Database', id: '3b7879a556f180788365fc81070ab3bf' };
	const page = (n: number) => 'f'.repeat(28) + n.toString(16).padStart(4, '0');
	const uuid = (hex: string) =>
		`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

	interface Row {
		page?: string;
		cells: Record<string, string>;
	}
	interface Database {
		name: string;
		id: string;
		headers: string[];
		rows: Row[];
	}

	const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
	const roots: string[] = [];

	async function exportOf(databases: Database[]): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), 'lifeos-measurements-'));
		roots.push(root);
		const dir = join(root, 'Life OS', 'System');
		for (const db of databases) {
			await mkdir(join(dir, db.name), { recursive: true });
			const lines = [db.headers, ...db.rows.map((r) => db.headers.map((h) => r.cells[h] ?? ''))];
			await writeFile(
				join(dir, `${db.name} ${db.id}_all.csv`),
				'﻿' + lines.map((l) => l.map(cell).join(',')).join('\n')
			);
			// A row's notion_page_id comes from matching it to a page file whose
			// name embeds the 32-hex id — not from the CSV alone — so a row with
			// no page file here would stage with no page id and never reach the
			// mapper at all (see `skippedWithoutPageId` in promote.ts).
			for (const r of db.rows) {
				if (!r.page) continue;
				const title = r.cells[db.headers[0]!] || 'Untitled';
				const props = db.headers
					.slice(1)
					.filter((h) => r.cells[h])
					.map((h) => `${h}: ${r.cells[h]}`);
				await writeFile(
					join(dir, db.name, `${title} ${r.page}.md`),
					`# ${title}\n\n${props.join('\n')}\n`
				);
			}
		}
		return root;
	}

	const importFrom = (root: string) =>
		runImport(sql, {
			root,
			householdId,
			ownerUserId: userId,
			startedBy: userId,
			dryRun: false,
			uploadDir
		});

	afterAll(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true });
	});

	const HEADERS = [
		'Name',
		'BP Context',
		'Blood Glucose',
		'Daily Log',
		'Date & Time',
		'Diastolic BP',
		'Glucose Context',
		'Heart Rate',
		'Measurement Summary',
		'QT Interval',
		'Symptoms',
		'Systolic BP',
		'Weight'
	];

	it('maps blood pressure, heart rate and their context, linked to a daily log', async () => {
		const measurement = page(1);
		const dailyLog = page(2);

		await importFrom(
			await exportOf([
				{
					...DAILY_LOG,
					headers: ['Day', 'Date'],
					rows: [{ page: dailyLog, cells: { Day: 'Sept 3', Date: 'September 3, 2026' } }]
				},
				{
					...MEASUREMENTS,
					headers: HEADERS,
					rows: [
						{
							page: measurement,
							cells: {
								Name: 'September 3, 2026 7:15 AM - Morning check',
								'BP Context': 'Resting',
								'Daily Log': `Sept 3 (Daily%20Log%20Database/Sept%203%20${dailyLog}.md)`,
								'Date & Time': 'September 3, 2026 7:15 AM',
								'Diastolic BP': '76',
								'Heart Rate': '64',
								Symptoms: `Headache (Symptom%20Library%20Database/Headache%20${page(9)}.md)`,
								'Systolic BP': '118'
							}
						}
					]
				}
			])
		);

		const row = one(
			await sql<
				{
					systolic: number;
					diastolic: number;
					bp_context: string | null;
					heart_rate: number;
					glucose: unknown;
					weight: unknown;
					daily_log_id: string | null;
				}[]
			>`
				select systolic, diastolic, bp_context, heart_rate, glucose, weight, daily_log_id
				from health_measurements where notion_page_id = ${uuid(measurement)}
			`
		);
		expect(row).toMatchObject({
			systolic: 118,
			diastolic: 76,
			bp_context: 'Resting',
			heart_rate: 64
		});
		expect(row.glucose).toBeNull();
		expect(row.weight).toBeNull();

		// The Daily Log relation is resolved in pass two...
		const [log] = await sql<
			{ id: string }[]
		>`select id from daily_logs where notion_page_id = ${uuid(dailyLog)}`;
		expect(row.daily_log_id).toBe(log?.id);

		// ...and the Symptoms relation deliberately is not (see promote.ts's
		// applyRelation): no daily_log_health row exists for anything here, and
		// no error was raised getting to this point either.
		expect(await sql`select count(*)::int as n from daily_log_health`).toMatchObject([{ n: 0 }]);
	});

	it('maps glucose, its context and QT interval — none of which the real export happened to exercise', async () => {
		const measurement = page(3);
		await importFrom(
			await exportOf([
				{
					...MEASUREMENTS,
					headers: HEADERS,
					rows: [
						{
							page: measurement,
							cells: {
								Name: 'September 5, 2026 - Glucose',
								'Blood Glucose': '5.8',
								'Glucose Context': 'Fasting',
								'Date & Time': 'September 5, 2026 8:00 AM',
								'QT Interval': '402'
							}
						}
					]
				}
			])
		);

		const row = one(
			await sql<{ glucose: unknown; glucose_context: string | null; qt_interval: number | null }[]>`
				select glucose, glucose_context, qt_interval from health_measurements
				where notion_page_id = ${uuid(measurement)}
			`
		);
		expect(Number(row.glucose)).toBe(5.8);
		expect(row.glucose_context).toBe('Fasting');
		expect(row.qt_interval).toBe(402);
	});

	it('accepts a weight-only reading with no time of day and no daily log, like most of the real export', async () => {
		const measurement = page(4);
		await importFrom(
			await exportOf([
				{
					...MEASUREMENTS,
					headers: HEADERS,
					rows: [
						{
							page: measurement,
							cells: {
								Name: 'September 6, 2026 - Weight',
								'Date & Time': 'September 6, 2026',
								Weight: '71.4'
							}
						}
					]
				}
			])
		);
		const row = one(
			await sql<{ weight: unknown; daily_log_id: string | null }[]>`
				select weight, daily_log_id from health_measurements where notion_page_id = ${uuid(measurement)}
			`
		);
		expect(Number(row.weight)).toBe(71.4);
		expect(row.daily_log_id).toBeNull();
	});

	it('refuses a row with a timestamp but no reading, and one with neither', async () => {
		const promoted = promotionOf(
			await importFrom(
				await exportOf([
					{
						...MEASUREMENTS,
						headers: HEADERS,
						rows: [
							{
								page: page(5),
								cells: { Name: 'Empty but dated', 'Date & Time': 'September 7, 2026' }
							},
							// The real export's own "Add Health Measurements" template page:
							// a title and nothing else at all.
							{ page: page(6), cells: { Name: 'Add Health Measurements' } }
						]
					}
				])
			)
		);
		expect(promoted.refusedByMapper).toContainEqual({
			database: 'Health Measurements Database',
			rows: 2
		});
		expect(await sql`select count(*)::int as n from health_measurements`).toMatchObject([{ n: 0 }]);
	});

	it('does not duplicate on a re-import, and updates in place', async () => {
		const measurement = page(7);
		const build = (weight: string) => [
			{
				...MEASUREMENTS,
				headers: HEADERS,
				rows: [
					{
						page: measurement,
						cells: { Name: 'September 8, 2026', 'Date & Time': 'September 8, 2026', Weight: weight }
					}
				]
			}
		];

		await importFrom(await exportOf(build('70.0')));
		await importFrom(await exportOf(build('69.5')));

		const rows = await sql<{ weight: unknown }[]>`
			select weight from health_measurements where notion_page_id = ${uuid(measurement)}
		`;
		expect(rows).toHaveLength(1);
		expect(Number(rows[0]?.weight)).toBe(69.5);
	});

	it('keeps a unit set in LifeOS through a re-import, and drops it along with its value', async () => {
		// Notion's Weight and Blood Glucose are bare numbers (migration 0022):
		// an import never sets a unit, so one someone chose in LifeOS must not
		// be wiped by the next import that has nothing to say about it.
		const measurement = page(10);
		const build = (cells: Record<string, string>) => [
			{
				...MEASUREMENTS,
				headers: HEADERS,
				rows: [
					{
						page: measurement,
						cells: { Name: 'September 10, 2026', 'Date & Time': 'September 10, 2026', ...cells }
					}
				]
			}
		];
		const stored = async () =>
			(
				await sql<
					{
						glucose: unknown;
						glucose_unit: string | null;
						weight: unknown;
						weight_unit: string | null;
					}[]
				>`
					select glucose, glucose_unit, weight, weight_unit from health_measurements
					where notion_page_id = ${uuid(measurement)}
				`
			).map((r) => ({
				glucose: r.glucose === null ? null : Number(r.glucose),
				glucoseUnit: r.glucose_unit,
				weight: r.weight === null ? null : Number(r.weight),
				weightUnit: r.weight_unit
			}));

		await importFrom(await exportOf(build({ Weight: '154.3', 'Blood Glucose': '6.2' })));
		expect(await stored()).toEqual([
			{ glucose: 6.2, glucoseUnit: null, weight: 154.3, weightUnit: null }
		]);

		await sql`
			update health_measurements set glucose_unit = 'mmol/L', weight_unit = 'lb'
			where notion_page_id = ${uuid(measurement)}
		`;

		// Both values still exported (the weight changed): both units survive.
		await importFrom(await exportOf(build({ Weight: '155.0', 'Blood Glucose': '6.2' })));
		expect(await stored()).toEqual([
			{ glucose: 6.2, glucoseUnit: 'mmol/L', weight: 155, weightUnit: 'lb' }
		]);

		// The glucose cleared in Notion: its unit goes with it, as the table's
		// CHECK requires — otherwise this import would fail outright.
		await importFrom(await exportOf(build({ Weight: '155.0' })));
		expect(await stored()).toEqual([
			{ glucose: null, glucoseUnit: null, weight: 155, weightUnit: 'lb' }
		]);
	});

	it('does not resurrect a reading onto daily_logs when Systolic BP briefly reappears via carryForwardRemovedColumns', async () => {
		// The exact hazard migration 0019 exists to close: an OLDER export still
		// has Systolic BP on the Daily Log database; carryForwardRemovedColumns
		// will still copy that value into a later staged row once the column is
		// gone (it operates on column names, not on which table dropped which
		// column) — the fix is that upsertDailyLogs never reads that key at all
		// anymore, carried forward or not.
		const day = page(8);
		const withColumn = (present: boolean): Database => ({
			...DAILY_LOG,
			headers: present ? ['Day', 'Date', 'Systolic BP'] : ['Day', 'Date'],
			rows: [
				{
					page: day,
					cells: {
						Day: 'Sept 9',
						Date: 'September 9, 2026',
						...(present ? { 'Systolic BP': '118' } : {})
					}
				}
			]
		});

		await importFrom(await exportOf([withColumn(true)]));
		const second = await importFrom(await exportOf([withColumn(false)]));

		expect(promotionOf(second).carriedColumns).toContainEqual({
			database: 'Daily Log Database',
			columns: ['Systolic BP']
		});
		// daily_logs has had no systolic_bp column since this same migration;
		// the assertion that matters is simply that importing this shape at all
		// does not fail, and creates no row anywhere carrying that value.
		const [log] = await sql<
			{ id: string }[]
		>`select id from daily_logs where notion_page_id = ${uuid(day)}`;
		expect(log).toBeTruthy();
		expect(await sql`select count(*)::int as n from health_measurements`).toMatchObject([{ n: 0 }]);
	});
});
