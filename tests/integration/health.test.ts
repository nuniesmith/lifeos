import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createDailyLog,
	createHealthTerm,
	healthForLog,
	healthFrequencies,
	healthTermCounts,
	listHealthTerms,
	logHealthTerm,
	recentVitals,
	setHealthTermArchived,
	unlogHealthTerm,
	updateHealthTerm
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Health (migration 0011).
 *
 * The split this file exists to prove: the vocabulary is household-shared —
 * knowing the word "Nausea" exists discloses nothing — while what a person
 * logged against a day is theirs alone, inherited from `daily_logs` rather
 * than reimplemented. If that inheritance ever stops holding, a partner can
 * read a symptom diary, so it is asserted from both directions.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	owner = viewerOf(
		{
			id: admin.id,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		householdId
	);
	const created = await createMember(sql, admin.id, householdId, {
		username: 'partner',
		displayName: 'Partner',
		role: 'member'
	});
	if (!created.ok) throw new Error('could not create the member');
	partner = viewerOf(
		{
			id: created.userId,
			username: 'partner',
			displayName: 'Partner',
			role: 'member',
			mustChangeCredentials: true,
			isBootstrap: false
		},
		householdId
	);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what: string) => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

const term = async (viewer: Viewer, kind: string, name: string, attributes?: object) =>
	ok(
		await createHealthTerm(sql, viewer, { kind, name, ...(attributes ? { attributes } : {}) }),
		`create ${name}`
	).record;

const log = async (viewer: Viewer, onDate: string) =>
	ok(await createDailyLog(sql, viewer, { onDate }), `create log ${onDate}`).record;

