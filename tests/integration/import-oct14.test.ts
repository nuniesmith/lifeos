import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { one } from '$lib/server/db/scalar';
import { runImport } from '$lib/server/import/run';
import type { PromoteSummary } from '$lib/server/import/promote';

/**
 * The databases first mapped from the 2026-10-14 export: reading, routines,
 * records and foods, plus the task and event columns that export changed.
 *
 * Each test writes a miniature export carrying the REAL database ids and the
 * relation-cell shape Notion writes (`Title (path/Title <id>.md)`), since the
 * mappers that need a parent at insert time read the id out of that cell.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let householdId: string;
let userId: string;
let uploadDir: string;
const roots: string[] = [];

beforeEach(async () => {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	userId = one(await sql<{ id: string }[]>`select id from users limit 1`).id;
	uploadDir = await mkdtemp(join(tmpdir(), 'lifeos-oct14-'));
});

afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
	await sql`truncate households, users restart identity cascade`;
	await sql.end({ timeout: 5 });
});

interface Row {
	page: string;
	cells: Record<string, string>;
	body?: string;
}
interface Database {
	name: string;
	id: string;
	headers: string[];
	rows: Row[];
}

const DB = {
	author: { name: 'Author Database', id: '3d4879a556f1803db661cb39138e86b5' },
	genre: { name: 'Genres Database', id: '3d9879a556f1801ea898ffa95ff51eb3' },
	series: { name: 'Series Database', id: '3d4879a556f180869fdac9138875a432' },
	book: { name: 'Book Database', id: '3d4879a556f18072b1fac868f6e878d9' },
	log: { name: 'Reading Log Database', id: '3d5879a556f18055aec5e3dabd93b5ca' },
	challenge: { name: 'Reading Challenges Database', id: '3d4879a556f180b18020e59e11f9453b' },
	item: { name: 'Reading Challenge Items Database', id: '3d7879a556f1804c9d65d07985b3214b' },
	routine: { name: 'Routine Database', id: '3e3879a556f1800d8fe4fb38beb4b636' },
	step: { name: 'Routine Steps Database', id: '3e3879a556f180c88b1eef1aa6767e94' },
	routineLog: { name: 'Routine Log Database', id: '3e9879a556f1809690b4f6213fc16371' },
	records: { name: 'Records & Renewals Database', id: '3ea879a556f1808cbd84c9320dc55865' },
	food: { name: 'Food Library Database', id: '3e4879a556f180728be5e42c7ef68f70' },
	tasks: { name: 'Tasks Database', id: '3ad879a556f180c1ac15d106e1e07e2c' },
	themes: { name: 'Themes', id: '3e6879a556f180a1969cf26b9211170f' },
	events: {
		name: 'Highlights & Significant Events Database',
		id: '3bf879a556f1805fbd26fac6769ea5ca'
	}
};

const page = (n: number) => 'f'.repeat(28) + n.toString(16).padStart(4, '0');
const uuid = (hex: string) =>
	`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
/** A relation cell pointing at one row of `db`, as Notion writes it. */
const link = (db: { name: string }, title: string, hex: string) =>
	`${title} (${encodeURIComponent(db.name)}/${encodeURIComponent(`${title} ${hex}`)}.md)`;

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function exportOf(databases: Database[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'lifeos-oct14-export-'));
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

const importFrom = async (root: string, logUserId?: string) => {
	const summary = await runImport(sql, {
		root,
		householdId,
		ownerUserId: userId,
		logUserId: logUserId ?? null,
		startedBy: userId,
		dryRun: false,
		uploadDir
	});
	if (!summary.promoted) throw new Error('the run reported no promotion summary');
	return summary.promoted as PromoteSummary;
};

const countOf = async (table: string) =>
	Number(one(await sql<{ n: string }[]>`select count(*) as n from ${sql(table)}`).n);

