import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	addDays,
	createDocument,
	createPerson,
	deleteRenewal,
	documentsNeedingAttention,
	getDocument,
	householdToday,
	listDocumentRenewals,
	listDocuments,
	renewDocument,
	search,
	setDocumentArchived,
	updateDocument
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Life Admin HQ (migration 0036): documents and their renewal log.
 *
 * All titles, references and dates below are invented for this test file --
 * nothing here is read from the household's own data (rule: never read or
 * copy from `data/`).
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
const failed = <T extends { ok: boolean }>(result: T, what: string) => {
	if (result.ok) throw new Error(`expected to fail to ${what}, but it succeeded`);
	return result as Extract<T, { ok: false }>;
};

describe('documents', () => {
	it('creates one with every field, and edits every field', async () => {
		const person = ok(
			await createPerson(sql, owner, { name: 'Fictional Holder' }),
			'create a holder'
		).record;
		const created = ok(
			await createDocument(sql, owner, {
				title: 'Fictional Passport',
				kind: 'id',
				holderPersonId: person.id,
				issuer: 'Fictional Passport Office',
				reference: '0000',
				issuedOn: '2020-01-01',
				expiresOn: '2030-01-01',
				renewLeadDays: 60,
				location: 'Fire safe',
				url: 'https://example.com/fictional-passport',
				notes: 'Keep in the fire safe.'
			}),
			'create'
		).record;
		expect(created).toMatchObject({
			title: 'Fictional Passport',
			kind: 'id',
			holderPersonId: person.id,
			holderName: 'Fictional Holder',
			issuer: 'Fictional Passport Office',
			reference: '0000',
			issuedOn: '2020-01-01',
			expiresOn: '2030-01-01',
			renewLeadDays: 60,
			location: 'Fire safe',
			url: 'https://example.com/fictional-passport',
			notes: 'Keep in the fire safe.',
			visibility: 'private',
			ownerUserId: owner.userId
		});

		const edited = ok(
			await updateDocument(
				sql,
				owner,
				created.id,
				{
					title: 'Fictional Passport Renewed Edition',
					issuer: 'Fictional Passport Office (Renewed)',
					location: 'Safety deposit box',
					visibility: 'household'
				},
				created.updatedAt
			),
			'edit some fields'
		).record;
		expect(edited).toMatchObject({
			title: 'Fictional Passport Renewed Edition',
			issuer: 'Fictional Passport Office (Renewed)',
			location: 'Safety deposit box',
			visibility: 'household',
			// Unmentioned fields keep their value -- `patched`'s "not mentioned"
			// case.
			reference: '0000',
			holderName: 'Fictional Holder',
			expiresOn: '2030-01-01'
		});
	});

	it('defaults to private, owned by its creator, other fields left absent', async () => {
		const created = ok(
			await createDocument(sql, owner, { title: 'Fictional Birth Certificate' }),
			'create'
		).record;
		expect(created).toMatchObject({
			visibility: 'private',
			ownerUserId: owner.userId,
			kind: 'other',
			holderPersonId: null,
			holderName: null,
			expiresOn: null,
			renewLeadDays: 30,
			reference: null
		});
		// Private to its creator: the other member cannot even see it exists.
		expect(await getDocument(sql, partner, created.id)).toBeNull();
	});

	it('refuses a blank title, an out-of-range kind, and a renewal notice over a year, each with a field message, not a 500', async () => {
		failed(await createDocument(sql, owner, { title: '   ' }), 'go blank');
		failed(
			await createDocument(sql, owner, { title: 'Fictional Thing', kind: 'passport' }),
			'invent a kind'
		);
		failed(
			await createDocument(sql, owner, { title: 'Fictional Thing', renewLeadDays: 400 }),
			'ask for over a year of notice'
		);
	});

	it('conflicts on a stale edit, and 404s rather than 403s for a private document', async () => {
		const created = ok(
			await createDocument(sql, owner, { title: 'Fictional Private Document' }),
			'create'
		).record;

		const stale = await updateDocument(
			sql,
			owner,
			created.id,
			{ issuer: 'Someone else' },
			'2020-01-01T00:00:00.000Z'
		);
		expect(failed(stale, 'save with a stale version').reason).toBe('conflict');

		// Saying "forbidden" would itself disclose that a private document
		// exists -- see base.ts's own header on why not_found covers both cases.
		expect(await getDocument(sql, partner, created.id)).toBeNull();
		const asPartner = failed(
			await updateDocument(sql, partner, created.id, { issuer: 'x' }),
			'edit it'
		);
		expect(asPartner.reason).toBe('not_found');
	});

	it('archives and restores', async () => {
		const created = ok(
			await createDocument(sql, owner, {
				title: 'Fictional Gym Membership',
				kind: 'membership',
				visibility: 'household'
			}),
			'create'
		).record;

		const archived = ok(await setDocumentArchived(sql, owner, created.id, true), 'archive').record;
		expect(archived.archivedAt).not.toBeNull();
		expect(await listDocuments(sql, owner)).toEqual([]);

		const restored = ok(await setDocumentArchived(sql, owner, created.id, false), 'restore').record;
		expect(restored.archivedAt).toBeNull();
	});

	describe('the holder', () => {
		it('accepts a person or a pet, refuses a place, and refuses one the writer cannot read -- on create and on edit', async () => {
			const person = ok(
				await createPerson(sql, owner, { name: 'Fictional Holder' }),
				'person'
			).record;
			const pet = ok(
				await createPerson(sql, owner, { name: 'Fictional Pet', kind: 'pet' }),
				'pet'
			).record;
			const place = ok(
				await createPerson(sql, owner, { name: 'Fictional Place', kind: 'place' }),
				'place'
			).record;

			const withPerson = ok(
				await createDocument(sql, owner, { title: 'Fictional ID', holderPersonId: person.id }),
				'with a person'
			).record;
			expect(withPerson.holderName).toBe('Fictional Holder');

			const withPet = ok(
				await createDocument(sql, owner, {
					title: 'Fictional Pet Licence',
					kind: 'licence',
					holderPersonId: pet.id
				}),
				'with a pet'
			).record;
			expect(withPet.holderName).toBe('Fictional Pet');

			const withPlace = failed(
				await createDocument(sql, owner, { title: 'Fictional Thing', holderPersonId: place.id }),
				'with a place'
			);
			expect(withPlace.reason).toBe('not_found');

			const theirSecret = ok(
				await createPerson(sql, partner, {
					name: 'Partners Secret',
					visibility: 'private',
					ownerUserId: partner.userId
				}),
				"the partner's own private person"
			).record;
			const unreadable = failed(
				await createDocument(sql, owner, {
					title: 'Fictional Thing',
					holderPersonId: theirSecret.id
				}),
				'with a holder the writer cannot read'
			);
			expect(unreadable.reason).toBe('not_found');

			// The identical refusal on an edit, not only on create -- and the
			// refusal must leave the existing holder exactly as it was.
			const changeRefused = failed(
				await updateDocument(
					sql,
					owner,
					withPerson.id,
					{ holderPersonId: theirSecret.id },
					withPerson.updatedAt
				),
				'change the holder to one the writer cannot read'
			);
			expect(changeRefused.reason).toBe('not_found');
			expect((await getDocument(sql, owner, withPerson.id))?.holderPersonId).toBe(person.id);
		});

		it('clears the holder when asked, and leaves it alone when the field is not mentioned', async () => {
			const person = ok(
				await createPerson(sql, owner, { name: 'Fictional Holder' }),
				'person'
			).record;
			const created = ok(
				await createDocument(sql, owner, { title: 'Fictional ID', holderPersonId: person.id }),
				'create'
			).record;

			const untouched = ok(
				await updateDocument(sql, owner, created.id, { issuer: 'Someone' }, created.updatedAt),
				'edit without mentioning the holder'
			).record;
			expect(untouched.holderPersonId).toBe(person.id);

			const cleared = ok(
				await updateDocument(sql, owner, created.id, { holderPersonId: null }, untouched.updatedAt),
				'clear the holder'
			).record;
			expect(cleared.holderPersonId).toBeNull();
			expect(cleared.holderName).toBeNull();
		});
	});

	describe('privacy', () => {
		it('never lists, gets, or surfaces another member’s private document on the attention list', async () => {
			const today = await householdToday(sql, owner.householdId);
			const theirs = ok(
				await createDocument(sql, partner, {
					title: 'Partners Private Passport',
					visibility: 'private',
					ownerUserId: partner.userId,
					expiresOn: addDays(today, -1)
				}),
				'create'
			).record;

			expect(owner.role).toBe('admin');
			expect(await getDocument(sql, owner, theirs.id)).toBeNull();
			expect(await listDocuments(sql, owner)).toEqual([]);
			expect(await documentsNeedingAttention(sql, owner)).toEqual([]);

			expect(await listDocuments(sql, partner)).toHaveLength(1);
			expect(await documentsNeedingAttention(sql, partner)).toHaveLength(1);
		});

		it('lists and shows a household-shared document to both members, but only its owner may write it', async () => {
			const theirs = ok(
				await createDocument(sql, partner, {
					title: 'Shared But Theirs',
					visibility: 'household',
					ownerUserId: partner.userId
				}),
				'create'
			).record;

			expect((await listDocuments(sql, owner)).map((d) => d.title)).toEqual(['Shared But Theirs']);
			expect(await getDocument(sql, owner, theirs.id)).not.toBeNull();

			// Readable (it is right there in the owner's own list), but not
			// writable: `writeScoped` reports that distinction as `forbidden`,
			// unlike a genuinely private record -- see base.ts's own header on
			// why `not_found` is reserved for "cannot even see it".
			const blocked = failed(
				await updateDocument(sql, owner, theirs.id, { issuer: 'x' }),
				"edit the partner's shared document"
			);
			expect(blocked.reason).toBe('forbidden');
		});

		it('never crosses a household boundary', async () => {
			const created = ok(await createDocument(sql, owner, { title: 'Ours' }), 'create').record;
			// A fake, non-existent household id proves isolation for the two
			// reads below, but `documentsNeedingAttention` also reads the
			// household row itself (for its own clock) and a household that
			// does not exist at all is not a shape any page load reaches in
			// practice -- every load already resolves a real one first. That
			// boundary is exercised instead, for real, by the partner's own
			// household-shared-but-private-to-them cases above.
			const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };
			expect(await listDocuments(sql, elsewhere)).toEqual([]);
			expect(await getDocument(sql, elsewhere, created.id)).toBeNull();
		});
	});

	describe('the reference', () => {
		it('is on the document’s own page, but never in a list, the attention list, or a search result', async () => {
			const created = ok(
				await createDocument(sql, owner, {
					title: 'Fictional Secret-Numbered Passport',
					reference: 'UNIQUEREF1234'
				}),
				'create'
			).record;

			const [listed] = await listDocuments(sql, owner);
			expect(listed).not.toHaveProperty('reference');

			expect(await search(sql, owner, 'UNIQUEREF1234')).toEqual([]);
			// The title still finds it, proving search genuinely ran rather than
			// returning nothing for every term.
			expect((await search(sql, owner, 'Secret-Numbered')).map((h) => h.title)).toContain(
				'Fictional Secret-Numbered Passport'
			);

			const fetched = await getDocument(sql, owner, created.id);
			expect(fetched?.reference).toBe('UNIQUEREF1234');
		});

		it('is never in the attention list either', async () => {
			const today = await householdToday(sql, owner.householdId);
			ok(
				await createDocument(sql, owner, {
					title: 'Fictional Due Soon',
					reference: 'ANOTHERREF5678',
					expiresOn: addDays(today, 1)
				}),
				'create'
			);
			const [attention] = await documentsNeedingAttention(sql, owner);
			expect(attention).not.toHaveProperty('reference');
		});
	});

	describe('attention', () => {
		it('lists expired and due documents soonest first, and excludes ok and no-expiry ones', async () => {
			const today = await householdToday(sql, owner.householdId);
			ok(
				await createDocument(sql, owner, {
					title: 'Fictional Expired Warranty',
					kind: 'warranty',
					expiresOn: addDays(today, -5)
				}),
				'expired'
			);
			ok(
				await createDocument(sql, owner, {
					title: 'Fictional Due Soon Licence',
					kind: 'licence',
					expiresOn: addDays(today, 5),
					renewLeadDays: 10
				}),
				'due soon'
			);
			ok(
				await createDocument(sql, owner, {
					title: 'Fictional Due Later Membership',
					kind: 'membership',
					expiresOn: addDays(today, 9),
					renewLeadDays: 10
				}),
				'due later'
			);
			ok(
				await createDocument(sql, owner, {
					title: 'Fictional Fine For Now',
					kind: 'insurance',
					expiresOn: addDays(today, 100),
					renewLeadDays: 10
				}),
				'ok'
			);
			ok(
				await createDocument(sql, owner, { title: 'Fictional Never Expires', kind: 'certificate' }),
				'no expiry'
			);

			const attention = await documentsNeedingAttention(sql, owner);
			expect(attention.map((d) => d.title)).toEqual([
				'Fictional Expired Warranty',
				'Fictional Due Soon Licence',
				'Fictional Due Later Membership'
			]);
			expect(attention.map((d) => d.state)).toEqual(['expired', 'due', 'due']);

			const filtered = (await listDocuments(sql, owner, { attention: true })).map((d) => d.title);
			expect(filtered.sort()).toEqual(
				[
					'Fictional Due Later Membership',
					'Fictional Due Soon Licence',
					'Fictional Expired Warranty'
				].sort()
			);
		});

		it('filters the full list by kind and by holder', async () => {
			const person = ok(
				await createPerson(sql, owner, { name: 'Fictional Holder' }),
				'person'
			).record;
			ok(
				await createDocument(sql, owner, {
					title: 'Fictional Passport',
					kind: 'id',
					holderPersonId: person.id
				}),
				'a'
			);
			ok(
				await createDocument(sql, owner, { title: 'Fictional Insurance', kind: 'insurance' }),
				'b'
			);

			expect((await listDocuments(sql, owner, { kind: 'id' })).map((d) => d.title)).toEqual([
				'Fictional Passport'
			]);
			expect((await listDocuments(sql, owner, { holder: person.id })).map((d) => d.title)).toEqual([
				'Fictional Passport'
			]);
		});
	});

	describe('renewals', () => {
		it('logs the renewal with the previous expiry and moves expires_on, defaulting renewedOn to today', async () => {
			const created = ok(
				await createDocument(sql, owner, {
					title: 'Fictional Licence',
					kind: 'licence',
					expiresOn: '2026-01-01'
				}),
				'create'
			).record;
			const today = await householdToday(sql, owner.householdId);

			const renewed = ok(
				await renewDocument(sql, owner, created.id, {
					newExpiresOn: '2030-01-01',
					note: 'Renewed online'
				}),
				'renew'
			).record;
			expect(renewed.document.expiresOn).toBe('2030-01-01');
			expect(renewed.renewal).toMatchObject({
				documentId: created.id,
				renewedOn: today,
				previousExpiresOn: '2026-01-01',
				newExpiresOn: '2030-01-01',
				note: 'Renewed online'
			});

			const history = await listDocumentRenewals(sql, owner, created.id);
			expect(history.map((r) => r.id)).toEqual([renewed.renewal.id]);
		});

		it('accepts an explicit renewedOn, not only today', async () => {
			const created = ok(
				await createDocument(sql, owner, { title: 'Fictional Licence', expiresOn: '2026-01-01' }),
				'create'
			).record;
			const renewed = ok(
				await renewDocument(sql, owner, created.id, {
					newExpiresOn: '2030-01-01',
					renewedOn: '2025-12-15'
				}),
				'renew'
			).record;
			expect(renewed.renewal.renewedOn).toBe('2025-12-15');
		});

		it('refuses a new expiry that is not after today, leaving the document and its history untouched', async () => {
			const created = ok(
				await createDocument(sql, owner, { title: 'Fictional Licence', expiresOn: '2026-01-01' }),
				'create'
			).record;
			const today = await householdToday(sql, owner.householdId);

			ok(
				await renewDocument(sql, owner, created.id, { newExpiresOn: '2030-01-01' }),
				'the one valid renewal'
			);

			const onToday = failed(
				await renewDocument(sql, owner, created.id, { newExpiresOn: today }),
				'renew onto today itself'
			);
			expect(onToday.reason).toBe('invalid');
			const intoThePast = failed(
				await renewDocument(sql, owner, created.id, { newExpiresOn: '2020-01-01' }),
				'renew into the past'
			);
			expect(intoThePast.reason).toBe('invalid');

			// Neither refused attempt left a trace: a write (the first renewal)
			// happened, and each later refusal rolled back whole rather than
			// leaving an orphaned log entry or a half-moved expiry behind -- see
			// documents.ts's own DocumentWriteRefused for the mechanism.
			expect(await listDocumentRenewals(sql, owner, created.id)).toHaveLength(1);
			expect((await getDocument(sql, owner, created.id))?.expiresOn).toBe('2030-01-01');
		});

		it('cannot renew a document the writer cannot write', async () => {
			const theirs = ok(
				await createDocument(sql, partner, {
					title: 'Fictional Theirs',
					visibility: 'household',
					ownerUserId: partner.userId,
					expiresOn: '2026-01-01'
				}),
				'create'
			).record;
			const result = failed(
				await renewDocument(sql, owner, theirs.id, { newExpiresOn: '2030-01-01' }),
				'renew as the other member'
			);
			expect(result.reason).toBe('not_found');
			expect(await listDocumentRenewals(sql, owner, theirs.id)).toEqual([]);
		});

		it('undoes only the most recently entered renewal, restoring the expiry it replaced', async () => {
			const created = ok(
				await createDocument(sql, owner, { title: 'Fictional Licence', expiresOn: '2026-01-01' }),
				'create'
			).record;
			const first = ok(
				await renewDocument(sql, owner, created.id, { newExpiresOn: '2027-01-01' }),
				'first renewal'
			).record;
			const second = ok(
				await renewDocument(sql, owner, created.id, { newExpiresOn: '2028-01-01' }),
				'second renewal'
			).record;

			const refused = failed(
				await deleteRenewal(sql, owner, created.id, first.renewal.id),
				'undo the older renewal'
			);
			expect(refused.reason).toBe('invalid');

			const undone = ok(
				await deleteRenewal(sql, owner, created.id, second.renewal.id),
				'undo the newest renewal'
			).record;
			expect(undone.expiresOn).toBe('2027-01-01');
			expect((await listDocumentRenewals(sql, owner, created.id)).map((r) => r.id)).toEqual([
				first.renewal.id
			]);
		});

		it('undoes the renewal entered last, even when it was backdated before an earlier entry', async () => {
			const created = ok(
				await createDocument(sql, owner, { title: 'Fictional Licence', expiresOn: '2026-01-01' }),
				'create'
			).record;
			const entered = ok(
				await renewDocument(sql, owner, created.id, {
					newExpiresOn: '2027-06-01',
					renewedOn: '2026-01-01'
				}),
				'the renewal entered first'
			).record;
			ok(
				await renewDocument(sql, owner, created.id, {
					newExpiresOn: '2027-01-01',
					renewedOn: '2025-12-01'
				}),
				'a backdated renewal, entered second'
			);

			const refused = failed(
				await deleteRenewal(sql, owner, created.id, entered.renewal.id),
				'undo the renewal entered first'
			);
			expect(refused.reason).toBe('invalid');
		});

		it('cannot undo a renewal on a document the writer cannot write', async () => {
			const theirs = ok(
				await createDocument(sql, partner, {
					title: 'Fictional Theirs',
					visibility: 'household',
					ownerUserId: partner.userId,
					expiresOn: '2026-01-01'
				}),
				'create'
			).record;
			const renewed = ok(
				await renewDocument(sql, partner, theirs.id, { newExpiresOn: '2030-01-01' }),
				'renew as its owner'
			).record;

			const result = failed(
				await deleteRenewal(sql, owner, theirs.id, renewed.renewal.id),
				'undo as the other member'
			);
			expect(result.reason).toBe('not_found');
			expect(await listDocumentRenewals(sql, partner, theirs.id)).toHaveLength(1);
		});
	});

	describe('through a client configured the way the app’s is', () => {
		// `$lib/server/db` hands its client to drizzle(), which replaces the
		// driver's timestamp serializers with pass-throughs: a JS Date sent as a
		// parameter then reaches the wire unconverted and throws, where a plain
		// test client (the `sql` used everywhere above) would silently convert
		// it. See health-measurements.test.ts's identical section for how "Add a
		// reading" once passed every test here while failing in production.
		it('creates, edits and archives a document', async () => {
			const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
			drizzle(appLike);
			try {
				const created = ok(
					await createDocument(appLike, owner, {
						title: 'Fictional Drizzle Passport',
						kind: 'id',
						expiresOn: '2030-01-01'
					}),
					'create through the app-like client'
				).record;
				const edited = ok(
					await updateDocument(
						appLike,
						owner,
						created.id,
						{ issuer: 'Fictional Office' },
						created.updatedAt
					),
					'edit through the app-like client'
				).record;
				expect(edited.issuer).toBe('Fictional Office');
				const archived = ok(
					await setDocumentArchived(appLike, owner, created.id, true),
					'archive through the app-like client'
				).record;
				expect(archived.archivedAt).not.toBeNull();
			} finally {
				await appLike.end({ timeout: 5 });
			}
		});

		it('renews a document and undoes the renewal', async () => {
			const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
			drizzle(appLike);
			try {
				const created = ok(
					await createDocument(appLike, owner, {
						title: 'Fictional Drizzle Licence',
						expiresOn: '2026-01-01'
					}),
					'create through the app-like client'
				).record;
				const renewed = ok(
					await renewDocument(appLike, owner, created.id, { newExpiresOn: '2030-01-01' }),
					'renew through the app-like client'
				).record;
				expect(renewed.document.expiresOn).toBe('2030-01-01');
				const undone = ok(
					await deleteRenewal(appLike, owner, created.id, renewed.renewal.id),
					'undo through the app-like client'
				).record;
				expect(undone.expiresOn).toBe('2026-01-01');
			} finally {
				await appLike.end({ timeout: 5 });
			}
		});
	});
});
