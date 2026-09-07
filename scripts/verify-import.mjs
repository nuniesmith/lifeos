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
import { parseCsv, stripBom } from '../src/lib/server/import/csv.ts';

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

	console.log(
		failures === 0
			? `\n  ${GREEN}Every checked value agrees with the export.${OFF}\n`
			: `\n  ${RED}${failures} value(s) disagree with the export.${OFF}\n`
	);
	await sql.end();
	if (failures > 0) process.exitCode = 1;
};

await main();
