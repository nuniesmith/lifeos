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
				weight: 71.4
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
		expect(await createHealthMeasurement(sql, owner, { weight: 71.4 })).toMatchObject({
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
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T07:15', weight: 0 })
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
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T12:00', weight: 71.4 }),
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
				dailyLogId: theirDay.id
			})
		).toMatchObject({ ok: false, reason: 'not_found' });
	});
});

describe('the recent list', () => {
	it('orders most recent first', async () => {
		ok(
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-01T08:00', weight: 70 }),
			'a'
		);
		ok(
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T08:00', weight: 71 }),
			'b'
		);
		ok(
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-02T08:00', weight: 69 }),
			'c'
		);

		const list = await listHealthMeasurements(sql, owner);
		expect(list.map((r) => r.weight)).toEqual([71, 69, 70]);
	});

	it('never lists the other member’s readings', async () => {
		ok(
			await createHealthMeasurement(sql, partner, { measuredAt: '2026-09-01T08:00', weight: 70 }),
			'partner reading'
		);
		expect(await listHealthMeasurements(sql, owner)).toEqual([]);
		expect(await listHealthMeasurements(sql, partner)).toHaveLength(1);
	});

	it('leaves out an archived reading', async () => {
		const created = ok(
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-01T08:00', weight: 70 }),
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
				weight: 71.4
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
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T07:15', weight: 71.4 }),
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
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T07:15', weight: 71.4 }),
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
			await createHealthMeasurement(sql, partner, { measuredAt: '2026-09-03T07:15', weight: 71.4 }),
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
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T07:15', weight: 71.4 }),
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
			await createHealthMeasurement(sql, owner, { measuredAt: '2026-09-03T07:15', weight: 71.4 }),
			'create'
		).record;
		ok(await setHealthMeasurementArchived(sql, owner, created.id, true), 'delete');

		ok(await setHealthMeasurementArchived(sql, owner, created.id, false), 'restore');
		expect(await listHealthMeasurements(sql, owner)).toHaveLength(1);
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
