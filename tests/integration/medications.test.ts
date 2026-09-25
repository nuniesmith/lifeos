import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	archiveMedication,
	createMedication,
	listMedications,
	logDose,
	recentDosesFor,
	setMedicationRunningLow,
	unarchiveMedication,
	undoDose,
	updateMedication
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Medications & supplements (migration 0018).
 *
 * Unlike `health_vocabulary`, a medication defaults to household-shared, not
 * owner-private: the source is one board either member can act on, so
 * privacy here is tested for the opposite thing health.test.ts proves — that
 * a shared record IS visible and writable by a partner by default, and that
 * an explicit `private` row still is not.
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

// Every name is invented — see the branch's PR description for why.
const add = async (viewer: Viewer, overrides: Record<string, unknown> = {}) =>
	ok(
		await createMedication(sql, viewer, {
			name: 'Testamine',
			type: 'prescription',
			scheduleKind: 'daily_am',
			...overrides
		}),
		'create the medication'
	).record;

describe('creating a medication', () => {
	it('defaults to household-shared, unlike the health vocabulary it replaces', async () => {
		const med = await add(owner);
		expect(med.visibility).toBe('household');
		expect(med.ownerUserId).toBeNull();
	});

	it('defaults schedule to as_needed and status to taking', async () => {
		const med = await add(owner, { scheduleKind: undefined });
		expect(med.scheduleKind).toBe('as_needed');
		expect(med.status).toBe('taking');
		expect(med.runningLow).toBe(false);
	});

	it('refuses an unknown type', async () => {
		expect(
			await createMedication(sql, owner, { name: 'Fauxprofen', type: 'homeopathic' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses a second live medication with the same name, case-insensitively', async () => {
		await add(owner, { name: 'Placeboxetine' });
		expect(
			await createMedication(sql, owner, {
				name: 'placeboxetine',
				type: 'supplement'
			})
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('allows the name again once the first is archived', async () => {
		const first = await add(owner, { name: 'Reusalol' });
		ok(await archiveMedication(sql, owner, first.id), 'archive');
		expect(await createMedication(sql, owner, { name: 'Reusalol', type: 'otc' })).toMatchObject({
			ok: true
		});
	});

	describe('the weekday / interval pair', () => {
		it('refuses both a weekday and an interval at once', async () => {
			expect(
				await createMedication(sql, owner, {
					name: 'Bimodaline',
					type: 'prescription',
					scheduleKind: 'scheduled',
					scheduledWeekday: 5,
					intervalDays: 30
				})
			).toMatchObject({ ok: false, reason: 'invalid' });
		});

		it('refuses a weekday on a medication that is not scheduled', async () => {
			expect(
				await createMedication(sql, owner, {
					name: 'Strayweekday',
					type: 'prescription',
					scheduleKind: 'daily_am',
					scheduledWeekday: 2
				})
			).toMatchObject({ ok: false, reason: 'invalid' });
		});

		it('accepts a weekday alone on a scheduled medication', async () => {
			const med = await add(owner, {
				name: 'Weeklyzine',
				scheduleKind: 'scheduled',
				scheduledWeekday: 5
			});
			expect(med).toMatchObject({
				scheduleKind: 'scheduled',
				scheduledWeekday: 5,
				intervalDays: null
			});
		});
	});
});

describe('editing a medication', () => {
	it('updates fields and refuses a stale write', async () => {
		const med = await add(owner, { name: 'Editable' });
		ok(await updateMedication(sql, owner, med.id, { dose: '10' }, med.updatedAt), 'first edit');

		expect(await updateMedication(sql, owner, med.id, { dose: '20' }, med.updatedAt)).toMatchObject(
			{ ok: false, reason: 'conflict' }
		);
	});

	it('re-validates the weekday/interval pair against a NEW schedule, not just a patched one', async () => {
		const med = await add(owner, {
			name: 'Switcheroo',
			scheduleKind: 'scheduled',
			scheduledWeekday: 3
		});
		// The weekday is not mentioned in this patch at all, but it is still on
		// the row, and the new schedule no longer allows it.
		expect(
			await updateMedication(sql, owner, med.id, { scheduleKind: 'as_needed' }, med.updatedAt)
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('clears the weekday when the patch explicitly does so', async () => {
		const med = await add(owner, {
			name: 'Clearweekday',
			scheduleKind: 'scheduled',
			scheduledWeekday: 3
		});
		const updated = ok(
			await updateMedication(
				sql,
				owner,
				med.id,
				{ scheduleKind: 'as_needed', scheduledWeekday: null },
				med.updatedAt
			),
			'clear and switch'
		).record;
		expect(updated.scheduledWeekday).toBeNull();
	});

	it('archives without disturbing another household member’s ability to still read it', async () => {
		const med = await add(owner, { name: 'Archivable' });
		ok(await archiveMedication(sql, owner, med.id), 'archive');

		expect(await listMedications(sql, owner)).toEqual([]);
		expect(await listMedications(sql, owner, { includeArchived: true })).toHaveLength(1);

		const restored = ok(await unarchiveMedication(sql, owner, med.id), 'restore');
		expect(restored.record.archivedAt).toBeNull();
	});
});

describe('running low', () => {
	it('toggles independently of the rest of the record', async () => {
		const med = await add(owner, { name: 'Lowstock' });
		const flagged = ok(await setMedicationRunningLow(sql, owner, med.id, true), 'flag');
		expect(flagged.record.runningLow).toBe(true);
		expect(flagged.record.name).toBe('Lowstock');
	});
});

describe('logging a dose', () => {
	it('derives the slot from the medication’s own schedule', async () => {
		const am = await add(owner, { name: 'Morningdose', scheduleKind: 'daily_am' });
		const pm = await add(owner, { name: 'Eveningdose', scheduleKind: 'daily_pm' });
		const prn = await add(owner, { name: 'Anytimedose', scheduleKind: 'as_needed' });

		ok(await logDose(sql, owner, am.id, '2026-09-24'), 'log am');
		ok(await logDose(sql, owner, pm.id, '2026-09-24'), 'log pm');
		ok(await logDose(sql, owner, prn.id, '2026-09-24'), 'log prn');

		const doses = await recentDosesFor(sql, owner, [am.id, pm.id, prn.id]);
		expect(doses.get(am.id)?.[0]).toMatchObject({ slot: 'am', onDate: '2026-09-24' });
		expect(doses.get(pm.id)?.[0]).toMatchObject({ slot: 'pm', onDate: '2026-09-24' });
		expect(doses.get(prn.id)?.[0]).toMatchObject({ slot: 'adhoc', onDate: '2026-09-24' });
	});

	it('is idempotent for the same day: a second log refreshes rather than duplicates', async () => {
		const med = await add(owner, { name: 'Repeatlog' });
		ok(await logDose(sql, owner, med.id, '2026-09-24'), 'log once');
		ok(await logDose(sql, owner, med.id, '2026-09-24', 'second tap'), 'log again');

		const doses = await recentDosesFor(sql, owner, [med.id]);
		expect(doses.get(med.id)).toHaveLength(1);
		expect(doses.get(med.id)?.[0]?.note).toBe('second tap');
	});

	it('undoes a logged dose', async () => {
		const med = await add(owner, { name: 'Undoable' });
		ok(await logDose(sql, owner, med.id, '2026-09-24'), 'log');
		ok(await undoDose(sql, owner, med.id, '2026-09-24'), 'undo');

		const doses = await recentDosesFor(sql, owner, [med.id]);
		expect(doses.get(med.id) ?? []).toEqual([]);
	});

	it('caps and orders recent history, most recent first', async () => {
		const med = await add(owner, { name: 'Historyrich', scheduleKind: 'as_needed' });
		for (const day of ['2026-09-01', '2026-09-02', '2026-09-03']) {
			ok(await logDose(sql, owner, med.id, day), `log ${day}`);
		}
		const doses = await recentDosesFor(sql, owner, [med.id], 2);
		expect(doses.get(med.id)?.map((d) => d.onDate)).toEqual(['2026-09-03', '2026-09-02']);
	});

	it('refuses to log a medication that does not exist', async () => {
		expect(await logDose(sql, owner, crypto.randomUUID(), '2026-09-24')).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});
});

describe('privacy — household-shared by default', () => {
	it('a medication either member creates is visible to both', async () => {
		const med = await add(owner, { name: 'Sharedpill' });
		expect((await listMedications(sql, partner)).map((m) => m.id)).toContain(med.id);
	});

	it('a partner can log a dose against a household medication owner created', async () => {
		const med = await add(owner, { name: 'Coadministered' });
		ok(await logDose(sql, partner, med.id, '2026-09-24'), 'partner logs it');

		const doses = await recentDosesFor(sql, owner, [med.id]);
		expect(doses.get(med.id)).toHaveLength(1);
	});

	it('an explicitly private medication is invisible to the other member', async () => {
		const med = ok(
			await createMedication(sql, owner, {
				name: 'Privatepill',
				type: 'prescription',
				ownerUserId: owner.userId,
				visibility: 'private'
			}),
			'create private'
		).record;

		expect((await listMedications(sql, partner)).map((m) => m.id)).not.toContain(med.id);
		expect(await logDose(sql, partner, med.id, '2026-09-24')).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('never crosses a household boundary', async () => {
		await add(owner, { name: 'Householdbound' });
		const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };
		expect(await listMedications(sql, elsewhere)).toEqual([]);
	});
});
