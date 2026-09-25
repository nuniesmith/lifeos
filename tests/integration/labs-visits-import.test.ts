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
 * Importing Lab Markers, Lab Results and Medical Visit Log (migration 0020),
 * on a hand-built miniature export -- the same technique as the "exports
 * whose shape changed between imports" block in tests/integration/
 * import.test.ts, kept in its own file rather than added there because two
 * sibling agents are adding their own Health import tests at the same time
 * (see the header of src/lib/server/import/mappers/labs-visits.ts).
 *
 * Every id below is the REAL Notion database id from the Sept 2026 export
 * (they have to be -- promote.ts resolves a database by id, not name), but
 * every marker name, date, value, reason and person is invented. See the
 * project brief's privacy rule: no real health data in code, ever.
 */

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
	uploadDir = await mkdtemp(join(tmpdir(), 'lifeos-labs-import-'));
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

function promotionOf(summary: { promoted?: PromoteSummary }): PromoteSummary {
	if (!summary.promoted) throw new Error('the run reported no promotion summary');
	return summary.promoted;
}

// ─── the same miniature-export builder as import.test.ts's own ────────────

const LAB_MARKERS = { name: 'Lab Markers Database', id: '3e3879a556f180d7ac21fd7759999a01' };
const LAB_RESULTS = { name: 'Lab Results Database', id: '3e3879a556f1806bb6e4f20780d33f2f' };
const MEDICAL_VISITS = {
	name: 'Medical Visit Log Database',
	id: '3c8879a556f180028bcfd042e9832348'
};
const SYMPTOMS = { name: 'Symptom Library Database', id: '3bc879a556f1801a97e8d6ab23727d35' };
const DAILY_LOG = { name: 'Daily Log Database', id: '3b7879a556f180788365fc81070ab3bf' };