describe('reading tracker import', () => {
	const author = page(1);
	const genre = page(2);
	const series = page(3);
	const book = page(4);
	const read = page(5);
	const challenge = page(6);
	const prompt = page(7);

	const readingExport = () =>
		exportOf([
			{
				...DB.author,
				headers: ['Name', 'Authored Books'],
				rows: [
					{
						page: author,
						cells: {
							Name: 'Sarah J. Maas',
							'Authored Books': link(DB.book, 'House of Earth', book)
						}
					}
				]
			},
			{
				...DB.genre,
				headers: ['Genre'],
				rows: [{ page: genre, cells: { Genre: 'Fantasy' } }]
			},
			{
				...DB.series,
				headers: ['Series Title', 'Total Planned Books in Series'],
				rows: [
					{
						page: series,
						cells: { 'Series Title': 'Crescent City', 'Total Planned Books in Series': '4' }
					}
				]
			},
			{
				...DB.book,
				headers: [
					'Title',
					'Author(s)',
					'Genre(s)',
					'Series',
					'Series Position',
					'Status',
					'Rating',
					'Spice Rating',
					'ISBN',
					'Current Reading Format',
					'Audience',
					'Fiction/Non-Fiction',
					'Tropes',
					'eBook Page Count'
				],
				rows: [
					{
						page: book,
						cells: {
							Title: 'House of Earth',
							'Author(s)': link(DB.author, 'Sarah J. Maas', author),
							'Genre(s)': link(DB.genre, 'Fantasy', genre),
							Series: link(DB.series, 'Crescent City', series),
							'Series Position': '1',
							Status: 'Read',
							Rating: '4.5',
							'Spice Rating': '🌶️🌶️🌶️',
							ISBN: '978-1-63557-404-3',
							'Current Reading Format': 'eBook',
							Audience: 'New Adult',
							'Fiction/Non-Fiction': 'Fiction',
							Tropes: 'Enemies-to-Lovers, Found Family',
							'eBook Page Count': '803'
						}
					}
				]
			},
			{
				...DB.log,
				headers: [
					'Name',
					'Book',
					'Status',
					'Date Started',
					'Date Finished',
					'Format Read',
					'Rating This Read'
				],
				rows: [
					{
						page: read,
						cells: {
							Name: 'House of Earth - 1',
							Book: link(DB.book, 'House of Earth', book),
							Status: 'Read',
							'Date Started': 'January 1, 2026',
							'Date Finished': 'January 9, 2026',
							'Format Read': 'eBook',
							'Rating This Read': '4.5'
						}
					}
				]
			},
			{
				...DB.challenge,
				headers: ['Challenge', 'Challenge Style', 'Year', 'Total Items'],
				rows: [
					{
						page: challenge,
						cells: {
							Challenge: 'Read the Rainbow 2026',
							'Challenge Style': 'Prompt List',
							Year: '2026 (Time Databases/Years Database/2026 3b7879a556f18028bf8d11111111aaaa.md)',
							'Total Items': '10'
						}
					}
				]
			},
			{
				...DB.item,
				headers: [
					'Challenge Item',
					'Reading Challenge',
					'Position',
					'Completed with',
					'Completed Date'
				],
				rows: [
					{
						page: prompt,
						cells: {
							'Challenge Item': 'Red Cover',
							'Reading Challenge': link(DB.challenge, 'Read the Rainbow 2026', challenge),
							Position: '1',
							'Completed with': link(DB.log, 'House of Earth - 1', read),
							'Completed Date': 'January 9, 2026'
						}
					}
				]
			}
		]);

	it('imports books with their authors, genre, series, read and challenge prompt', async () => {
		const promoted = await importFrom(await readingExport());
		expect(promoted.unrecognised).toEqual([]);

		const [b] = await sql`
			select b.title, b.status, b.rating::float, b.spice, b.isbn, b.format, b.audience,
			       b.category, b.tropes, b.pages, b.series_position::float, s.name as series,
			       s.planned_count
			from books b join book_series s on s.id = b.series_id
		`;
		expect(b).toMatchObject({
			title: 'House of Earth',
			status: 'read',
			rating: 4.5,
			spice: 3,
			isbn: '9781635574043',
			format: 'ebook',
			audience: 'adult',
			category: 'fiction',
			tropes: ['Enemies-to-Lovers', 'Found Family'],
			pages: 803,
			series_position: 1,
			series: 'Crescent City',
			planned_count: 4
		});
		expect(
			await sql`select a.name from authors a join book_authors ba on ba.author_id = a.id`
		).toEqual([{ name: 'Sarah J. Maas' }]);
		expect(
			await sql`select g.name from genres g join book_genres bg on bg.genre_id = g.id`
		).toEqual([{ name: 'Fantasy' }]);

		const [r] = await sql`
			select status, started_on::text, finished_on::text, format, rating::float, reader_user_id
			from book_reads
		`;
		expect(r).toMatchObject({
			status: 'finished',
			started_on: '2026-01-01',
			finished_on: '2026-01-09',
			format: 'ebook',
			rating: 4.5,
			reader_user_id: userId
		});

		const [c] = await sql`
			select c.title, c.year, c.kind, i.prompt, i.position, i.completed_on::text, b.title as book
			from reading_challenges c
			join reading_challenge_items i on i.challenge_id = c.id
			left join books b on b.id = i.book_id
		`;
		expect(c).toMatchObject({
			title: 'Read the Rainbow 2026',
			year: 2026,
			kind: 'prompts',
			prompt: 'Red Cover',
			position: 1,
			completed_on: '2026-01-09',
			book: 'House of Earth'
		});
	});

	it('is idempotent: a second run adds nothing', async () => {
		const root = await readingExport();
		await importFrom(root);
		await importFrom(root);
		for (const table of [
			'books',
			'authors',
			'book_authors',
			'genres',
			'book_series',
			'book_reads',
			'reading_challenges',
			'reading_challenge_items'
		]) {
			expect(await countOf(table), table).toBe(1);
		}
	});

	it('logs reads as the --log-as user when one is given', async () => {
		const [other] = await sql<{ id: string }[]>`
			insert into users (display_name, role, password_hash) values ('Kayla', 'member', 'x')
			returning id
		`;
		await sql`insert into household_members (household_id, user_id) values (${householdId}, ${other!.id})`;
		await importFrom(await readingExport(), other!.id);
		expect(
			one(await sql<{ reader_user_id: string }[]>`select reader_user_id from book_reads`)
		).toEqual({
			reader_user_id: other!.id
		});
	});

	it('adopts a book already in the household with the same ISBN instead of duplicating it', async () => {
		await sql`
			insert into books (household_id, title, status, isbn, storygraph_id)
			values (${householdId}, 'House of Earth and Blood', 'read', '9781635574043', '9781635574043')
		`;
		await importFrom(await readingExport());
		const books = await sql`select title, notion_page_id, storygraph_id from books`;
		expect(books).toHaveLength(1);
		expect(books[0]).toMatchObject({ notion_page_id: uuid(book), storygraph_id: '9781635574043' });
	});
});

