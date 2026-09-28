import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addVisitSymptom,
	createHealthTerm,
	createLabMarker,
	createLabResult,
	createMedicalVisit,
	createPerson,
	getLabMarker,
	getMedicalVisit,
	labResultCounts,
	linkedNamesForVisit,
	listLabMarkers,
	listLabResults,
	listMedicalVisits,
	removeVisitSymptom,
	resultsForVisit,
	setLabMarkerArchived,
	setLabResultArchived,
	setMedicalVisitArchived,
	setPersonArchived,
	symptomsForVisit,
	updateLabMarker,
	updateLabResult,
	updateMedicalVisit
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Lab results and medical visits (migration 0020).
 *
 * All names and numbers here are invented ("Testosite level", "Glimmerase")
 * -- see the privacy rule in the project brief. `rangeStatus`'s own boundary
 * behaviour is unit-tested in tests/unit/labs-visits.test.ts; this file
 * proves it end to end through the joined `resultsForVisit` read, plus the
 * household-timezone handling on a visit's date + time (§ below), which
 * cannot be exercised without a real household row.
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

const marker = async (
	viewer: Viewer,
	name: string,
	referenceLow: number | null,
	referenceHigh: number | null
) =>
	ok(
		await createLabMarker(sql, viewer, { name, referenceLow, referenceHigh }),
		`create marker ${name}`
	).record;

const visit = async (viewer: Viewer, reason: string, visitDate: string, visitTime: string) =>
	ok(
		await createMedicalVisit(sql, viewer, { reason, visitDate, visitTime }),
		`create visit ${reason}`
	).record;

