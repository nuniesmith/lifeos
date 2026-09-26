import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createHealthMeasurement,
	getHealthMeasurement,
	listHealthMeasurements,
	setHealthMeasurementArchived,
	updateHealthMeasurement
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Health Measurements (migration 0019).
 *
 * The table this exercises replaces two things at once: it is where the four
 * readings Notion moved out of the Daily Log now live, and it is a real
 * create/edit feature of its own — any subset of six readings, at any
 * instant, optionally against a day's journal entry. Both halves are tested
 * here; the daily-log hand-over itself (recentVitals) is tested alongside
 * `recentVitals` in health.test.ts, where that function already lives.
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

describe('adding a reading', () => {
	it('accepts any subset of the six readings', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 71.4,
				weightUnit: 'kg'
			}),
			'save a weight-only reading'
		).record;

		expect(created).toMatchObject({
			systolic: null,
			diastolic: null,
			heartRate: null,
			glucose: null,
			weight: 71.4,
			qtInterval: null,
			ownerUserId: owner.userId,
			visibility: 'private'
		});
	});

	it('records blood pressure, heart rate and their context together', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				systolic: 118,
				diastolic: 76,
				bpContext: 'Resting',
				heartRate: 64,
				notes: 'Felt fine.'
			}),
			'save a BP reading'
		).record;

		expect(created).toMatchObject({
			systolic: 118,
			diastolic: 76,
			bpContext: 'Resting',
			heartRate: 64,
			notes: 'Felt fine.'
		});
	});

	it('refuses a reading with nothing on it', async () => {
		expect(
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T07:15' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses a reading with no date and time', async () => {
		expect(
			await createHealthMeasurement(sql, owner, { weight: 71.4, weightUnit: 'kg' })
		).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('rejects a reading outside the physiological range rather than storing it', async () => {
		expect(
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T07:15', systolic: 5 })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('rejects a glucose or weight of exactly zero, matching the table’s own CHECK', async () => {
		expect(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 0,
				weightUnit: 'kg'
			})
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('places the reading in the household’s own zone, not UTC', async () => {
		// This suite runs pinned to TZ=America/Toronto (vite.config.ts), which
		// also happens to be the household's own default zone (LIFEOS_TIMEZONE) —
		// so a version of the code that quietly used the process's OWN local
		// zone instead of the household's would give the same, seemingly
		// correct, answer here. Setting the household to a THIRD zone, neither
		// UTC nor the process zone, is what actually forces the household's
		// column to be read.
		await sql`update households set timezone = 'Asia/Tokyo' where id = ${owner.householdId}::uuid`;
		// Noon in Tokyo (JST, UTC+9, no DST) is 03:00 UTC the same day.
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T12:00',
				weight: 71.4,
				weightUnit: 'kg'
			}),
			'save a reading'
		).record;
		expect(created.measuredAt.toISOString()).toBe('2026-09-03T03:00:00.000Z');
	});

	it('links an optional daily log the viewer owns', async () => {
		const day = one(
			await sql<{ id: string }[]>`
				insert into daily_logs (household_id, owner_user_id, on_date, created_by, updated_by)
				values (${owner.householdId}::uuid, ${owner.userId}::uuid, '2026-09-03', ${owner.userId}::uuid, ${owner.userId}::uuid)
				returning id
			`
		);
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 71.4,
				weightUnit: 'kg',
				dailyLogId: day.id
			}),
			'save a linked reading'
		).record;
		expect(created.dailyLogId).toBe(day.id);
	});

	it('refuses a daily log id that does not resolve for this viewer', async () => {
		const theirDay = one(
			await sql<{ id: string }[]>`
				insert into daily_logs (household_id, owner_user_id, on_date, created_by, updated_by)
				values (${partner.householdId}::uuid, ${partner.userId}::uuid, '2026-09-03', ${partner.userId}::uuid, ${partner.userId}::uuid)
				returning id
			`
		);
		expect(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 71.4,
				weightUnit: 'kg',
				dailyLogId: theirDay.id
			})
		).toMatchObject({ ok: false, reason: 'not_found' });
	});
});