describe('routines import', () => {
	const morning = page(10);
	const meds = page(11);
	const teeth = page(12);
	const fullLog = page(13);

	const routineExport = () =>
		exportOf([
			{
				...DB.routine,
				headers: ['Routine', 'Sort Order'],
				rows: [{ page: morning, cells: { Routine: 'Morning Routine', 'Sort Order': '1' } }]
			},
			{
				...DB.step,
				headers: [
					'Step',
					'Routine',
					'Sort Order',
					'☀️ High Energy Version',
					'🌤️ Average Version',
					'🌱 1% Version'
				],
				rows: [
					{
						page: meds,
						cells: {
							Step: 'Medications - AM',
							Routine: link(DB.routine, 'Morning Routine', morning),
							'Sort Order': '1',
							'☀️ High Energy Version': 'Take meds, vitamins & electrolytes',
							'🌤️ Average Version': 'Take meds & vitamins',
							'🌱 1% Version': 'Take meds'
						}
					},
					{
						// No sort order and no versions: goes last, done as its title says.
						page: teeth,
						cells: { Step: 'Dental Care', Routine: link(DB.routine, 'Morning Routine', morning) }
					}
				]
			},
			{
				...DB.routineLog,
				headers: ['Name', 'Routine Full', 'Date', 'Version'],
				rows: [
					{
						page: fullLog,
						cells: {
							Name: 'Morning Routine - Oct 5',
							'Routine Full': link(DB.routine, 'Morning Routine', morning),
							Date: 'Oct 5, 2026',
							Version: '🌱 1%'
						}
					}
				]
			}
		]);

	it('imports a routine, its steps and versions, and a whole-routine log as every step done', async () => {
		const promoted = await importFrom(await routineExport());
		expect(promoted.unrecognised).toEqual([]);

		expect(await sql`select name, time_of_day from routines`).toEqual([
			{ name: 'Morning Routine', time_of_day: 'morning' }
		]);
		expect(
			await sql`
				select position, title, high_version, average_version, minimal_version
				from routine_steps order by position
			`
		).toEqual([
			{
				position: 1,
				title: 'Medications - AM',
				high_version: 'Take meds, vitamins & electrolytes',
				average_version: 'Take meds & vitamins',
				minimal_version: 'Take meds'
			},
			{
				position: 2,
				title: 'Dental Care',
				high_version: null,
				average_version: 'Dental Care',
				minimal_version: null
			}
		]);
		expect(
			await sql`
				select s.title, c.completed_on::text, c.version
				from routine_step_completions c join routine_steps s on s.id = c.step_id
				order by s.position
			`
		).toEqual([
			{ title: 'Medications - AM', completed_on: '2026-10-05', version: 'minimal' },
			{ title: 'Dental Care', completed_on: '2026-10-05', version: 'minimal' }
		]);
	});

	it('is idempotent: a second run adds no steps or completions', async () => {
		const root = await routineExport();
		await importFrom(root);
		await importFrom(root);
		expect(await countOf('routines')).toBe(1);
		expect(await countOf('routine_steps')).toBe(2);
		expect(await countOf('routine_step_completions')).toBe(2);
	});
});

