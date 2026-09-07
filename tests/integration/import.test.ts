import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { count as countOf, one } from '$lib/server/db/scalar';
import { runImport } from '$lib/server/import/run';

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
		expect(summary.rows).toBe(11);
		expect(summary.databases).toBe(4);

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
			11
		);
	});

	it('parses a quoted comma and an embedded newline as single fields', async () => {
		await run(false);
		const titles = (
			await sql<{ title: string }[]>`select title from source_records order by title`
		).map((r) => r.title);
		expect(titles).toContain('Call Andrea Hunt, NP');
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
				select area_id from tasks where title = 'Call Andrea Hunt, NP'
			`
		);
		expect(task.area_id).not.toBeNull();
	});

	it('carries typed values through, not just titles', async () => {
		await run(false);
		const task = one(
			await sql<{ do_on: unknown; is_important: boolean; status: string }[]>`
				select do_on, is_important, status from tasks where title = 'Call Andrea Hunt, NP'
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

	it('carries the daily log readings, including the decimal one', async () => {
		await run(false);
		const log = one(
			await sql<
				{
					blood_glucose: unknown;
					systolic_bp: number | null;
					heart_rate: number | null;
					water: number | null;
					caffeine: boolean | null;
					intimacy: boolean | null;
					head_space: string | null;
				}[]
			>`
				select blood_glucose, systolic_bp, heart_rate, water, caffeine, intimacy, head_space
				from daily_logs where on_date = '2026-08-08'
			`
		);
		// numeric arrives as a string so the driver cannot round it; 6.2 read
		// with parseInt would have become 6.
		expect(Number(log.blood_glucose)).toBe(6.2);
		expect(log.systolic_bp).toBe(137);
		expect(log.heart_rate).toBe(90);
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
				select notes from tasks where title = 'Call Andrea Hunt, NP'
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
			where r.title = 'Call Andrea Hunt, NP' and l.entity_type = 'source_record'
		`;
		// scan_(1).png: stopping at the first ')' produced a path matching nothing.
		expect(rows).toHaveLength(1);
		expect(rows[0]!.role).toBe('body_image');
	});
});