describe('the recent list', () => {
	it('orders most recent first', async () => {
		ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-01T08:00',
				weight: 70,
				weightUnit: 'kg'
			}),
			'a'
		);
		ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T08:00',
				weight: 71,
				weightUnit: 'kg'
			}),
			'b'
		);
		ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-02T08:00',
				weight: 69,
				weightUnit: 'kg'
			}),
			'c'
		);

		const list = await listHealthMeasurements(sql, owner);
		expect(list.map((r) => r.weight)).toEqual([71, 69, 70]);
	});

	it('never lists the other member’s readings', async () => {
		ok(
			await createHealthMeasurement(sql, partner, {
				measuredAt: '2026-09-01T08:00',
				weight: 70,
				weightUnit: 'kg'
			}),
			'partner reading'
		);
		expect(await listHealthMeasurements(sql, owner)).toEqual([]);
		expect(await listHealthMeasurements(sql, partner)).toHaveLength(1);
	});

	it('leaves out an archived reading', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-01T08:00',
				weight: 70,
				weightUnit: 'kg'
			}),
			'a reading'
		).record;
		ok(await setHealthMeasurementArchived(sql, owner, created.id, true), 'archive it');

		expect(await listHealthMeasurements(sql, owner)).toEqual([]);
		expect(await listHealthMeasurements(sql, owner, { includeArchived: true })).toHaveLength(1);
	});
});

describe('editing a reading', () => {
	it('changes only the fields supplied, keeping the rest', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				systolic: 118,
				diastolic: 76,
				weight: 71.4,
				weightUnit: 'kg'
			}),
			'create'
		).record;

		const updated = ok(
			await updateHealthMeasurement(sql, owner, created.id, { systolic: 122 }, created.updatedAt),
			'patch systolic only'
		).record;

		expect(updated.systolic).toBe(122);
		expect(updated.diastolic).toBe(76);
		expect(updated.weight).toBe(71.4);
	});

	it('clears a field back to empty when the patch says so explicitly', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				systolic: 118,
				weight: 71.4,
				weightUnit: 'kg',
				bpContext: 'Resting'
			}),
			'create'
		).record;

		const updated = ok(
			await updateHealthMeasurement(sql, owner, created.id, { bpContext: '' }, created.updatedAt),
			'clear the context'
		).record;
		expect(updated.bpContext).toBeNull();
	});

	it('refuses to clear every reading down to nothing', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 71.4,
				weightUnit: 'kg'
			}),
			'create'
		).record;

		expect(
			await updateHealthMeasurement(sql, owner, created.id, { weight: '' }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'invalid' });
		// And it genuinely was not cleared.
		expect((await getHealthMeasurement(sql, owner, created.id))?.weight).toBe(71.4);
	});

	it('refuses a stale write', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 71.4,
				weightUnit: 'kg'
			}),
			'create'
		).record;
		ok(
			await updateHealthMeasurement(sql, owner, created.id, { weight: 72 }, created.updatedAt),
			'first edit'
		);

		expect(
			await updateHealthMeasurement(sql, owner, created.id, { weight: 73 }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('refuses to edit the other member’s reading', async () => {
		const theirs = ok(
			await createHealthMeasurement(sql, partner, {
				measuredAt: '2026-09-03T07:15',
				weight: 71.4,
				weightUnit: 'kg'
			}),
			'their reading'
		).record;

		expect(
			await updateHealthMeasurement(sql, owner, theirs.id, { weight: 72 }, theirs.updatedAt)
		).toMatchObject({ ok: false, reason: 'not_found' });
	});
});

describe('deleting a reading', () => {
	it('archives rather than removing the row — deletion is recoverable everywhere in LifeOS', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 71.4,
				weightUnit: 'kg'
			}),
			'create'
		).record;

		ok(await setHealthMeasurementArchived(sql, owner, created.id, true), 'delete');

		const [row] = await sql<{ archived_at: unknown }[]>`
			select archived_at from health_measurements where id = ${created.id}::uuid
		`;
		expect(row?.archived_at).not.toBeNull();
	});

	it('un-deletes by clearing archived_at', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 71.4,
				weightUnit: 'kg'
			}),
			'create'
		).record;
		ok(await setHealthMeasurementArchived(sql, owner, created.id, true), 'delete');

		ok(await setHealthMeasurementArchived(sql, owner, created.id, false), 'restore');
		expect(await listHealthMeasurements(sql, owner)).toHaveLength(1);
	});
});

