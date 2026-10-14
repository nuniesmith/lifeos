import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf, type Viewer } from '$lib/server/auth/authz';
import type { AuthUser } from '$lib/server/auth/service';
import { one } from '$lib/server/db/scalar';
import { healthDay } from '$lib/server/repositories';
import { load, type TimelineEntry } from '../../src/routes/(app)/health/day/[date]/+page.server';

/**
 * One day of health as a timeline (PACK3-001).
 *
 * Proves the day and the clock are the household's (Toronto), not UTC; that
 * each source is scoped as its own page scopes it; that archived records are
 * left out; that the journal part is the viewer's own day; and that the page
 * orders timed entries by the clock with the rest under "All day".
 *
 * Every name, value and date here is invented, in 2031.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

const DAY = '2031-03-12';

let owner: Viewer;
let partner: Viewer;
let ownerUser: AuthUser;
let householdId: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	await sql`update households set timezone = 'America/Toronto' where id = ${householdId}::uuid`;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	ownerUser = {
		id: admin.id,
		username: 'admin',
		displayName: 'Admin',
		role: 'admin',
		mustChangeCredentials: false,
		isBootstrap: true
	};
	owner = viewerOf(ownerUser, householdId);
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
			mustChangeCredentials: false,
			isBootstrap: false
		},
		householdId
	);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

/** Visibility for a row: the household's, or private to one member. */
const vis = (privateTo?: string) => ({
	visibility: privateTo ? 'private' : 'household',
	owner: privateTo ?? null
});

async function reading(
	at: string,
	fields: { systolic?: number; weight?: number },
	privateTo?: string
) {
	// A reading always has an owner, even when the household can see it.
	const v = { ...vis(privateTo), owner: privateTo ?? owner.userId };
	await sql`
		insert into health_measurements
			(household_id, visibility, owner_user_id, measured_at, systolic, diastolic, weight)
		values (${householdId}::uuid, ${v.visibility}, ${v.owner}::uuid, ${at}::timestamptz,
		        ${fields.systolic ?? null}, ${fields.systolic ? 80 : null}, ${fields.weight ?? null})
	`;
}

async function medication(name: string, privateTo?: string) {
	const v = vis(privateTo);
	return one(
		await sql<{ id: string }[]>`
			insert into medications (household_id, visibility, owner_user_id, name, type, dose, unit)
			values (${householdId}::uuid, ${v.visibility}, ${v.owner}::uuid, ${name}, 'supplement', '200', 'mg')
			returning id
		`
	).id;
}

const dose = (medicationId: string, slot: string, takenAt: string | null) =>
	sql`insert into medication_doses (medication_id, on_date, slot, taken_at)
	    values (${medicationId}::uuid, ${DAY}::date, ${slot}, ${takenAt}::timestamptz)`;