describe('the health vocabulary', () => {
	it('keeps five lists in one table, separated by kind', async () => {
		await term(owner, 'symptom', 'Nausea');
		await term(owner, 'mood', 'Content');
		await term(owner, 'energy', 'Balanced');

		expect((await listHealthTerms(sql, owner, { kind: 'symptom' })).map((t) => t.name)).toEqual([
			'Nausea'
		]);
		expect(await healthTermCounts(sql, owner)).toEqual({
			symptom: 1,
			mood: 1,
			energy: 1,
			activity: 0,
			exercise: 0
		});
	});

	it('refuses a list it does not know', async () => {
		expect(
			await createHealthTerm(sql, owner, { kind: 'astrology', name: 'Mercury' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses a second term with the same name in the same list', async () => {
		await term(owner, 'symptom', 'Nausea');
		// Case-insensitively: a second "nausea" is a duplicate nobody intends,
		// and reconciling it later means editing every day already logged.
		expect(await createHealthTerm(sql, owner, { kind: 'symptom', name: 'nausea' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('allows the same word in two different lists', async () => {
		await term(owner, 'symptom', 'Restless');
		expect(await createHealthTerm(sql, owner, { kind: 'mood', name: 'Restless' })).toMatchObject({
			ok: true
		});
	});

	it('stores per-kind extras as an object, not a JSON string', async () => {
		const energy = await term(owner, 'energy', 'Balanced', {
			Approach: 'Ride it',
			Mantra: 'Steady wins'
		});
		expect(energy.attributes).toEqual({ Approach: 'Ride it', Mantra: 'Steady wins' });

		// The bug this guards: ::jsonb on a bare object double-encodes under the
		// bundled build, and every attribute lands as a JSON string of an object.
		const stored = one(
			await sql<{ kind: string }[]>`
				select jsonb_typeof(attributes) as kind from health_vocabulary where id = ${energy.id}::uuid
			`
		);
		expect(stored.kind).toBe('object');
	});

	it('archives a term without touching the days that used it', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		const day = await log(owner, '2026-08-08');
		ok(await logHealthTerm(sql, owner, day.id, nausea.id), 'log');

		ok(await setHealthTermArchived(sql, owner, nausea.id, true), 'archive');

		expect(await listHealthTerms(sql, owner, { kind: 'symptom' })).toEqual([]);
		// The history is intact: what was true on the day stays true.
		expect((await healthForLog(sql, owner, day.id)).map((t) => t.name)).toEqual(['Nausea']);
	});

	it('will not log an archived term onto a new day', async () => {
		const gone = await term(owner, 'symptom', 'Retired');
		ok(await setHealthTermArchived(sql, owner, gone.id, true), 'archive');
		const day = await log(owner, '2026-08-09');

		expect(await logHealthTerm(sql, owner, day.id, gone.id)).toMatchObject({ ok: false });
	});
});

describe('vitamins, which are medications now', () => {
	it('refuses to add a vitamin as a word', async () => {
		expect(
			await createHealthTerm(sql, owner, { kind: 'vitamin', name: 'Vitamin Q' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('keeps a leftover vitamin row out of every list and count /health reads', async () => {
		// Migration 0018 moved every vitamin row into `medications`, but the
		// CHECK still allows the word, so the old add form could have written
		// one after it deployed. Written directly here for the same reason: the
		// repository no longer will.
		const [leftover] = await sql<{ id: string }[]>`
			insert into health_vocabulary (household_id, visibility, kind, name)
			values (${owner.householdId}::uuid, 'household', 'vitamin', 'Vitamin Q')
			returning id
		`;
		const nausea = await term(owner, 'symptom', 'Nausea');
		const day = await log(owner, '2026-08-08');
		// logHealthTerm does not look at kind, so the leftover can still be on a
		// day — which is exactly the row that would reach the frequency list
		// with a label the page has no entry for.
		ok(await logHealthTerm(sql, owner, day.id, leftover!.id), 'log the leftover');
		ok(await logHealthTerm(sql, owner, day.id, nausea.id), 'log a symptom');

		// Each read still returns the live symptom, so an empty answer cannot
		// pass for a filtered one.
		expect((await listHealthTerms(sql, owner)).map((t) => t.name)).toEqual(['Nausea']);
		expect(await healthTermCounts(sql, owner)).toEqual({
			symptom: 1,
			mood: 0,
			energy: 0,
			activity: 0,
			exercise: 0
		});
		expect((await healthFrequencies(sql, owner)).map((f) => f.name)).toEqual(['Nausea']);
		expect((await healthForLog(sql, owner, day.id)).map((t) => t.name)).toEqual(['Nausea']);

		// Hidden, not deleted: the row is still there for anyone who looks.
		const [kept] = await sql<{ kind: string }[]>`
			select kind from health_vocabulary where id = ${leftover!.id}::uuid
		`;
		expect(kept?.kind).toBe('vitamin');
	});
});

describe('logging against a day', () => {
	it('records a term and reads it back', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		const headache = await term(owner, 'symptom', 'Headache');
		const day = await log(owner, '2026-08-08');

		ok(await logHealthTerm(sql, owner, day.id, nausea.id, 'worse in the morning'), 'log');
		ok(await logHealthTerm(sql, owner, day.id, headache.id), 'log');

		const logged = await healthForLog(sql, owner, day.id);
		expect(logged.map((t) => t.name)).toEqual(['Headache', 'Nausea']);
		expect(logged.find((t) => t.name === 'Nausea')?.detail).toBe('worse in the morning');
	});

	it('is idempotent, updating the detail rather than duplicating', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		const day = await log(owner, '2026-08-08');

		ok(await logHealthTerm(sql, owner, day.id, nausea.id, 'mild'), 'log');
		ok(await logHealthTerm(sql, owner, day.id, nausea.id, 'severe'), 'log again');

		const logged = await healthForLog(sql, owner, day.id);
		expect(logged).toHaveLength(1);
		expect(logged[0]?.detail).toBe('severe');
	});

	it('removes a term from a day', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		const day = await log(owner, '2026-08-08');
		ok(await logHealthTerm(sql, owner, day.id, nausea.id), 'log');

		ok(await unlogHealthTerm(sql, owner, day.id, nausea.id), 'unlog');
		expect(await healthForLog(sql, owner, day.id)).toEqual([]);
	});

	it('counts the days a term appeared, which is the point of a list', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		const headache = await term(owner, 'symptom', 'Headache');

		for (const date of ['2026-08-01', '2026-08-02', '2026-08-03']) {
			const day = await log(owner, date);
			ok(await logHealthTerm(sql, owner, day.id, nausea.id), 'log');
		}
		const fourth = await log(owner, '2026-08-04');
		ok(await logHealthTerm(sql, owner, fourth.id, headache.id), 'log');

		const frequencies = await healthFrequencies(sql, owner, { kind: 'symptom' });
		expect(frequencies[0]).toMatchObject({ name: 'Nausea', days: 3, lastLoggedOn: '2026-08-03' });
		expect(frequencies[1]).toMatchObject({ name: 'Headache', days: 1 });
	});

	it('reports the readings a day carried, whichever table they live on', async () => {
		// Blood glucose, systolic BP and heart rate live on health_measurements
		// since migration 0019; water stays on daily_logs. recentVitals has to
		// merge both into the one row-per-day the page renders.
		await log(owner, '2026-08-08');
		await sql`
			insert into health_measurements (household_id, owner_user_id, measured_at, glucose, systolic, heart_rate)
			values (${owner.householdId}::uuid, ${owner.userId}::uuid, '2026-08-08T12:00:00Z'::timestamptz,
			        6.2, 137, 90)
		`;
		await sql`update daily_logs set water = 32 where household_id = ${owner.householdId}::uuid and on_date = '2026-08-08'`;

		const vitals = await recentVitals(sql, owner);
		expect(vitals).toHaveLength(1);
		// numeric travels as a string so the driver cannot round it.
		expect(vitals[0]).toMatchObject({
			onDate: '2026-08-08',
			bloodGlucose: 6.2,
			systolicBp: 137,
			heartRate: 90,
			water: 32
		});
	});

	it('picks the most recent reading of the day when there is more than one', async () => {
		// health_measurements is one row per EVENT, not per day — a day can
		// carry a morning and an evening reading. recentVitals still owes the
		// page one row per day, and the day's own number has to be the latest
		// one, not whichever `max()` would have picked.
		await sql`
			insert into health_measurements (household_id, owner_user_id, measured_at, systolic)
			values (${owner.householdId}::uuid, ${owner.userId}::uuid, '2026-08-08T08:00:00Z'::timestamptz, 110)
		`;
		await sql`
			insert into health_measurements (household_id, owner_user_id, measured_at, systolic)
			values (${owner.householdId}::uuid, ${owner.userId}::uuid, '2026-08-08T20:00:00Z'::timestamptz, 130)
		`;

		const vitals = await recentVitals(sql, owner);
		expect(vitals).toHaveLength(1);
		expect(vitals[0]?.systolicBp).toBe(130);
	});

	it('excludes an archived measurement', async () => {
		await sql`
			insert into health_measurements (household_id, owner_user_id, measured_at, systolic, archived_at)
			values (${owner.householdId}::uuid, ${owner.userId}::uuid, '2026-08-08T08:00:00Z'::timestamptz, 110, now())
		`;
		expect(await recentVitals(sql, owner)).toEqual([]);
	});

	it('skips days with no readings at all', async () => {
		await log(owner, '2026-08-08');
		expect(await recentVitals(sql, owner)).toEqual([]);
	});
});

describe('privacy', () => {
	it('shares the vocabulary across the household', async () => {
		await term(owner, 'symptom', 'Nausea');
		// A shared word list is useful and discloses nothing about who felt it.
		expect((await listHealthTerms(sql, partner, { kind: 'symptom' })).map((t) => t.name)).toEqual([
			'Nausea'
		]);
	});

	it('never shows what the other member logged', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		const theirDay = await log(partner, '2026-08-08');
		ok(await logHealthTerm(sql, partner, theirDay.id, nausea.id), 'log');

		// The admin is still an admin; a symptom diary is not an admin matter.
		expect(owner.role).toBe('admin');
		expect(await healthForLog(sql, owner, theirDay.id)).toEqual([]);
		expect(await healthForLog(sql, partner, theirDay.id)).toHaveLength(1);
	});

	it('never counts the other member’s days in a frequency', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		for (const date of ['2026-08-01', '2026-08-02']) {
			const day = await log(partner, date);
			ok(await logHealthTerm(sql, partner, day.id, nausea.id), 'log');
		}

		expect(await healthFrequencies(sql, owner, { kind: 'symptom' })).toEqual([]);
		expect(await healthFrequencies(sql, partner, { kind: 'symptom' })).toHaveLength(1);
	});

	it('never returns the other member’s readings', async () => {
		await sql`
			insert into health_measurements (household_id, owner_user_id, measured_at, heart_rate)
			values (${partner.householdId}::uuid, ${partner.userId}::uuid, '2026-08-08T12:00:00Z'::timestamptz, 90)
		`;

		expect(await recentVitals(sql, owner)).toEqual([]);
		expect(await recentVitals(sql, partner)).toHaveLength(1);
	});

	it('refuses to log a term onto someone else’s day', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		const theirDay = await log(partner, '2026-08-08');

		expect(await logHealthTerm(sql, owner, theirDay.id, nausea.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(await healthForLog(sql, partner, theirDay.id)).toEqual([]);
	});

	it('refuses to remove a term from someone else’s day', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		const theirDay = await log(partner, '2026-08-08');
		ok(await logHealthTerm(sql, partner, theirDay.id, nausea.id), 'log');

		expect(await unlogHealthTerm(sql, owner, theirDay.id, nausea.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		// And it is genuinely still there, not merely reported as refused.
		expect(await healthForLog(sql, partner, theirDay.id)).toHaveLength(1);
	});

	it('never crosses a household boundary', async () => {
		await term(owner, 'symptom', 'Nausea');
		const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };
		expect(await listHealthTerms(sql, elsewhere)).toEqual([]);
	});
});

describe('editing a term', () => {
	it('renames without disturbing the days that used it', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		const day = await log(owner, '2026-08-08');
		ok(await logHealthTerm(sql, owner, day.id, nausea.id), 'log');

		ok(
			await updateHealthTerm(sql, owner, nausea.id, { name: 'Queasiness' }, nausea.updatedAt),
			'rename'
		);
		expect((await healthForLog(sql, owner, day.id)).map((t) => t.name)).toEqual(['Queasiness']);
	});

	it('refuses a stale write', async () => {
		const nausea = await term(owner, 'symptom', 'Nausea');
		ok(
			await updateHealthTerm(sql, owner, nausea.id, { notes: 'first' }, nausea.updatedAt),
			'first'
		);

		expect(
			await updateHealthTerm(sql, owner, nausea.id, { notes: 'second' }, nausea.updatedAt)
		).toMatchObject({ ok: false, reason: 'conflict' });
	});
});
