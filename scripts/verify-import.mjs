#!/usr/bin/env node
/**
 * Asks whether the imported data still MEANS what the export said.
 *
 *   node scripts/verify-import.mjs --root data/md.csv
 *
 * The import report already proves rows arrived and that the accounting
 * balances. It cannot prove they arrived meaning the same thing, and that is
 * where this export's hazards live: a rating written `★★★★★` becoming null, a
 * `CA$12.34` losing its amount, a cadence word like "Quarter" becoming nothing,
 * a status of "In inbox" collapsing into the fallback. Every one of those is
 * silent — the row is present, the count is right, the value is gone.
 *
 * So each check below reads a column out of the export's own CSV, works out
 * what it should have become, and asks the database whether it agrees.
 *
 * Deliberately NOT reusing the importer's field mappers. Sharing them would
 * make this agree with the importer by construction, which is the one thing a
 * verification must not do. It shares only `parseCsv`, because a second CSV
 * reader would be a second set of quoting and embedded-newline bugs rather than
 * an independent opinion — this export has both.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { parseCsv, parseSourceDate, stripBom } from '../src/lib/server/import/csv.ts';

const argv = process.argv.slice(2);
const valueOf = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};

const root = valueOf('--root', process.env.LIFEOS_IMPORT_DIR || 'data/md.csv');
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
	process.exit(1);
}

const sql = postgres(url, { max: 2, onnotice: () => {} });

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

/** Every `*_all.csv` in the export, by the database name in front of the id. */
async function tables() {
	const found = new Map();
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name.endsWith('_all.csv')) {
				const name = entry.name.replace(/\s+[0-9a-f]{32}_all\.csv$/i, '');
				if (!found.has(name)) found.set(name, full);
			}
		}
	};
	await walk(root);
	return found;
}

/** A CSV as objects, keyed by header. */
async function rowsOf(path) {
	if (!path) return [];
	const grid = parseCsv(stripBom(await readFile(path, 'utf8')));
	const [header, ...body] = grid;
	if (!header) return [];
	return body.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])));
}

let failures = 0;

function report(label, checked, wrong) {
	if (checked === 0) {
		console.log(`  ${DIM}--${OFF} ${label.padEnd(46)} nothing in the source to check`);
		return;
	}
	const mark = wrong.length === 0 ? `${GREEN}ok${OFF}` : `${RED}XX${OFF}`;
	console.log(`  ${mark} ${label.padEnd(46)} ${checked - wrong.length}/${checked} agree`);
	for (const detail of wrong.slice(0, 5)) console.log(`       ${detail}`);
	if (wrong.length > 5) console.log(`       … and ${wrong.length - 5} more`);
	failures += wrong.length;
}

/**
 * Stars are U+2605 BLACK STAR in the values, even where the column is named
 * with the U+2B50 emoji. Matching the emoji finds nothing and reports a clean
 * zero, which is exactly how a first version of this check passed while two
 * ratings sat unverified.
 */
const stars = (value) => (value.match(/★/g) ?? []).length;