const page = (n: number) => 'f'.repeat(28) + n.toString(16).padStart(4, '0');
const uuid = (hex: string) =>
	`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** A Notion relation cell: `Title (Db%20Name/Title%20<32hex>.md)`. */
const rel = (title: string, dbName: string, pageHex: string) =>
	`${title} (${encodeURIComponent(dbName)}/${encodeURIComponent(title)}%20${pageHex}.md)`;

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
	const root = await mkdtemp(join(tmpdir(), 'lifeos-labs-shape-'));
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

describe('labs and visits', () => {
	it('promotes markers, results and a visit, with every relation resolved', async () => {
		const markerHigh = page(1); // "Testosite level": only a high bound
		const markerLow = page(2); // "Glimmerase": only a low bound
		const resultOutOfRangeHigh = page(10);
		const resultInRangeLinkedToVisit = page(11);
		const resultOutOfRangeLow = page(12);
		const symptomTerm = page(20);
		const dailyLog = page(30);
		const theVisit = page(40);

		const summary = await importFrom(
			await exportOf([
				{
					...LAB_MARKERS,
					headers: ['Lab Test', 'Reference High', 'Reference Low', 'Units'],
					rows: [
						{ page: markerHigh, cells: { 'Lab Test': 'Testosite level', 'Reference High': '6' } },
						{ page: markerLow, cells: { 'Lab Test': 'Glimmerase', 'Reference Low': '1' } }
					]
				},
				{
					...LAB_RESULTS,
					headers: ['Result Log', 'Date', 'Lab Test', 'Medical Visit', 'Out of Range?', 'Value'],
					rows: [
						{
							page: resultOutOfRangeHigh,
							cells: {
								'Result Log': 'Testosite Aug',
								Date: 'August 5, 2026',
								'Lab Test': rel('Testosite level', 'Lab Markers Database', markerHigh),
								'Out of Range?': '↑ High',
								Value: '7.2'
							}
						},
						{
							page: resultInRangeLinkedToVisit,
							cells: {
								'Result Log': 'Testosite Mar',
								Date: 'March 1, 2026',
								'Lab Test': rel('Testosite level', 'Lab Markers Database', markerHigh),
								'Medical Visit': rel(
									'Specialist follow up',
									'Medical Visit Log Database',
									theVisit
								),
								'Out of Range?': '✓ In Range',
								Value: '5.1'
							}
						},
						{
							page: resultOutOfRangeLow,
							cells: {
								'Result Log': 'Glimmerase Aug',
								Date: 'August 5, 2026',
								'Lab Test': rel('Glimmerase', 'Lab Markers Database', markerLow),
								'Out of Range?': '↓ Low',
								Value: '0.4'
							}
						}
					]
				},
				{
					...SYMPTOMS,
					headers: ['Name'],
					rows: [{ page: symptomTerm, cells: { Name: 'Ankle stiffness' } }]
				},
				{
					...DAILY_LOG,
					headers: ['Day', 'Date'],
					rows: [{ page: dailyLog, cells: { Day: 'Test day', Date: 'September 25, 2026' } }]
				},
				{
					...MEDICAL_VISITS,
					headers: [
						'Reason',
						'Cost',
						'Daily Log',
						'Date',
						'Family Member',
						'Location',
						'Notes',
						'Paid by?',
						'Provider',
						'Requirements',
						'Symptoms',
						'Visit Type'
					],
					rows: [
						{
							page: theVisit,
							cells: {
								Reason: 'Specialist follow up',
								Cost: 'CA$150.00',
								'Daily Log': rel('Test day', 'Daily Log Database', dailyLog),
								// The real export's own format: no explicit offset digits,
								// just a trailing zone abbreviation -- exactly what
								// sourceInstant exists to read in the household's zone.
								Date: 'September 25, 2026 2:40 PM (EDT)',
								'Family Member': 'Self',
								Location: 'Test Clinic',
								Notes: 'Invented for the test fixture.',
								'Paid by?': 'Insurance',
								Provider: 'Dr. Fake',
								Requirements: 'Bloodwork, Fasting',
								Symptoms: rel('Ankle stiffness', 'Symptom Library Database', symptomTerm),
								'Visit Type': 'Follow Up'
							}
						}
					]
				}
			])
		);

		const promoted = promotionOf(summary);
		expect(promoted.counts.lab_markers).toBe(2);
		expect(promoted.counts.lab_results).toBe(3);
		expect(promoted.counts.medical_visits).toBe(1);
		expect(promoted.relations['lab_result.marker']).toBe(3);
		expect(promoted.relations['lab_result.visit']).toBe(1);
		expect(promoted.relations['visit.symptom']).toBe(1);
		expect(promoted.relations['visit.daily_log']).toBe(1);

		// Neither database is reported as skipped, unrecognised, or refused --
		// the whole point of moving Medical Visit Log out of NOT_IMPORTED.
		const names = [LAB_MARKERS.name, LAB_RESULTS.name, MEDICAL_VISITS.name];
		expect(promoted.notImported.map((d) => d.database)).not.toEqual(expect.arrayContaining(names));
		expect(promoted.unrecognised.map((d) => d.database)).not.toEqual(expect.arrayContaining(names));
		expect(promoted.refusedByMapper).toEqual([]);

		const markers = await sql<
			{ name: string; reference_low: string | null; reference_high: string | null }[]
		>`select name, reference_low, reference_high from lab_markers order by name`;
		expect(markers).toEqual([
			{ name: 'Glimmerase', reference_low: '1.0000', reference_high: null },
			{ name: 'Testosite level', reference_low: null, reference_high: '6.0000' }
		]);

		const results = await sql<{ value: string; medical_visit_id: string | null }[]>`
			select value, medical_visit_id from lab_results
			where notion_page_id = ${uuid(resultInRangeLinkedToVisit)}
		`;
		expect(results).toHaveLength(1);
		expect(results[0]?.medical_visit_id).not.toBeNull();
		expect(Number(results[0]?.value)).toBe(5.1);

		const [visitRow] = await sql<
			{
				reason: string;
				visit_at: Date;
				amount: string | null;
				currency: string;
				requirements: string[];
				daily_log_id: string | null;
			}[]
		>`
			select reason, visit_at, amount, currency, requirements, daily_log_id
			from medical_visits where notion_page_id = ${uuid(theVisit)}
		`;
		expect(visitRow?.reason).toBe('Specialist follow up');
		// "2:40 PM (EDT)" -- 2:40 PM in the household's own zone (America/
		// Toronto, EDT in September) is 18:40 UTC. sourceInstant ignores the
		// "(EDT)" text itself and re-derives the offset from the household's
		// configured zone for that date, which is what makes this correct
		// regardless of which zone the import actually ran in.
		expect(visitRow?.visit_at.toISOString()).toBe('2026-09-25T18:40:00.000Z');
		expect(visitRow?.amount).toBe('150.00');
		expect(visitRow?.currency).toBe('CAD');
		expect(visitRow?.requirements).toEqual(['Bloodwork', 'Fasting']);
		expect(visitRow?.daily_log_id).not.toBeNull();

		const symptomLinks = await sql<{ count: number }[]>`
			select count(*)::int as count from medical_visit_symptoms
		`;
		expect(symptomLinks[0]?.count).toBe(1);
	});

	it('resolves the daily log relation from its OTHER side too, when that is the one Notion populated', async () => {
		const dailyLog = page(31);
		const theVisit = page(41);

		const summary = await importFrom(
			await exportOf([
				{
					...DAILY_LOG,
					// The reciprocal property lives on the Daily Log side this time;
					// the visit itself carries no "Daily Log" column at all.
					headers: ['Day', 'Date', 'Medical Visits'],
					rows: [
						{
							page: dailyLog,
							cells: {
								Day: 'Other day',
								Date: 'September 26, 2026',
								'Medical Visits': rel(
									'Reverse-linked visit',
									'Medical Visit Log Database',
									theVisit
								)
							}
						}
					]
				},
				{
					...MEDICAL_VISITS,
					headers: ['Reason', 'Date'],
					rows: [
						{
							page: theVisit,
							cells: { Reason: 'Reverse-linked visit', Date: 'September 26, 2026 9:00 AM (EDT)' }
						}
					]
				}
			])
		);

		expect(promotionOf(summary).relations['visit.daily_log']).toBe(1);
		const [visitRow] = await sql<{ daily_log_id: string | null }[]>`
			select daily_log_id from medical_visits where notion_page_id = ${uuid(theVisit)}
		`;
		expect(visitRow?.daily_log_id).not.toBeNull();
	});

	it('refuses a result with no value rather than storing a zero', async () => {
		const marker = page(3);
		const resultNoValue = page(13);

		const summary = await importFrom(
			await exportOf([
				{
					...LAB_MARKERS,
					headers: ['Lab Test'],
					rows: [{ page: marker, cells: { 'Lab Test': 'Testosite level' } }]
				},
				{
					...LAB_RESULTS,
					headers: ['Result Log', 'Date', 'Lab Test', 'Value'],
					rows: [
						{
							page: resultNoValue,
							cells: {
								'Result Log': 'No value yet',
								Date: 'August 5, 2026',
								'Lab Test': rel('Testosite level', 'Lab Markers Database', marker),
								Value: ''
							}
						}
					]
				}
			])
		);

		expect(promotionOf(summary).refusedByMapper).toContainEqual({
			database: 'Lab Results Database',
			rows: 1
		});
		expect(
			await sql<{ count: number }[]>`select count(*)::int as count from lab_results`
		).toMatchObject([{ count: 0 }]);
	});
});