describe('records, foods, tasks and events from the 2026-10-14 export', () => {
	it('imports records with their kind, keeping an unmatched owner in the notes', async () => {
		await importFrom(
			await exportOf([
				{
					...DB.records,
					headers: [
						'Record',
						'Category',
						'Owner',
						'Issuer/Provider',
						'Issued/Started',
						'Reference #'
					],
					rows: [
						{
							page: page(20),
							cells: {
								Record: 'Birth Certificate',
								Category: 'ID & License',
								Owner: 'Kayla',
								'Issuer/Provider': 'Province of Ontario',
								'Issued/Started': 'September 20, 1994',
								'Reference #': '98-1'
							}
						},
						{ page: page(21), cells: { Record: "Driver's License" } },
						{ page: page(22), cells: { Record: 'Vehicle Title' } }
					]
				}
			])
		);
		expect(
			await sql`select title, kind, issuer, issued_on::text, reference, notes from documents order by title`
		).toEqual([
			{
				title: 'Birth Certificate',
				kind: 'certificate',
				issuer: 'Province of Ontario',
				issued_on: '1994-09-20',
				reference: '98-1',
				notes: 'Owner: Kayla'
			},
			{
				title: "Driver's License",
				kind: 'licence',
				issuer: null,
				issued_on: null,
				reference: null,
				notes: null
			},
			{
				title: 'Vehicle Title',
				kind: 'registration',
				issuer: null,
				issued_on: null,
				reference: null,
				notes: null
			}
		]);
	});

	it('imports foods per serving, keeping calcium in the notes', async () => {
		await importFrom(
			await exportOf([
				{
					...DB.food,
					headers: [
						'Food',
						'Brand',
						'Serving Size',
						'Serving Unit',
						'Calories',
						'Protein',
						'Calcium'
					],
					rows: [
						{
							page: page(30),
							cells: {
								Food: 'Greek yogurt',
								Brand: 'Liberte',
								'Serving Size': '1',
								'Serving Unit': 'container',
								Calories: '150',
								Protein: '7',
								Calcium: '100'
							}
						}
					]
				}
			])
		);
		expect(
			await sql`select name, brand, serving, kcal_per_serving::float, protein_g::float, notes from foods`
		).toEqual([
			{
				name: 'Greek yogurt',
				brand: 'Liberte',
				serving: '1 container',
				kcal_per_serving: 150,
				protein_g: 7,
				notes: 'Calcium: 100 mg'
			}
		]);
	});

	it("reads a task's planning category, renamed energy column, and theme from the Themes database", async () => {
		const task = page(40);
		await importFrom(
			await exportOf([
				{
					...DB.tasks,
					headers: ['Task', 'Status', 'Planning Category', 'Energy Required'],
					rows: [
						{
							page: task,
							cells: {
								Task: 'Submit EI Report',
								Status: 'To Do',
								'Planning Category': 'Hard Deadlines',
								'Energy Required': 'For 1% Days'
							}
						}
					]
				},
				{
					...DB.themes,
					headers: ['Theme', 'Weekday', 'Tasks'],
					rows: [
						{
							page: page(41),
							cells: {
								Theme: 'Money & Admin',
								Weekday: 'Monday',
								Tasks: link(DB.tasks, 'Submit EI Report', task)
							}
						}
					]
				}
			])
		);
		expect(await sql`select title, category, theme, energy from tasks`).toEqual([
			{ title: 'Submit EI Report', category: 'hard_deadline', theme: 'money_admin', energy: 'low' }
		]);
	});

	it('places an event filed under a month with no day on the first of that month', async () => {
		const promoted = await importFrom(
			await exportOf([
				{
					...DB.events,
					headers: ['Significant Event', 'Month'],
					rows: [
						{
							page: page(50),
							cells: {
								'Significant Event': 'Got a full-time job',
								Month:
									'August 2026 (Time Databases/Months Database/August 2026 3bc879a556f18011111111111111aaaa.md)'
							}
						}
					]
				}
			])
		);
		expect(promoted.refusedByMapper).toEqual([]);
		expect(await sql`select title, on_date::text from significant_events`).toEqual([
			{ title: 'Got a full-time job', on_date: '2026-08-01' }
		]);
	});
});