const money = (value) => {
	const cleaned = value.replace(/CA\$|\$|,/g, '').trim();
	if (!cleaned) return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const CADENCE = { day: 1, week: 7, month: 30, quarter: 91, year: 365 };

const main = async () => {
	const files = await tables();
	console.log(`\n  Verifying ${files.size} source table(s) against the database\n`);

	// ─── Library ───────────────────────────────────────────────────────────
	const library = await rowsOf(files.get('Library'));
	{
		const want = new Map();
		for (const row of library) {
			const title = (row.Title ?? '').trim();
			const count = (row.Highlights ?? '').trim();
			if (title && /^\d+$/.test(count)) want.set(title, Number(count));
		}
		const got = new Map(
			(await sql`select title, highlight_count from library_items`).map((r) => [
				r.title,
				r.highlight_count
			])
		);
		report(
			'Library highlight counts',
			want.size,
			[...want]
				.filter(([t, v]) => got.get(t) !== v)
				.map(([t, v]) => `${t}: source ${v}, stored ${got.get(t)}`)
		);

		const flags = new Map();
		for (const row of library) {
			const title = (row.Title ?? '').trim();
			const flag = (row['Favourite?'] ?? '').trim().toLowerCase();
			if (title && (flag === 'yes' || flag === 'no')) flags.set(title, flag === 'yes');
		}
		const stored = new Map(
			(await sql`select title, is_favourite from library_items`).map((r) => [
				r.title,
				r.is_favourite
			])
		);
		report(
			'Library favourite flag',
			flags.size,
			[...flags]
				.filter(([t, v]) => stored.get(t) !== v)
				.map(([t, v]) => `${t}: source ${v}, stored ${stored.get(t)}`)
		);
	}

	// ─── Movies & TV: ★★★★★ -> integer ─────────────────────────────────────
	{
		const rows = await rowsOf(files.get('Movies & TV Database'));
		const column = Object.keys(rows[0] ?? {}).find(
			(key) => key.includes('Rating') && !key.includes('IMDb')
		);
		const want = new Map();
		for (const row of rows) {
			const name = (row.Name ?? '').trim();
			const n = stars(row[column] ?? '');
			if (name && n) want.set(name, n);
		}
		const got = new Map(
			(await sql`select name, rating from media_items`).map((r) => [r.name, r.rating])
		);
		report(
			'Media star ratings (★ -> integer)',
			want.size,
			[...want]
				.filter(([n, v]) => got.get(n) !== v)
				.map(([n, v]) => `${n}: source ${v} star(s), stored ${got.get(n)}`)
		);
	}

	// ─── Bills: CA$ -> numeric ─────────────────────────────────────────────
	{
		const rows = await rowsOf(files.get('Bills & Subscriptions Database'));
		const want = new Map();
		for (const row of rows) {
			const name = (row.Name ?? '').trim();
			const amount = money(row.Amount ?? '');
			if (name && amount !== null) want.set(name, amount);
		}
		const got = new Map(
			(await sql`select name, amount from bills`).map((r) => [
				r.name,
				r.amount === null ? null : Number(r.amount)
			])
		);
		report(
			'Bill amounts (CA$ -> numeric)',
			want.size,
			[...want]
				.filter(([n, v]) => got.get(n) === null || Math.abs(got.get(n) - v) > 0.005)
				.map(([n, v]) => `${n}: source ${v}, stored ${got.get(n)}`)
		);
	}

	// ─── Areas: a cadence WORD -> days ─────────────────────────────────────
	{
		const rows = await rowsOf(files.get('Areas Database'));
		const want = new Map();
		for (const row of rows) {
			const name = (row['Life Area'] ?? '').trim();
			const word = (row['Review Every'] ?? '').trim().toLowerCase();
			if (name && CADENCE[word]) want.set(name, CADENCE[word]);
		}
		const got = new Map(
			(await sql`select name, review_every_days from areas`).map((r) => [
				r.name,
				r.review_every_days
			])
		);
		report(
			'Area review cadence (word -> days)',
			want.size,
			[...want]
				.filter(([n, v]) => got.get(n) !== v)
				.map(([n, v]) => `${n}: source ${v} days, stored ${got.get(n)}`)
		);
	}

	// ─── Tasks: "In inbox" must not collapse to the fallback ───────────────
	{
		const rows = await rowsOf(files.get('Tasks Database'));
		const MAP = {
			'in inbox': 'inbox',
			'to do': 'todo',
			'in progress': 'in_progress',
			done: 'done'
		};
		const want = new Map();
		for (const row of rows) {
			const title = (row.Task ?? '').trim();
			const status = (row.Status ?? '').trim().toLowerCase();
			if (title && MAP[status]) want.set(title, MAP[status]);
		}
		const got = new Map(
			(await sql`select title, status from tasks`).map((r) => [r.title, r.status])
		);
		report(
			'Task statuses',
			want.size,
			[...want]
				.filter(([t, v]) => got.get(t) !== v)
				.map(([t, v]) => `${t}: source ${v}, stored ${got.get(t)}`)
		);
	}

	// ─── Recipes: every referenced ingredient became a link ────────────────
	{
		const rows = await rowsOf(files.get('Recipes Database'));
		const want = new Map();
		for (const row of rows) {
			const name = (row.Recipe ?? '').trim();
			if (!name) continue;
			// Relation cells are `Title (path)`, joined by ", ". Counting the
			// parenthesised groups is separator-proof, which matters: 32 titles
			// in this export contain commas.
			const count = ((row.Ingredients ?? '').match(/\(/g) ?? []).length;
			if (count) want.set(name, count);
		}
		const got = new Map(
			(
				await sql`
					select r.name, count(ri.ingredient_id)::int as n
					from recipes r left join recipe_ingredients ri on ri.recipe_id = r.id
					group by r.name
				`
			).map((r) => [r.name, r.n])
		);
		report(
			'Recipe -> ingredient links',
			want.size,
			[...want]
				.filter(([n, v]) => got.get(n) !== v)
				.map(([n, v]) => `${n}: source ${v}, stored ${got.get(n)}`)
		);
	}

	// ─── Health vocabulary: seven Notion databases collapse into two tables ──
	//
	// The riskiest mapping in the import, and until now the least checked. Each
	// source database becomes a `kind`, and every row in it must survive as a
	// term of that kind — a database silently mapping to nothing looks exactly
	// like a database that was empty.
	//
	// Vitamins are the exception: since migration 0018 they import into
	// `medications`, and 'vitamin' is no longer a vocabulary kind at all, so
	// they are looked for there — under the stand-in kind 'medication' —
	// rather than reported missing from a table they were never meant to reach.
	{
		const KINDS = {
			'Symptoms Database': 'symptom',
			'Vitamins Database': 'medication',
			'Energy Level Database': 'energy',
			'Mood Feelings Database': 'mood',
			'Exercise Database': 'exercise',
			'Activity Database': 'activity'
		};
		const stored = new Map();
		for (const row of await sql`
			select kind, lower(trim(name)) as name from health_vocabulary
			union all
			select 'medication', lower(trim(name)) from medications
		`) {
			if (!stored.has(row.kind)) stored.set(row.kind, new Set());
			stored.get(row.kind).add(row.name);
		}

		let checked = 0;
		const wrong = [];
		for (const [table, kind] of Object.entries(KINDS)) {
			const rows = await rowsOf(files.get(table));
			// The title column is the first one, whatever it is called: Notion
			// names it after the database, so it differs per table.
			const titleKey = Object.keys(rows[0] ?? {})[0];
			const names = rows
				.map((row) => (row[titleKey] ?? '').trim())
				.filter((name) => name.length > 0);
			const have = stored.get(kind) ?? new Set();
			for (const name of names) {
				checked++;
				if (!have.has(name.toLowerCase())) wrong.push(`${kind}: "${name}" is not stored`);
			}
		}
		report('Health vocabulary (7 databases -> 2 tables)', checked, wrong);
	}

	// ─── Daily log readings: numbers that must survive as numbers ───────────
	//
	// Blood Glucose / Systolic BP / Diastolic BP / Heart Rate are checked in
	// the Health Measurements block below instead — migration 0019 moved them
	// off daily_logs, and `upsertDailyLogs` no longer reads any of the four
	// even from an export old enough to still have the columns.
	{
		const rows = await rowsOf(files.get('Daily Log Database'));
		// `Physical Symptoms ` carries a trailing space in the export's header,
		// and so does `Time Spent Reading `. Reading by the obvious name returns
		// undefined for every row and reports a clean zero.
		const READINGS = {
			'Sleep Score': 'sleep_score',
			Water: 'water',
			Caffeine: 'caffeine'
		};
		const stored = new Map(
			(
				await sql`select on_date::text as d, ${sql.unsafe(Object.values(READINGS).join(', '))} from daily_logs`
			).map((r) => [r.d, r])
		);
		let checked = 0;
		const wrong = [];
		for (const row of rows) {
			const date = (row.Date ?? '').trim();
			const parsed = date ? parseSourceDate(date) : null;
			if (!parsed) continue;
			const target = stored.get(parsed.date);
			if (!target) continue;
			for (const [column, field] of Object.entries(READINGS)) {
				const raw = (row[column] ?? '').trim();
				if (!raw || !/^-?\d+(\.\d+)?$/.test(raw)) continue;
				checked++;
				const want = Number(raw);
				const got = target[field] === null ? null : Number(target[field]);
				if (got === null || Math.abs(got - want) > 0.005) {
					wrong.push(`${parsed.date} ${column}: source ${want}, stored ${got}`);
				}
			}
		}
		report('Daily log readings (numbers stay numbers)', checked, wrong);
	}

	// ─── Health measurements: numbers that must survive as numbers ─────────
	//
	// Matched by the reading's own DATE, not by an exact instant: the source
	// (and `sourceInstant`) can put more than one reading on a day, so this
	// asks "does the source's value for this day and column appear somewhere
	// among that day's stored readings" rather than assuming a 1:1 row match —
	// looser than the daily-log check above on purpose, for the same reason
	// `recentVitals` picks per-metric rather than per-row.
	{
		const rows = await rowsOf(files.get('Health Measurements Database'));
		const READINGS = {
			'Systolic BP': 'systolic',
			'Diastolic BP': 'diastolic',
			'Heart Rate': 'heart_rate',
			'Blood Glucose': 'glucose',
			Weight: 'weight',
			'QT Interval': 'qt_interval'
		};
		const columns = Object.values(READINGS).join(', ');
		const stored = new Map();
		for (const r of await sql`select measured_at::date::text as d, ${sql.unsafe(columns)} from health_measurements`) {
			if (!stored.has(r.d)) stored.set(r.d, []);
			stored.get(r.d).push(r);
		}
		let checked = 0;
		const wrong = [];
		for (const row of rows) {
			const date = (row['Date & Time'] ?? '').trim();
			const parsed = date ? parseSourceDate(date) : null;
			if (!parsed) continue;
			const candidates = stored.get(parsed.date) ?? [];
			for (const [column, field] of Object.entries(READINGS)) {
				const raw = (row[column] ?? '').trim();
				if (!raw || !/^-?\d+(\.\d+)?$/.test(raw)) continue;
				checked++;
				const want = Number(raw);
				const matches = candidates.some(
					(c) => c[field] !== null && Math.abs(Number(c[field]) - want) <= 0.005
				);
				if (!matches)
					wrong.push(`${parsed.date} ${column}: source ${want}, not found among stored readings`);
			}
		}
		report('Health measurements (numbers stay numbers)', checked, wrong);
	}

	// ─── Daily log -> health terms ─────────────────────────────────────────
	{
		const rows = await rowsOf(files.get('Daily Log Database'));
		const header = Object.keys(rows[0] ?? {});
		// Matched loosely on purpose, because of the trailing spaces above.
		const columnFor = (label) =>
			header.find((key) => key.trim().toLowerCase() === label.toLowerCase());
		// No 'Vitamins': a day's vitamins import as `medication_doses` since
		// migration 0018, not as terms, so counting them here would expect
		// daily_log_health rows the importer deliberately no longer writes.
		const RELATIONS = ['Physical Symptoms', 'Energy', 'Mood/Feelings', 'Activity', 'Workout'];

		const stored = new Map();
		for (const row of await sql`
			select d.on_date::text as d, count(*)::int as n
			from daily_log_health h join daily_logs d on d.id = h.daily_log_id
			group by d.on_date
		`) {
			stored.set(row.d, row.n);
		}

		let checked = 0;
		const wrong = [];
		for (const row of rows) {
			const date = (row.Date ?? '').trim();
			const parsed = date ? parseSourceDate(date) : null;
			if (!parsed) continue;
			let want = 0;
			for (const label of RELATIONS) {
				const key = columnFor(label);
				if (!key) continue;
				want += ((row[key] ?? '').match(/\(/g) ?? []).length;
			}
			if (want === 0) continue;
			checked++;
			const got = stored.get(parsed.date) ?? 0;
			if (got !== want) wrong.push(`${parsed.date}: source ${want} term(s), stored ${got}`);
		}
		report('Daily log -> health terms', checked, wrong);
	}

	// ─── Wheel of Life ratings ─────────────────────────────────────────────
	{
		const rows = await rowsOf(files.get('Wheel of Life Database'));
		// The rating column is `Rate 1-10`, not "Rating"; the identity is
		// `Focus`, not the first column by convention. Both were guessed wrong
		// first, which is why they are named literally here.
		const want = new Map();
		for (const row of rows) {
			const focus = (row.Focus ?? '').trim();
			const raw = (row['Rate 1-10'] ?? '').trim();
			const value = stars(raw) || (/^\d+$/.test(raw) ? Number(raw) : 0);
			if (focus && value) want.set(focus, value);
		}
		const got = new Map(
			(await sql`select focus, rating from life_assessments`).map((r) => [r.focus, r.rating])
		);
		report(
			'Wheel of Life ratings',
			want.size,
			[...want]
				.filter(([n, v]) => got.get(n) !== v)
				.map(([n, v]) => `${n}: source ${v}, stored ${got.get(n)}`)
		);
	}

	// ─── Row counts for the packs with no distinctive value to probe ───────
	//
	// Weaker than a value check and labelled as such, but it still catches a
	// whole database mapping to nothing, which is the failure that matters.
	{
		// Each entry lists EVERY source database that feeds the target. `people`
		// is fed by two — People & Places and the Pet Database, because a vet's
		// patient is a member of the household too — and checking it against one
		// of them reported a correct import as wrong.
		const COUNTS = [
			[
				['People & Places Databases', 'Pet Database'],
				sql`select count(*)::int as n from people`,
				'people'
			],
			[['Wishlist Database'], sql`select count(*)::int as n from wishlist_items`, 'wishlist items'],
			[['Meal Plan Database'], sql`select count(*)::int as n from meal_plans`, 'meal plans'],
			[['Prep Tasks Database'], sql`select count(*)::int as n from prep_tasks`, 'prep tasks'],
			[['Ingredients Database'], sql`select count(*)::int as n from ingredients`, 'ingredients'],
			[['Habit Tracker Database'], sql`select count(*)::int as n from habits`, 'habits'],
			[
				['Highlights & Significant Events Database'],
				sql`select count(*)::int as n from significant_events`,
				'significant events'
			]
		];
		let checked = 0;
		const wrong = [];
		for (const [tables, query, label] of COUNTS) {
			let named = 0;
			for (const table of tables) {
				const rows = await rowsOf(files.get(table));
				const titleKey = Object.keys(rows[0] ?? {})[0];
				named += rows.filter((row) => (row[titleKey] ?? '').trim().length > 0).length;
			}
			if (named === 0) continue;
			checked++;
			const [{ n }] = await query;
			if (n !== named) wrong.push(`${label}: source ${named} named row(s), stored ${n}`);
		}
		report('Whole-database row counts', checked, wrong);
	}

	console.log(
		failures === 0
			? `\n  ${GREEN}Every checked value agrees with the export.${OFF}\n`
			: `\n  ${RED}${failures} value(s) disagree with the export.${OFF}\n`
	);
	await sql.end();
	if (failures > 0) process.exitCode = 1;
};

await main();