describe('health on a day', () => {
	it('places moments on the household’s day and clock, not UTC’s', async () => {
		// 03:30 UTC on the 13th is 23:30 on the 12th in Toronto (EDT, -4).
		await reading('2031-03-13T03:30:00Z', { weight: 70.5 });
		// 03:30 UTC on the 12th is the evening of the 11th: not this day.
		await reading('2031-03-12T03:30:00Z', { weight: 71 });
		await reading('2031-03-12T12:15:00Z', { systolic: 120 });

		const day = await healthDay(sql, owner, DAY);
		expect(day.measurements.map((m) => [m.time, m.weight ?? m.systolic])).toEqual([
			['08:15', 120],
			['23:30', 70.5]
		]);
	});

	it('shows each source only as far as its own page would', async () => {
		await reading('2031-03-12T14:00:00Z', { weight: 60 }, partner.userId);
		await dose(await medication('Fictional Secret', partner.userId), 'am', null);
		const [marker] = await sql<{ id: string }[]>`
			insert into lab_markers (household_id, visibility, owner_user_id, name)
			values (${householdId}::uuid, 'private', ${partner.userId}::uuid, 'Fictional Marker')
			returning id
		`;
		await sql`insert into lab_results (household_id, marker_id, result_date, value)
		          values (${householdId}::uuid, ${marker!.id}::uuid, ${DAY}::date, 4.2)`;
		await sql`insert into medical_visits (household_id, visibility, owner_user_id, reason, visit_at)
		          values (${householdId}::uuid, 'private', ${partner.userId}::uuid, 'Fictional check-up',
		                  '2031-03-12T15:00:00Z')`;

		const ownerSees = await healthDay(sql, owner, DAY);
		expect(ownerSees).toMatchObject({ measurements: [], doses: [], visits: [], labResults: [] });

		const partnerSees = await healthDay(sql, partner, DAY);
		expect(partnerSees.measurements).toHaveLength(1);
		expect(partnerSees.doses.map((d) => d.medicationName)).toEqual(['Fictional Secret']);
		expect(partnerSees.visits.map((v) => [v.time, v.reason])).toEqual([
			['11:00', 'Fictional check-up']
		]);
		expect(partnerSees.labResults.map((r) => r.markerName)).toEqual(['Fictional Marker']);
	});

	it('leaves archived readings and visits out', async () => {
		await sql`insert into health_measurements
		            (household_id, owner_user_id, measured_at, weight, archived_at)
		          values (${householdId}::uuid, ${owner.userId}::uuid, '2031-03-12T14:00:00Z', 70, now())`;
		await sql`insert into medical_visits (household_id, reason, visit_at, archived_at)
		          values (${householdId}::uuid, 'Fictional old visit', '2031-03-12T15:00:00Z', now())`;

		const day = await healthDay(sql, owner, DAY);
		expect(day.measurements).toEqual([]);
		expect(day.visits).toEqual([]);
	});

	it('takes mood, energy and words from the viewer’s own journal day only', async () => {
		const [word] = await sql<{ id: string }[]>`
			insert into health_vocabulary (household_id, kind, name)
			values (${householdId}::uuid, 'symptom', 'Fictional headache') returning id
		`;
		for (const [who, mood] of [
			[owner.userId, 'Calm'],
			[partner.userId, 'Tense']
		] as const) {
			const [log] = await sql<{ id: string }[]>`
				insert into daily_logs (household_id, owner_user_id, visibility, on_date, mood, energy_level)
				values (${householdId}::uuid, ${who}::uuid, 'household', ${DAY}::date, ${mood}, 4)
				returning id
			`;
			if (who === partner.userId) {
				await sql`insert into daily_log_health (daily_log_id, vocabulary_id)
				          values (${log!.id}::uuid, ${word!.id}::uuid)`;
			}
		}

		const day = await healthDay(sql, owner, DAY);
		expect(day).toMatchObject({ mood: 'Calm', energyLevel: 4, words: [] });
		expect((await healthDay(sql, partner, DAY)).words.map((w) => w.name)).toEqual([
			'Fictional headache'
		]);
	});

	it('runs timed entries by the clock on the page, with the rest under "All day"', async () => {
		const magnesium = await medication('Fictional Magnesium');
		await dose(magnesium, 'pm', '2031-03-13T01:00:00Z'); // 21:00
		await dose(await medication('Fictional Zinc'), 'adhoc', null); // imported: no time
		await reading('2031-03-12T11:05:00Z', { systolic: 118 }); // 07:05
		await sql`insert into medical_visits (household_id, reason, visit_at)
		          values (${householdId}::uuid, 'Fictional physio', '2031-03-12T18:30:00Z')`; // 14:30

		const data = (await load({
			locals: { user: ownerUser },
			params: { date: DAY }
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any)) as { timed: TimelineEntry[]; allDay: TimelineEntry[] };

		expect(data.timed.map((e) => [e.time, e.kind, e.title])).toEqual([
			['07:05', 'reading', '118/80 mmHg'],
			['14:30', 'visit', 'Fictional physio'],
			['21:00', 'dose', 'Fictional Magnesium']
		]);
		expect(data.timed[2]!.detail).toBe('200 mg · Evening');
		expect(data.allDay.map((e) => [e.kind, e.title])).toEqual([['dose', 'Fictional Zinc']]);
	});

	it('refuses a day that is not a date', async () => {
		await expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			load({ locals: { user: ownerUser }, params: { date: '2031-02-30' } } as any)
		).rejects.toMatchObject({ status: 404 });
	});
});
