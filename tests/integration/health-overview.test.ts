import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addDays,
	createHealthMeasurement,
	createLabMarker,
	createLabResult,
	createMedication,
	createMedicalVisit,
	healthOverview,
	householdToday,
	logDose
} from '$lib/server/repositories';
import { load as loadHome } from '../../src/routes/(app)/+page.server';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The Health hub's cross-cutting helper (UI follow-up to MODEL-002).
 *
 * `healthOverview` composes four already-tested modules (medications,
 * health-measurements, labs-visits) into the one shape the `/health` overview
 * and the Today page's health panel both read. What is worth proving HERE is
 * not "does medications.ts work" — that is `medications.test.ts`'s job — but
 * the judgement calls unique to combining them: which medications count as
 * "due today", which reading is "the latest" of several, which visit is
 * "next" versus "most recent", and — because `health_measurements` is
 * private by design — that composing four repositories together cannot make
 * a private reading leak that none of the four would leak on its own.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;
let householdId: string;
let today: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`).id;
	owner = viewerOf(
		{
			id: admin,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		householdId
	);
	const created = await createMember(sql, admin, householdId, {
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
	// Real, not hard-coded: the household's own clock decides "today", exactly
	// as `healthOverview`'s caller is required to compute it.
	today = await householdToday(sql, householdId);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what = 'do that') => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

/** 0 = Sunday, matching `scheduledWeekday` and PostgreSQL's `dow`. */
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

describe('medications: due-today grouping', () => {
	it('puts daily_am and daily_pm each in their own group, whether taken or not', async () => {
		const am = ok(
			await createMedication(sql, owner, {
				name: 'Levothyroxine',
				type: 'prescription',
				scheduleKind: 'daily_am'
			}),
			'am medication'
		).record;
		const pm = ok(
			await createMedication(sql, owner, {
				name: 'Magnesium',
				type: 'supplement',
				scheduleKind: 'daily_pm'
			}),
			'pm medication'
		).record;
		ok(await logDose(sql, owner, pm.id, today), 'log pm dose');

		const overview = await healthOverview(sql, owner, today);
		expect(overview.medications.am.map((m) => m.id)).toEqual([am.id]);
		expect(overview.medications.am[0]?.takenToday).toBe(false);
		expect(overview.medications.pm.map((m) => m.id)).toEqual([pm.id]);
		expect(overview.medications.pm[0]?.takenToday).toBe(true);
		expect(overview.medications.dueCount).toBe(1);
		expect(overview.medications.takenCount).toBe(1);
	});

	it('puts a scheduled medication due today under "other", and excludes one not due today', async () => {
		const dueToday = ok(
			await createMedication(sql, owner, {
				name: 'Vitamin B12 shot',
				type: 'supplement',
				scheduleKind: 'scheduled',
				scheduledWeekday: weekdayOf(today)
			}),
			'due-today medication'
		).record;
		ok(
			await createMedication(sql, owner, {
				name: 'Quarterly bloodwork prep',
				type: 'supplement',
				scheduleKind: 'scheduled',
				scheduledWeekday: (weekdayOf(today) + 3) % 7
			}),
			'not-due medication'
		);

		const overview = await healthOverview(sql, owner, today);
		expect(overview.medications.other.map((m) => m.id)).toEqual([dueToday.id]);
	});

	it('never lists an as-needed medication, even one logged today', async () => {
		const prn = ok(
			await createMedication(sql, owner, {
				name: 'Ibuprofen',
				type: 'otc',
				scheduleKind: 'as_needed'
			}),
			'as-needed medication'
		).record;
		ok(await logDose(sql, owner, prn.id, today), 'log prn dose');

		const overview = await healthOverview(sql, owner, today);
		const allIds = [
			...overview.medications.am,
			...overview.medications.pm,
			...overview.medications.other
		].map((m) => m.id);
		expect(allIds).not.toContain(prn.id);
	});

	it('flags running-low regardless of whether the medication is due today', async () => {
		ok(
			await createMedication(sql, owner, {
				name: 'Vitamin D',
				type: 'vitamin',
				scheduleKind: 'daily_am',
				runningLow: true
			}),
			'running-low medication'
		);
		ok(
			await createMedication(sql, owner, {
				name: 'Fish oil, not due today',
				type: 'supplement',
				scheduleKind: 'scheduled',
				scheduledWeekday: (weekdayOf(today) + 3) % 7,
				runningLow: true
			}),
			'running-low, not due'
		);

		const overview = await healthOverview(sql, owner, today);
		expect(overview.medications.am[0]?.runningLow).toBe(true);
		// Counted across every live medication, not only today's list.
		expect(overview.medications.runningLowCount).toBe(2);
	});
});

describe('measurements: the latest of each kind', () => {
	it('reads the most recent value of each kind independently, and the single most recent row overall', async () => {
		ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-01-05T08:00',
				systolic: 118,
				diastolic: 76,
				weight: 70,
				weightUnit: 'kg'
			}),
			'earlier reading'
		);
		ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-01-10T08:00',
				heartRate: 64,
				glucose: 5.4,
				glucoseUnit: 'mmol/L'
			}),
			'later reading, different fields'
		);

		const overview = await healthOverview(sql, owner, today);
		expect(overview.measurements.bloodPressure).toMatchObject({ systolic: 118, diastolic: 76 });
		expect(overview.measurements.heartRate).toMatchObject({ value: 64 });
		expect(overview.measurements.glucose).toMatchObject({ value: 5.4 });
		expect(overview.measurements.weight).toMatchObject({ value: 70 });
		expect(overview.measurements.qtInterval).toBeNull();
		// "Latest of any kind" is the 10th, since it is the more recent row,
		// even though the 5th's weight has no more recent competitor of its own.
		expect(overview.measurements.latestOverall?.heartRate).toBe(64);
	});

	it('orders the trend window chronologically, oldest first', async () => {
		ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-01-10T08:00',
				weight: 71,
				weightUnit: 'kg'
			})
		);
		ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-01-05T08:00',
				weight: 70,
				weightUnit: 'kg'
			})
		);

		const overview = await healthOverview(sql, owner, today);
		expect(overview.measurements.recentChronological.map((r) => r.weight)).toEqual([70, 71]);
	});
});

describe('labs: latest result per marker, flagged against its range', () => {
	it('flags a high, a low, and an in-range result, and skips a marker with no result', async () => {
		const a1c = ok(
			await createLabMarker(sql, owner, { name: 'A1C', referenceLow: 4, referenceHigh: 5.6 }),
			'A1C marker'
		).record;
		const potassium = ok(
			await createLabMarker(sql, owner, {
				name: 'Potassium',
				referenceLow: 3.5,
				referenceHigh: 5.0
			}),
			'potassium marker'
		).record;
		const ldl = ok(
			await createLabMarker(sql, owner, { name: 'LDL', referenceHigh: 3.4 }),
			'LDL marker'
		).record;
		ok(await createLabMarker(sql, owner, { name: 'Never drawn' }), 'untested marker');

		ok(
			await createLabResult(sql, owner, { markerId: a1c.id, resultDate: '2026-01-01', value: 6.1 })
		);
		ok(
			await createLabResult(sql, owner, {
				markerId: potassium.id,
				resultDate: '2026-01-01',
				value: 3.0
			})
		);
		ok(
			await createLabResult(sql, owner, { markerId: ldl.id, resultDate: '2026-01-01', value: 2.0 })
		);

		const overview = await healthOverview(sql, owner, today);
		const byName = new Map(overview.labs.map((item) => [item.markerName, item]));
		expect(byName.get('A1C')).toMatchObject({ status: 'high' });
		expect(byName.get('Potassium')).toMatchObject({ status: 'low' });
		expect(byName.get('LDL')).toMatchObject({ status: 'in_range' });
		expect(byName.has('Never drawn')).toBe(false);
	});

	it('shows the most recent of several results for the same marker', async () => {
		const marker = ok(
			await createLabMarker(sql, owner, { name: 'A1C', referenceLow: 4, referenceHigh: 5.6 })
		).record;
		ok(
			await createLabResult(sql, owner, {
				markerId: marker.id,
				resultDate: '2026-01-01',
				value: 6.5
			})
		);
		ok(
			await createLabResult(sql, owner, {
				markerId: marker.id,
				resultDate: '2026-06-01',
				value: 5.0
			})
		);

		const overview = await healthOverview(sql, owner, today);
		expect(overview.labs).toEqual([
			expect.objectContaining({ value: 5.0, resultDate: '2026-06-01', status: 'in_range' })
		]);
	});
});

describe('visits: next versus most recent', () => {
	it('separates the nearest upcoming visit from the most recent past one', async () => {
		ok(
			await createMedicalVisit(sql, owner, {
				reason: 'Old check-up',
				visitDate: addDays(today, -60),
				visitTime: '09:00'
			})
		);
		const recentPast = ok(
			await createMedicalVisit(sql, owner, {
				reason: 'Follow up',
				visitDate: addDays(today, -3),
				visitTime: '09:00'
			})
		).record;
		const nearFuture = ok(
			await createMedicalVisit(sql, owner, {
				reason: 'Dentist',
				visitDate: addDays(today, 5),
				visitTime: '09:00'
			})
		).record;
		ok(
			await createMedicalVisit(sql, owner, {
				reason: 'Annual physical',
				visitDate: addDays(today, 40),
				visitTime: '09:00'
			})
		);

		const overview = await healthOverview(sql, owner, today);
		expect(overview.visits.mostRecent?.id).toBe(recentPast.id);
		expect(overview.visits.next?.id).toBe(nearFuture.id);
	});

	it('is null on whichever side has nothing', async () => {
		expect((await healthOverview(sql, owner, today)).visits).toEqual({
			mostRecent: null,
			next: null
		});

		ok(
			await createMedicalVisit(sql, owner, {
				reason: 'Only visit, in the future',
				visitDate: addDays(today, 5),
				visitTime: '09:00'
			})
		);
		const overview = await healthOverview(sql, owner, today);
		expect(overview.visits.mostRecent).toBeNull();
		expect(overview.visits.next).not.toBeNull();
	});
});

describe('privacy: a private reading never crosses to another viewer', () => {
	it("never shows the owner the partner's private measurement", async () => {
		ok(
			await createHealthMeasurement(sql, partner, {
				measuredAt: '2026-01-05T08:00',
				weight: 61,
				weightUnit: 'kg',
				heartRate: 58
			}),
			"partner's reading"
		);

		// The admin is still an admin; a health reading is not an admin matter.
		expect(owner.role).toBe('admin');
		const ownerView = await healthOverview(sql, owner, today);
		expect(ownerView.measurements.latestOverall).toBeNull();
		expect(ownerView.measurements.weight).toBeNull();
		expect(ownerView.measurements.heartRate).toBeNull();

		const partnerView = await healthOverview(sql, partner, today);
		expect(partnerView.measurements.weight).toMatchObject({ value: 61 });
	});

	it('never shows the owner the partner’s private measurement through the Today page panel either', async () => {
		ok(
			await createHealthMeasurement(sql, partner, {
				measuredAt: '2026-01-05T08:00',
				weight: 61,
				weightUnit: 'kg'
			}),
			"partner's reading"
		);

		const event = {
			locals: {
				user: {
					id: owner.userId,
					username: 'admin',
					displayName: 'Admin',
					role: 'admin' as const,
					mustChangeCredentials: false,
					isBootstrap: true
				}
			},
			url: new URL('http://localhost/')
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;

		const data = (await loadHome(event)) as {
			health: { measurements: { latestOverall: unknown } };
		};
		expect(data.health.measurements.latestOverall).toBeNull();
	});
});