describe('units for glucose and weight (migration 0022)', () => {
	/** A reading as the importer leaves one: a value, and no unit recorded. */
	async function imported(values: { glucose?: number; weight?: number }) {
		const [row] = await sql<{ id: string }[]>`
			insert into health_measurements (household_id, owner_user_id, measured_at, glucose, weight)
			values (${owner.householdId}::uuid, ${owner.userId}::uuid, now(),
			        ${values.glucose ?? null}, ${values.weight ?? null})
			returning id
		`;
		const reading = await getHealthMeasurement(sql, owner, row!.id);
		if (!reading) throw new Error('could not read the imported reading back');
		return reading;
	}

	it('stores each value in the unit it was taken in, not converted', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				glucose: 112,
				glucoseUnit: 'mg/dL',
				weight: 154.3,
				weightUnit: 'lb'
			}),
			'save a reading in mg/dL and lb'
		).record;

		const stored = await getHealthMeasurement(sql, owner, created.id);
		expect(stored).toMatchObject({
			glucose: 112,
			glucoseUnit: 'mg/dL',
			weight: 154.3,
			weightUnit: 'lb'
		});
	});

	it('refuses a new glucose or weight without a unit, rather than guessing one', async () => {
		for (const glucoseUnit of [undefined, '', null]) {
			const result = await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				glucose: 6.2,
				...(glucoseUnit === undefined ? {} : { glucoseUnit })
			});
			expect(result).toMatchObject({
				ok: false,
				reason: 'invalid',
				message: 'choose a unit for glucose'
			});
		}
		expect(
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T07:15', weight: 70 })
		).toMatchObject({ ok: false, reason: 'invalid', message: 'choose a unit for weight' });
	});

	it('refuses a unit it does not know, even a near miss', async () => {
		expect(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				glucose: 6.2,
				glucoseUnit: 'mmol/l'
			})
		).toMatchObject({
			ok: false,
			reason: 'invalid',
			message: 'glucose unit must be mmol/L or mg/dL'
		});
		expect(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 11,
				weightUnit: 'stone'
			})
		).toMatchObject({ ok: false, reason: 'invalid', message: 'weight unit must be kg or lb' });
	});

	it('catches a number typed against the wrong unit, and says which unit it fits', async () => {
		const high = await createHealthMeasurement(sql, owner, {
			measuredAt: '2026-09-03T07:15',
			glucose: 112,
			glucoseUnit: 'mmol/L'
		});
		expect(high).toMatchObject({ ok: false, reason: 'invalid' });
		expect(high.ok ? '' : high.message).toContain('did you mean mg/dL?');

		const low = await createHealthMeasurement(sql, owner, {
			measuredAt: '2026-09-03T07:15',
			glucose: 6.2,
			glucoseUnit: 'mg/dL'
		});
		expect(low).toMatchObject({ ok: false, reason: 'invalid' });
		expect(low.ok ? '' : low.message).toContain('did you mean mmol/L?');

		const heavy = await createHealthMeasurement(sql, owner, {
			measuredAt: '2026-09-03T07:15',
			weight: 1500,
			weightUnit: 'lb'
		});
		expect(heavy).toMatchObject({ ok: false, reason: 'invalid' });
		// 1500 fits neither unit, so no other unit is suggested.
		expect(heavy.ok ? '' : heavy.message).not.toContain('did you mean');
	});

	it('does not store the unit the form sends beside an empty value', async () => {
		// The form's unit pickers always submit a value, filled in or not.
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				systolic: 118,
				diastolic: 76,
				glucose: '',
				glucoseUnit: 'mmol/L',
				weight: '',
				weightUnit: 'kg'
			}),
			'save a blood pressure reading'
		).record;
		expect(created).toMatchObject({ glucoseUnit: null, weightUnit: null });
	});

	it('keeps the stored unit when an edit does not mention it', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 154.3,
				weightUnit: 'lb'
			}),
			'save a weight in lb'
		).record;
		const edited = ok(
			await updateHealthMeasurement(sql, owner, created.id, { weight: 155 }, created.updatedAt),
			'change the weight'
		).record;
		expect(edited).toMatchObject({ weight: 155, weightUnit: 'lb' });
	});

	it('changes only the unit when that is all an edit sends', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				weight: 70,
				weightUnit: 'lb'
			}),
			'save a weight recorded against the wrong unit'
		).record;
		const edited = ok(
			await updateHealthMeasurement(
				sql,
				owner,
				created.id,
				{ weightUnit: 'kg' },
				created.updatedAt
			),
			'correct the unit'
		).record;
		expect(edited).toMatchObject({ weight: 70, weightUnit: 'kg' });
	});

	it('clears a unit together with its value', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-09-03T07:15',
				heartRate: 64,
				glucose: 6.2,
				glucoseUnit: 'mmol/L'
			}),
			'save a glucose'
		).record;
		const edited = ok(
			await updateHealthMeasurement(
				sql,
				owner,
				created.id,
				{ glucose: '', glucoseUnit: 'mmol/L' },
				created.updatedAt
			),
			'clear the glucose'
		).record;
		expect(edited).toMatchObject({ glucose: null, glucoseUnit: null, heartRate: 64 });
	});

	it('wants a unit for a value an edit adds to a reading that had none', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T07:15', heartRate: 64 }),
			'save a heart rate'
		).record;
		for (const patch of [{ glucose: 6.2 }, { glucose: 6.2, glucoseUnit: '' }]) {
			expect(
				await updateHealthMeasurement(sql, owner, created.id, patch, created.updatedAt)
			).toMatchObject({ ok: false, reason: 'invalid', message: 'choose a unit for glucose' });
		}
		const edited = ok(
			await updateHealthMeasurement(
				sql,
				owner,
				created.id,
				{ glucose: 6.2, glucoseUnit: 'mmol/L' },
				created.updatedAt
			),
			'add a glucose with its unit'
		).record;
		expect(edited).toMatchObject({ glucose: 6.2, glucoseUnit: 'mmol/L' });
	});

	it('leaves an imported reading without a unit until someone chooses one', async () => {
		const reading = await imported({ glucose: 6.2, weight: 154.3 });
		expect(reading).toMatchObject({ glucoseUnit: null, weightUnit: null });

		// Saving an unrelated change sends the pickers empty ("Not recorded"):
		// that must not quietly assign a unit the reading never had.
		const noted = ok(
			await updateHealthMeasurement(
				sql,
				owner,
				reading.id,
				{ notes: 'After breakfast.', glucoseUnit: '', weightUnit: '' },
				reading.updatedAt
			),
			'add a note'
		).record;
		expect(noted).toMatchObject({ glucoseUnit: null, weightUnit: null, notes: 'After breakfast.' });

		const set = ok(
			await updateHealthMeasurement(
				sql,
				owner,
				reading.id,
				{ glucoseUnit: 'mmol/L', weightUnit: 'lb' },
				noted.updatedAt
			),
			'set the units'
		).record;
		expect(set).toMatchObject({
			glucose: 6.2,
			glucoseUnit: 'mmol/L',
			weight: 154.3,
			weightUnit: 'lb'
		});
	});

	it('is enforced by the table itself, not only by this module', async () => {
		const insert = (glucose: number | null, unit: string) => sql`
			insert into health_measurements (household_id, owner_user_id, measured_at, heart_rate, glucose, glucose_unit)
			values (${owner.householdId}::uuid, ${owner.userId}::uuid, now(), 64, ${glucose}, ${unit})
		`;
		// A unit with no value to describe.
		await expect(insert(null, 'mmol/L')).rejects.toThrow(/glucose_unit_needs_value/);
		// A unit the table does not know.
		await expect(insert(6.2, 'mmol/l')).rejects.toThrow(/glucose_unit_check/);
	});
});

describe('through a client configured the way the app’s is', () => {
	it('adds and edits a reading', async () => {
		// `$lib/server/db` also hands its client to drizzle(), which replaces
		// the driver's timestamp serializers with pass-throughs. A JS Date sent
		// as a parameter then reaches the wire unconverted and throws — which
		// is how "Add a reading" failed in production while every test here
		// passed: the client above is a plain one, and a plain client converts
		// a Date without complaint. This one is set up the way the app's is.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createHealthMeasurement(appLike, owner, {
					measuredAt: '2026-09-03T07:15',
					systolic: 118,
					diastolic: 76
				}),
				'add a reading through the app-like client'
			).record;
			const edited = ok(
				await updateHealthMeasurement(
					appLike,
					owner,
					created.id,
					{ measuredAt: '2026-09-03T08:15', systolic: 121 },
					created.updatedAt
				),
				'edit it through the app-like client'
			).record;
			expect(edited).toMatchObject({ systolic: 121, diastolic: 76 });
			expect(edited.measuredAt.toISOString()).toBe('2026-09-03T12:15:00.000Z');
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
