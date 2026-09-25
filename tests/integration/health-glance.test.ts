import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { one } from '$lib/server/db/scalar';
import {
	archiveMedication,
	computeDueStatus,
	createHealthMeasurement,
	createLabMarker,
	createLabResult,
	createMedicalVisit,
	createMedication,
	labGlance,
	listHealthMeasurements,
	listMedicalVisits,
	listMedications,
	logDose,
	medicationGlance,
	recentDosesFor,
	setLabMarkerArchived,
	setLabResultArchived,
	setMedicalVisitArchived
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * What `/health` says about the four pages under it.
 *
 * Every number on that page is one somebody acts on — a refill, a call to the
 * clinic — so beyond the rules themselves this file proves the two ways such
 * a number goes quietly wrong: it counts something the viewer may not see
 * (the other member's private record, another household's anything), or it
 * disagrees with the page it links to.
 *
 * Every name and value is invented.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;
/** A member of a second, real household — not just a made-up id — so its
 *  rows exist in the tables and a missing household predicate would count
 *  them. */
let neighbour: Viewer;

/** A Friday, so weekday 5 is "today". */
const TODAY = '2026-09-25';

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

async function makeHousehold(name: string): Promise<string> {
	return one(
		await sql<{ id: string }[]>`
			insert into households (name, timezone) values (${name}, 'America/Toronto')
			returning id
		`,
		'household'
	).id;
}

async function makeViewer(
	householdId: string,
	username: string,
	role: 'admin' | 'member'
): Promise<Viewer> {
	const user = one(
		await sql<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash)
			values (${username}, ${username}, ${role}, 'not-a-real-hash')
			returning id
		`,
		'user'
	);
	await sql`
		insert into household_members (household_id, user_id)
		values (${householdId}::uuid, ${user.id}::uuid)
	`;
	return { userId: user.id, householdId, role };
}

beforeEach(async () => {
	await reset();
	const home = await makeHousehold('Home');
	const nextDoor = await makeHousehold('Next door');
	owner = await makeViewer(home, 'owner', 'admin');
	partner = await makeViewer(home, 'partner', 'member');
	neighbour = await makeViewer(nextDoor, 'neighbour', 'admin');
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what: string) => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

const privately = (viewer: Viewer) => ({
	ownerUserId: viewer.userId,
	visibility: 'private' as const
});

// ─── medications ────────────────────────────────────────────────────────────

const medication = async (viewer: Viewer, name: string, fields: Record<string, unknown> = {}) =>
	ok(
		await createMedication(sql, viewer, {
			name,
			type: 'supplement',
			scheduleKind: 'daily_am',
			...fields
		}),
		`create ${name}`
	).record;

const dose = async (viewer: Viewer, id: string, onDate: string) =>
	ok(await logDose(sql, viewer, id, onDate), `log a dose on ${onDate}`);

describe('medications at a glance', () => {
	it('counts what is due today and not yet taken, by the schedule rules', async () => {
		await medication(owner, 'Morningol');
		const taken = await medication(owner, 'Eveningine', { scheduleKind: 'daily_pm' });
		await dose(owner, taken.id, TODAY);
		await medication(owner, 'Whenevrin', { scheduleKind: 'as_needed' });
		await medication(owner, 'Fridayzole', { scheduleKind: 'scheduled', scheduledWeekday: 5 });
		await medication(owner, 'Mondayrin', { scheduleKind: 'scheduled', scheduledWeekday: 1 });
		const overdue = await medication(owner, 'Weeklyol', {
			scheduleKind: 'scheduled',
			intervalDays: 7
		});
		await dose(owner, overdue.id, '2026-09-10');
		// Two doses, and only the later one keeps it from being due: reading
		// the earliest dose instead of the latest would call this overdue.
		const recent = await medication(owner, 'Recentamine', {
			scheduleKind: 'scheduled',
			intervalDays: 7
		});
		await dose(owner, recent.id, '2026-09-10');
		await dose(owner, recent.id, '2026-09-20');

		expect(await medicationGlance(sql, owner, TODAY)).toEqual({
			tracked: 7,
			// Morningol, Fridayzole, Weeklyol.
			dueToday: 3,
			runningLow: 0
		});
	});

	it('agrees with the count the medications page works out for itself', async () => {
		await medication(owner, 'Morningol');
		const taken = await medication(owner, 'Eveningine', { scheduleKind: 'daily_pm' });
		await dose(owner, taken.id, TODAY);
		await medication(owner, 'Fridayzole', { scheduleKind: 'scheduled', scheduledWeekday: 5 });
		const weekly = await medication(owner, 'Weeklyol', {
			scheduleKind: 'scheduled',
			intervalDays: 7
		});
		await dose(owner, weekly.id, '2026-09-01');
		await medication(owner, 'Whenevrin', { scheduleKind: 'as_needed', runningLow: true });

		// The page's own derivation, verbatim: list, recent doses, then
		// "due today and not taken today" per medication.
		const meds = await listMedications(sql, owner, { limit: 300 });
		const doses = await recentDosesFor(
			sql,
			owner,
			meds.map((m) => m.id),
			10
		);
		const pageDue = meds.filter((m) => {
			const status = computeDueStatus(
				m,
				(doses.get(m.id) ?? []).map((d) => d.onDate),
				TODAY
			);
			return status.isDueToday && status.lastTakenOn !== TODAY;
		}).length;

		// Morningol, Fridayzole, Weeklyol — so agreement below is not two zeros.
		expect(pageDue).toBe(3);
		const glance = await medicationGlance(sql, owner, TODAY);
		expect(glance.dueToday).toBe(pageDue);
		expect(glance.tracked).toBe(meds.length);
		expect(glance.runningLow).toBe(meds.filter((m) => m.runningLow).length);
	});

	it('counts running low, and leaves an archived medication out of everything', async () => {
		await medication(owner, 'Lowdose', { runningLow: true });
		await medication(owner, 'Scarcitol', { scheduleKind: 'as_needed', runningLow: true });
		const gone = await medication(owner, 'Retiredine', { runningLow: true });
		ok(await archiveMedication(sql, owner, gone.id), 'archive');

		expect(await medicationGlance(sql, owner, TODAY)).toEqual({
			tracked: 2,
			dueToday: 1,
			runningLow: 2
		});
	});

	it('never counts the other member’s private medication, or another household’s', async () => {
		await medication(owner, 'Ourpill');
		await medication(partner, 'Theirpill', { runningLow: true, ...privately(partner) });
		await medication(neighbour, 'Nextdoorpill', { runningLow: true });

		expect(await medicationGlance(sql, owner, TODAY)).toEqual({
			tracked: 1,
			dueToday: 1,
			runningLow: 0
		});
		// The same rows are there, and counted, for the people allowed them —
		// so the zeros above are the scope working, not the rows missing.
		expect(await medicationGlance(sql, partner, TODAY)).toEqual({
			tracked: 2,
			dueToday: 2,
			runningLow: 1
		});
		expect(await medicationGlance(sql, neighbour, TODAY)).toEqual({
			tracked: 1,
			dueToday: 1,
			runningLow: 1
		});
	});
});

// ─── labs ───────────────────────────────────────────────────────────────────

const marker = async (
	viewer: Viewer,
	name: string,
	referenceLow: number | null,
	referenceHigh: number | null,
	fields: Record<string, unknown> = {}
) =>
	ok(
		await createLabMarker(sql, viewer, { name, referenceLow, referenceHigh, ...fields }),
		`create marker ${name}`
	).record;

const result = async (
	viewer: Viewer,
	markerId: string,
	resultDate: string,
	value: number,
	fields: Record<string, unknown> = {}
) =>
	ok(
		await createLabResult(sql, viewer, { markerId, resultDate, value, ...fields }),
		`add a result on ${resultDate}`
	).record;

describe('labs at a glance', () => {
	it('reads each marker by its latest result, against its own range', async () => {
		// High once, back in range since: history, not something to act on.
		// Two of these against one that went the other way, so reading the
		// earliest result instead of the latest gives a different count.
		const recovered = await marker(owner, 'Glimmerase', 10, 50);
		await result(owner, recovered.id, '2026-08-01', 60);
		await result(owner, recovered.id, '2026-09-01', 30);
		const settled = await marker(owner, 'Recoverine', 10, 50);
		await result(owner, settled.id, '2026-07-01', 2);
		await result(owner, settled.id, '2026-09-01', 20);
		// In range once, low since.
		const dropped = await marker(owner, 'Testosite level', 10, 50);
		await result(owner, dropped.id, '2026-08-01', 30);
		await result(owner, dropped.id, '2026-09-01', 5);
		// Exactly on the bound is in range — rangeStatus's rule, not a new one.
		const edge = await marker(owner, 'Edgeium', 10, 50);
		await result(owner, edge.id, '2026-09-01', 50);
		// No range recorded: not out of range, and not claimed to be in it.
		const unranged = await marker(owner, 'Unrangeol', null, null);
		await result(owner, unranged.id, '2026-09-01', 999);
		await marker(owner, 'Untestedase', 1, 2);

		expect(await labGlance(sql, owner)).toEqual({ markers: 6, withResults: 5, outOfRange: 1 });
	});

	it('skips an archived result and an archived marker', async () => {
		const m = await marker(owner, 'Glimmerase', 10, 50);
		await result(owner, m.id, '2026-08-01', 30);
		const withdrawn = await result(owner, m.id, '2026-09-01', 99);
		ok(await setLabResultArchived(sql, owner, withdrawn.id, true), 'archive the result');

		const shelved = await marker(owner, 'Shelvedase', 10, 50);
		await result(owner, shelved.id, '2026-09-01', 99);
		ok(await setLabMarkerArchived(sql, owner, shelved.id, true), 'archive the marker');

		expect(await labGlance(sql, owner)).toEqual({ markers: 1, withResults: 1, outOfRange: 0 });
	});

	it('takes the later entry when one day has two draws', async () => {
		const m = await marker(owner, 'Glimmerase', 10, 50);
		await result(owner, m.id, '2026-09-01', 99);
		// Re-drawn the same day; the second entry is the one that stands.
		await result(owner, m.id, '2026-09-01', 30);

		expect(await labGlance(sql, owner)).toMatchObject({ outOfRange: 0 });
	});

	it('never lets the other member’s private result, or another household’s, count', async () => {
		const shared = await marker(owner, 'Glimmerase', 10, 50);
		await result(owner, shared.id, '2026-08-01', 30);
		// Newer and out of range, but private to the partner: for the owner,
		// the latest result they can see is still the in-range one.
		await result(partner, shared.id, '2026-09-01', 99, privately(partner));
		// A marker the owner cannot see at all.
		const theirs = await marker(partner, 'Secretase', 10, 50, privately(partner));
		await result(partner, theirs.id, '2026-09-01', 1);
		const nextDoor = await marker(neighbour, 'Glimmerase', 10, 50);
		await result(neighbour, nextDoor.id, '2026-09-01', 99);

		expect(await labGlance(sql, owner)).toEqual({ markers: 1, withResults: 1, outOfRange: 0 });
		expect(await labGlance(sql, partner)).toEqual({ markers: 2, withResults: 2, outOfRange: 2 });
		expect(await labGlance(sql, neighbour)).toEqual({
			markers: 1,
			withResults: 1,
			outOfRange: 1
		});
	});
});

// ─── visits ─────────────────────────────────────────────────────────────────

/** 08:00 in Toronto on TODAY, which is daylight time: UTC-4. */
const NOW = '2026-09-25T12:00:00.000Z';

const visit = async (
	viewer: Viewer,
	reason: string,
	visitDate: string,
	visitTime: string,
	fields: Record<string, unknown> = {}
) =>
	ok(
		await createMedicalVisit(sql, viewer, { reason, visitDate, visitTime, ...fields }),
		`create visit ${reason}`
	).record;

const nextVisit = async (viewer: Viewer) =>
	(await listMedicalVisits(sql, viewer, { from: NOW, order: 'asc', limit: 1 })).map(
		(v) => v.reason
	);

describe('the next visit', () => {
	it('is the soonest live visit at or after now', async () => {
		await visit(owner, 'Already happened', '2026-09-01', '09:00');
		await visit(owner, 'Later on', '2026-10-15', '09:00');
		await visit(owner, 'Annual check-up', '2026-09-30', '14:40');
		const cancelled = await visit(owner, 'Cancelled', '2026-09-26', '09:00');
		ok(await setMedicalVisitArchived(sql, owner, cancelled.id, true), 'archive');

		expect(await nextVisit(owner)).toEqual(['Annual check-up']);
		expect(
			(await listMedicalVisits(sql, owner, { from: NOW, order: 'asc' })).map((v) => v.reason)
		).toEqual(['Annual check-up', 'Later on']);
	});

	it('includes a visit at exactly now, placed in the household’s zone', async () => {
		await visit(owner, 'On the dot', TODAY, '08:00');
		await visit(owner, 'A minute early', TODAY, '07:59');

		expect(await nextVisit(owner)).toEqual(['On the dot']);
	});

	it('never offers the other member’s private visit, or another household’s', async () => {
		await visit(owner, 'Annual check-up', '2026-09-30', '14:40');
		await visit(partner, 'Their appointment', '2026-09-26', '09:00', privately(partner));
		await visit(neighbour, 'Next door appointment', '2026-09-26', '08:30');

		expect(await nextVisit(owner)).toEqual(['Annual check-up']);
		expect(await nextVisit(partner)).toEqual(['Their appointment']);
		expect(await nextVisit(neighbour)).toEqual(['Next door appointment']);
	});
});

// ─── measurements ───────────────────────────────────────────────────────────

describe('the latest reading', () => {
	// `/health` reuses listHealthMeasurements with a limit of one rather than
	// a query of its own; this pins down that "the first row" is the answer it
	// needs, including when newer readings exist that the viewer may not see.
	it('is the viewer’s most recent, ignoring the other member’s and another household’s', async () => {
		const read = async (viewer: Viewer, measuredAt: string, systolic: number) =>
			ok(
				await createHealthMeasurement(sql, viewer, { measuredAt, systolic, diastolic: 80 }),
				`add a reading at ${measuredAt}`
			);
		await read(owner, '2026-09-20T08:00', 120);
		await read(owner, '2026-09-24T08:00', 124);
		await read(partner, '2026-09-25T08:00', 140);
		await read(neighbour, '2026-09-25T09:00', 150);

		const [latest] = await listHealthMeasurements(sql, owner, { limit: 1 });
		expect(latest?.systolic).toBe(124);
	});
});