describe('lab markers', () => {
	it('creates a marker with a reference range and lists it', async () => {
		await marker(owner, 'Testosite level', 10, 50);
		const markers = await listLabMarkers(sql, owner);
		expect(markers.map((m) => m.name)).toEqual(['Testosite level']);
		expect(markers[0]).toMatchObject({ referenceLow: 10, referenceHigh: 50, units: null });
	});

	it('accepts a marker with only one reference bound', async () => {
		const m = await marker(owner, 'Glimmerase', null, 5);
		expect(m).toMatchObject({ referenceLow: null, referenceHigh: 5 });
	});

	it('refuses a second marker with the same name in the household', async () => {
		await marker(owner, 'Testosite level', 10, 50);
		// Case-insensitively, the same rule health_vocabulary and ingredients use.
		expect(
			await createLabMarker(sql, owner, {
				name: 'testosite level',
				referenceLow: 0,
				referenceHigh: 1
			})
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses a reference high below the reference low, on create and on edit', async () => {
		expect(
			await createLabMarker(sql, owner, { name: 'Backwards', referenceLow: 50, referenceHigh: 10 })
		).toMatchObject({ ok: false, reason: 'invalid' });

		const m = await marker(owner, 'Testosite level', 10, 50);
		expect(
			await updateLabMarker(sql, owner, m.id, { referenceHigh: 1 }, m.updatedAt)
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('edits the reference range without disturbing existing results', async () => {
		const m = await marker(owner, 'Testosite level', 10, 50);
		ok(
			await createLabResult(sql, owner, { markerId: m.id, resultDate: '2026-08-01', value: 30 }),
			'result'
		);

		const edited = ok(
			await updateLabMarker(sql, owner, m.id, { referenceHigh: 100 }, m.updatedAt),
			'edit'
		).record;
		expect(edited.referenceHigh).toBe(100);
		expect(await listLabResults(sql, owner, { markerId: m.id })).toHaveLength(1);
	});

	it('refuses a stale edit', async () => {
		const m = await marker(owner, 'Testosite level', 10, 50);
		ok(await updateLabMarker(sql, owner, m.id, { units: 'mmol/L' }, m.updatedAt), 'first');
		expect(await updateLabMarker(sql, owner, m.id, { units: 'g/L' }, m.updatedAt)).toMatchObject({
			ok: false,
			reason: 'conflict'
		});
	});

	it('archives a marker so it drops out of the list, without deleting it', async () => {
		const m = await marker(owner, 'Testosite level', 10, 50);
		ok(await setLabMarkerArchived(sql, owner, m.id, true), 'archive');

		expect(await listLabMarkers(sql, owner)).toEqual([]);
		expect(await getLabMarker(sql, owner, m.id)).toMatchObject({
			id: m.id,
			archivedAt: expect.any(Date)
		});
	});
});

describe('lab results', () => {
	it('creates a result and reads it back with the marker attached', async () => {
		const m = await marker(owner, 'Testosite level', 10, 50);
		const r = ok(
			await createLabResult(sql, owner, {
				markerId: m.id,
				resultDate: '2026-08-01',
				value: 62.5,
				notes: 'fasting'
			}),
			'result'
		).record;

		expect(r).toMatchObject({
			markerId: m.id,
			resultDate: '2026-08-01',
			value: 62.5,
			notes: 'fasting'
		});
	});

	it('refuses a result with no marker', async () => {
		expect(await createLabResult(sql, owner, { resultDate: '2026-08-01', value: 1 })).toMatchObject(
			{ ok: false, reason: 'invalid' }
		);
	});

	it('refuses a marker id from another household rather than attaching it', async () => {
		const theirs = await marker(owner, 'Testosite level', 10, 50);
		const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };
		expect(
			await createLabResult(sql, elsewhere, {
				markerId: theirs.id,
				resultDate: '2026-08-01',
				value: 1
			})
		).toMatchObject({ ok: false, reason: 'not_found' });
	});

	it('links an existing visit, but degrades to "no visit" rather than failing when the id does not resolve', async () => {
		const m = await marker(owner, 'Testosite level', 10, 50);
		const v = await visit(owner, 'Follow up', '2026-08-01', '09:00');

		const linked = ok(
			await createLabResult(sql, owner, {
				markerId: m.id,
				resultDate: '2026-08-01',
				value: 1,
				medicalVisitId: v.id
			}),
			'linked result'
		).record;
		expect(linked.medicalVisitId).toBe(v.id);

		const unresolvable = ok(
			await createLabResult(sql, owner, {
				markerId: m.id,
				resultDate: '2026-08-02',
				value: 2,
				medicalVisitId: crypto.randomUUID()
			}),
			'result with a bogus visit id'
		).record;
		expect(unresolvable.medicalVisitId).toBeNull();
	});

	it('orders most-recent-first by default, chronological when asked for a chart', async () => {
		const m = await marker(owner, 'Testosite level', 10, 50);
		for (const [resultDate, value] of [
			['2026-01-01', 1],
			['2026-06-01', 2],
			['2026-03-01', 3]
		] as const) {
			ok(await createLabResult(sql, owner, { markerId: m.id, resultDate, value }), 'result');
		}

		expect((await listLabResults(sql, owner, { markerId: m.id })).map((r) => r.resultDate)).toEqual(
			['2026-06-01', '2026-03-01', '2026-01-01']
		);
		expect(
			(await listLabResults(sql, owner, { markerId: m.id, order: 'asc' })).map((r) => r.resultDate)
		).toEqual(['2026-01-01', '2026-03-01', '2026-06-01']);
	});

	it('counts live results per marker', async () => {
		const a = await marker(owner, 'Testosite level', 10, 50);
		const b = await marker(owner, 'Glimmerase', 1, 5);
		ok(
			await createLabResult(sql, owner, { markerId: a.id, resultDate: '2026-01-01', value: 1 }),
			'r1'
		);
		ok(
			await createLabResult(sql, owner, { markerId: a.id, resultDate: '2026-02-01', value: 1 }),
			'r2'
		);
		ok(
			await createLabResult(sql, owner, { markerId: b.id, resultDate: '2026-01-01', value: 1 }),
			'r3'
		);

		expect(await labResultCounts(sql, owner)).toEqual({ [a.id]: 2, [b.id]: 1 });
	});

	it('edits a result and refuses a stale edit', async () => {
		const m = await marker(owner, 'Testosite level', 10, 50);
		const r = ok(
			await createLabResult(sql, owner, { markerId: m.id, resultDate: '2026-08-01', value: 1 }),
			'result'
		).record;

		const edited = ok(
			await updateLabResult(sql, owner, r.id, { value: 99 }, r.updatedAt),
			'edit'
		).record;
		expect(edited.value).toBe(99);

		expect(await updateLabResult(sql, owner, r.id, { value: 1 }, r.updatedAt)).toMatchObject({
			ok: false,
			reason: 'conflict'
		});
	});

	it('archives a result without deleting it', async () => {
		const m = await marker(owner, 'Testosite level', 10, 50);
		const r = ok(
			await createLabResult(sql, owner, { markerId: m.id, resultDate: '2026-08-01', value: 1 }),
			'result'
		).record;
		ok(await setLabResultArchived(sql, owner, r.id, true), 'archive');
		expect(await listLabResults(sql, owner, { markerId: m.id })).toEqual([]);
	});
});

describe('a visit and its results, joined', () => {
	it('flags each linked result against its OWN marker’s range', async () => {
		const high = await marker(owner, 'Testosite level', 0, 10);
		const inRange = await marker(owner, 'Glimmerase', 0, 10);
		const v = await visit(owner, 'Annual check-up', '2026-08-01', '10:00');

		ok(
			await createLabResult(sql, owner, {
				markerId: high.id,
				resultDate: '2026-08-01',
				value: 99,
				medicalVisitId: v.id
			}),
			'high result'
		);
		ok(
			await createLabResult(sql, owner, {
				markerId: inRange.id,
				resultDate: '2026-08-01',
				value: 5,
				medicalVisitId: v.id
			}),
			'in-range result'
		);

		const results = await resultsForVisit(sql, owner, v.id);
		expect(results).toHaveLength(2);
		expect(results.find((r) => r.markerName === 'Testosite level')?.status).toBe('high');
		expect(results.find((r) => r.markerName === 'Glimmerase')?.status).toBe('in_range');
	});
});

describe('medical visits', () => {
	it('reads a date and time as wall-clock in the household’s own timezone, not the process’s', async () => {
		// The household bootstraps at the schema default, America/Toronto.
		// EDT in September is UTC-4: 14:40 local is 18:40 UTC.
		const summer = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		expect(summer.visitAt.toISOString()).toBe('2026-09-25T18:40:00.000Z');

		// EST in February is UTC-5 -- proves the offset is resolved per-date
		// (across the daylight-saving change) rather than a fixed constant.
		const winter = await visit(owner, 'Follow up', '2026-02-05', '14:40');
		expect(winter.visitAt.toISOString()).toBe('2026-02-05T19:40:00.000Z');
	});

	it('refuses a visit with no date or no time', async () => {
		expect(
			await createMedicalVisit(sql, owner, { reason: 'Follow up', visitTime: '09:00' })
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect(
			await createMedicalVisit(sql, owner, { reason: 'Follow up', visitDate: '2026-09-25' })
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('refuses a negative cost', async () => {
		expect(
			await createMedicalVisit(sql, owner, {
				reason: 'Follow up',
				visitDate: '2026-09-25',
				visitTime: '09:00',
				amount: -5
			})
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('stores requirements as a list and lists visits soonest-first or most-recent-first', async () => {
		const v = ok(
			await createMedicalVisit(sql, owner, {
				reason: 'Follow up',
				visitDate: '2026-09-25',
				visitTime: '09:00',
				requirements: 'Bloodwork, Fasting'
			}),
			'visit'
		).record;
		expect(v.requirements).toEqual(['Bloodwork', 'Fasting']);

		await visit(owner, 'Earlier', '2026-01-01', '09:00');
		expect((await listMedicalVisits(sql, owner, { order: 'asc' })).map((x) => x.reason)).toEqual([
			'Earlier',
			'Follow up'
		]);
		expect((await listMedicalVisits(sql, owner)).map((x) => x.reason)).toEqual([
			'Follow up',
			'Earlier'
		]);
	});

	it('changes only the time on an edit and keeps the existing date', async () => {
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		const edited = ok(
			await updateMedicalVisit(sql, owner, v.id, { visitTime: '09:15' }, v.updatedAt),
			'edit time only'
		).record;
		// Still September 25th, EDT (UTC-4): 09:15 local is 13:15 UTC.
		expect(edited.visitAt.toISOString()).toBe('2026-09-25T13:15:00.000Z');
	});

	it('changes only the date on an edit and keeps the existing time', async () => {
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		const edited = ok(
			await updateMedicalVisit(sql, owner, v.id, { visitDate: '2026-02-05' }, v.updatedAt),
			'edit date only'
		).record;
		// Still 14:40, now EST (UTC-5): 14:40 local is 19:40 UTC.
		expect(edited.visitAt.toISOString()).toBe('2026-02-05T19:40:00.000Z');
	});

	it('refuses a stale edit', async () => {
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		ok(await updateMedicalVisit(sql, owner, v.id, { location: 'Clinic' }, v.updatedAt), 'first');
		expect(
			await updateMedicalVisit(sql, owner, v.id, { location: 'Elsewhere' }, v.updatedAt)
		).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('archives and restores a visit', async () => {
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		ok(await setMedicalVisitArchived(sql, owner, v.id, true), 'archive');
		expect(await listMedicalVisits(sql, owner)).toEqual([]);

		ok(await setMedicalVisitArchived(sql, owner, v.id, false), 'restore');
		expect(await listMedicalVisits(sql, owner)).toHaveLength(1);
	});
});

describe('a visit’s symptoms', () => {
	it('attaches a symptom term and reads it back', async () => {
		const nausea = ok(
			await createHealthTerm(sql, owner, { kind: 'symptom', name: 'Nausea' }),
			'symptom term'
		).record;
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');

		ok(await addVisitSymptom(sql, owner, v.id, nausea.id), 'attach');
		expect((await symptomsForVisit(sql, owner, v.id)).map((s) => s.name)).toEqual(['Nausea']);
	});

	it('is idempotent rather than duplicating the link', async () => {
		const nausea = ok(
			await createHealthTerm(sql, owner, { kind: 'symptom', name: 'Nausea' }),
			'symptom term'
		).record;
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');

		ok(await addVisitSymptom(sql, owner, v.id, nausea.id), 'first');
		ok(await addVisitSymptom(sql, owner, v.id, nausea.id), 'second');
		expect(await symptomsForVisit(sql, owner, v.id)).toHaveLength(1);
	});

	it('refuses a term from a different vocabulary list', async () => {
		// "Restless" is a mood, not a symptom -- attaching it here would put a
		// mood term on a visit's symptom list, which the source never shows.
		const restless = ok(
			await createHealthTerm(sql, owner, { kind: 'mood', name: 'Restless' }),
			'mood term'
		).record;
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');

		expect(await addVisitSymptom(sql, owner, v.id, restless.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('removes a symptom from a visit', async () => {
		const nausea = ok(
			await createHealthTerm(sql, owner, { kind: 'symptom', name: 'Nausea' }),
			'symptom term'
		).record;
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		ok(await addVisitSymptom(sql, owner, v.id, nausea.id), 'attach');

		ok(await removeVisitSymptom(sql, owner, v.id, nausea.id), 'remove');
		expect(await symptomsForVisit(sql, owner, v.id)).toEqual([]);
	});
});

describe('privacy and household isolation', () => {
	it('shares a marker, a result and a visit across the household by default', async () => {
		const m = await marker(owner, 'Testosite level', 10, 50);
		ok(
			await createLabResult(sql, owner, { markerId: m.id, resultDate: '2026-08-01', value: 1 }),
			'result'
		);
		await visit(owner, 'Follow up', '2026-09-25', '14:40');

		expect(await listLabMarkers(sql, partner)).toHaveLength(1);
		expect(await listLabResults(sql, partner, { markerId: m.id })).toHaveLength(1);
		expect(await listMedicalVisits(sql, partner)).toHaveLength(1);
	});

	it('a visit marked private is hidden from the other household member', async () => {
		const result = await createMedicalVisit(sql, owner, {
			reason: 'Follow up',
			visitDate: '2026-09-25',
			visitTime: '14:40',
			ownerUserId: owner.userId,
			visibility: 'private'
		});
		const v = ok(result, 'private visit').record;

		expect(await getMedicalVisit(sql, owner, v.id)).not.toBeNull();
		expect(await getMedicalVisit(sql, partner, v.id)).toBeNull();
		expect(await listMedicalVisits(sql, partner)).toEqual([]);
	});

	it('never crosses a household boundary for any of the three tables', async () => {
		await marker(owner, 'Testosite level', 10, 50);
		await visit(owner, 'Follow up', '2026-09-25', '14:40');
		const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };

		expect(await listLabMarkers(sql, elsewhere)).toEqual([]);
		expect(await listMedicalVisits(sql, elsewhere)).toEqual([]);
	});
});

describe('a visit’s provider, location and pet links', () => {
	const person = async (
		viewer: Viewer,
		name: string,
		kind: 'person' | 'place' | 'pet',
		extra: Record<string, unknown> = {}
	) =>
		ok(await createPerson(sql, viewer, { name, kind, ...extra }), `create ${kind} ${name}`).record;

	it('links a provider, a place and a pet, and reads their names back', async () => {
		const provider = await person(owner, 'Doctor Placeholder', 'person');
		const place = await person(owner, 'Placeholder Clinic', 'place');
		const pet = await person(owner, 'Zorbo', 'pet');
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');

		const linked = ok(
			await updateMedicalVisit(
				sql,
				owner,
				v.id,
				{ providerPersonId: provider.id, locationPlaceId: place.id, petId: pet.id },
				v.updatedAt
			),
			'link provider, place and pet'
		).record;
		expect(linked).toMatchObject({
			providerPersonId: provider.id,
			locationPlaceId: place.id,
			petId: pet.id
		});

		expect(await linkedNamesForVisit(sql, owner, linked)).toEqual({
			providerName: 'Doctor Placeholder',
			locationName: 'Placeholder Clinic',
			petName: 'Zorbo'
		});
	});

	it('refuses linking the wrong kind, as not found', async () => {
		// A place cannot be a provider (base.ts's own worked example).
		const place = await person(owner, 'Placeholder Clinic', 'place');
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');

		expect(
			await updateMedicalVisit(sql, owner, v.id, { providerPersonId: place.id }, v.updatedAt)
		).toMatchObject({ ok: false, reason: 'not_found' });
		expect(await getMedicalVisit(sql, owner, v.id)).toMatchObject({ providerPersonId: null });
	});

	it('refuses linking the other member’s private person, as not found', async () => {
		const theirs = await person(partner, 'Their Contact', 'person', {
			ownerUserId: partner.userId,
			visibility: 'private'
		});
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');

		expect(
			await updateMedicalVisit(sql, owner, v.id, { providerPersonId: theirs.id }, v.updatedAt)
		).toMatchObject({ ok: false, reason: 'not_found' });
	});

	it('refuses linking an archived person', async () => {
		const provider = await person(owner, 'Doctor Placeholder', 'person');
		ok(await setPersonArchived(sql, owner, provider.id, true), 'archive');
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');

		expect(
			await updateMedicalVisit(sql, owner, v.id, { providerPersonId: provider.id }, v.updatedAt)
		).toMatchObject({ ok: false, reason: 'not_found' });
	});

	it('leaves the visit’s imported text intact when the linked person is later deleted', async () => {
		const provider = await person(owner, 'Doctor Placeholder', 'person');
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		const linked = ok(
			await updateMedicalVisit(
				sql,
				owner,
				v.id,
				{ providerPersonId: provider.id, provider: 'Imported Provider Text' },
				v.updatedAt
			),
			'link and set text'
		).record;
		expect(linked).toMatchObject({
			providerPersonId: provider.id,
			provider: 'Imported Provider Text'
		});

		// Deleting a person outright is not exposed anywhere in the repository
		// layer (archiving is) -- this reaches into the table directly, because
		// the question here is what the FK's `on delete set null` does, not
		// application behaviour.
		await sql`delete from people where id = ${provider.id}::uuid`;

		expect(await getMedicalVisit(sql, owner, v.id)).toMatchObject({
			providerPersonId: null,
			provider: 'Imported Provider Text'
		});
	});

	it('never rewrites the imported free text when linking, or the link when editing text', async () => {
		const provider = await person(owner, 'Doctor Placeholder', 'person');
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		const imported = ok(
			await updateMedicalVisit(
				sql,
				owner,
				v.id,
				{ provider: 'Imported Provider Text' },
				v.updatedAt
			),
			'set imported text'
		).record;

		const linked = ok(
			await updateMedicalVisit(
				sql,
				owner,
				v.id,
				{ providerPersonId: provider.id },
				imported.updatedAt
			),
			'link provider'
		).record;
		expect(linked).toMatchObject({
			provider: 'Imported Provider Text',
			providerPersonId: provider.id
		});

		const edited = ok(
			await updateMedicalVisit(
				sql,
				owner,
				v.id,
				{ provider: 'Edited Provider Text' },
				linked.updatedAt
			),
			'edit text only'
		).record;
		expect(edited).toMatchObject({
			provider: 'Edited Provider Text',
			providerPersonId: provider.id
		});
	});

	it('clears a link by saving an empty value, leaving the text untouched', async () => {
		const provider = await person(owner, 'Doctor Placeholder', 'person');
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		const linked = ok(
			await updateMedicalVisit(
				sql,
				owner,
				v.id,
				{ providerPersonId: provider.id, provider: 'Imported Provider Text' },
				v.updatedAt
			),
			'link'
		).record;

		const cleared = ok(
			await updateMedicalVisit(sql, owner, v.id, { providerPersonId: '' }, linked.updatedAt),
			'clear link'
		).record;
		expect(cleared).toMatchObject({ providerPersonId: null, provider: 'Imported Provider Text' });
	});

	it('leaves an unmentioned link untouched when another field is edited', async () => {
		const provider = await person(owner, 'Doctor Placeholder', 'person');
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		const linked = ok(
			await updateMedicalVisit(sql, owner, v.id, { providerPersonId: provider.id }, v.updatedAt),
			'link'
		).record;

		const edited = ok(
			await updateMedicalVisit(sql, owner, v.id, { notes: 'Unrelated note.' }, linked.updatedAt),
			'edit unrelated field'
		).record;
		expect(edited.providerPersonId).toBe(provider.id);
	});

	it('shows a name only while the linked person stays readable', async () => {
		// A person's own visibility can change after a visit links to them --
		// linkedNamesForVisit re-checks readability on every read rather than
		// trusting the id, the same rule readableScope enforces everywhere else.
		const provider = await person(owner, 'Doctor Placeholder', 'person');
		const v = await visit(owner, 'Follow up', '2026-09-25', '14:40');
		const linked = ok(
			await updateMedicalVisit(sql, owner, v.id, { providerPersonId: provider.id }, v.updatedAt),
			'link'
		).record;
		expect((await linkedNamesForVisit(sql, partner, linked)).providerName).toBe(
			'Doctor Placeholder'
		);

		await sql`update people set owner_user_id = ${owner.userId}::uuid, visibility = 'private' where id = ${provider.id}::uuid`;
		expect((await linkedNamesForVisit(sql, partner, linked)).providerName).toBeNull();
		expect((await linkedNamesForVisit(sql, owner, linked)).providerName).toBe('Doctor Placeholder');
	});
});

describe('through a client configured the way the app’s is', () => {
	it('links a visit’s provider through the drizzle-wrapped client', async () => {
		// `$lib/server/db` hands its client to drizzle(), which replaces the
		// driver's timestamp serializers with pass-throughs -- a JS Date sent as
		// a parameter reaches the wire unconverted and throws (see the identical
		// test in health-measurements.test.ts for how this failed in
		// production). Every timestamp this module sends is already
		// `${iso}::timestamptz`, but `resolveVisitLink` and the transaction
		// `updateMedicalVisit` now opens are new code, so this proves the same
		// discipline holds for the links too, not just the plain fields.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const provider = ok(
				await createPerson(appLike, owner, { name: 'Doctor Placeholder', kind: 'person' }),
				'create person through the app-like client'
			).record;
			const v = ok(
				await createMedicalVisit(appLike, owner, {
					reason: 'Follow up',
					visitDate: '2026-09-25',
					visitTime: '14:40'
				}),
				'create visit through the app-like client'
			).record;
			const linked = ok(
				await updateMedicalVisit(
					appLike,
					owner,
					v.id,
					{ providerPersonId: provider.id },
					v.updatedAt
				),
				'link provider through the app-like client'
			).record;
			expect(linked.providerPersonId).toBe(provider.id);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
