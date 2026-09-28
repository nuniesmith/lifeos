import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createImportantDate,
	createPerson,
	createWishlistItem,
	getPerson,
	listImportantDates,
	listPeople,
	setPersonArchived,
	setWishlistItemStatus,
	updateImportantDate,
	updatePerson,
	updateWishlistItem
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * A person's own page (PACK1-002; migration 0024): contact details, a person
 * link on important dates, and editing a wishlist item's own fields.
 *
 * The two things worth being paranoid about are both about the SAME
 * household's other member, not an outsider — household isolation for
 * `people` is already proven in collections.test.ts, and cross-household
 * cases here would prove nothing new. What is new here is narrower: can the
 * partner read a private person's contact details (no), and can either of
 * them attach a date or a gift to a person they cannot see (no, silently,
 * rather than a raw foreign-key error).
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

describe('contact details', () => {
	it('are readable through getPerson but never through listPeople', async () => {
		const created = ok(
			await createPerson(sql, owner, {
				name: 'Alex Fixtureton',
				email: 'alex.fixtureton@example.com',
				phone: '+1-555-0182',
				address: '42 Example Lane, Testville'
			}),
			'create a person with contacts'
		).record;

		const detail = await getPerson(sql, owner, created.id);
		expect(detail).toMatchObject({
			email: 'alex.fixtureton@example.com',
			phone: '+1-555-0182',
			address: '42 Example Lane, Testville'
		});

		// The list shape structurally cannot carry them: the query behind
		// listPeople does not select the columns, so there is nothing for a
		// card or a search result to accidentally render.
		const [listed] = await listPeople(sql, owner, { search: 'Alex Fixtureton' });
		expect(listed).not.toHaveProperty('email');
		expect(listed).not.toHaveProperty('phone');
		expect(listed).not.toHaveProperty('address');
	});

	it('lets an edit change one contact field and leave the others alone', async () => {
		const created = ok(
			await createPerson(sql, owner, {
				name: 'Alex Fixtureton',
				email: 'alex.fixtureton@example.com'
			}),
			'create'
		).record;

		const edited = ok(
			await updatePerson(sql, owner, created.id, { phone: '+1-555-0182' }, created.updatedAt),
			'add a phone'
		).record;
		expect(edited).toMatchObject({ email: 'alex.fixtureton@example.com', phone: '+1-555-0182' });

		// Sending a field back empty clears it — the same "blank means cleared"
		// rule every optional text field in this layer follows.
		const cleared = ok(
			await updatePerson(sql, owner, created.id, { phone: '' }, edited.updatedAt),
			'clear the phone'
		).record;
		expect(cleared).toMatchObject({ email: 'alex.fixtureton@example.com', phone: null });
	});

	it('the partner cannot read a private person’s contact details, and gets nothing for their page', async () => {
		const created = ok(
			await createPerson(sql, owner, {
				name: 'Private Testperson',
				email: 'private.testperson@example.com',
				visibility: 'private',
				ownerUserId: owner.userId
			}),
			'create a private person'
		).record;

		// What the [id] page's load function does: null here is a 404, not a
		// page that renders with the contacts blanked out.
		expect(await getPerson(sql, partner, created.id)).toBeNull();
		expect(await listPeople(sql, partner)).toEqual([]);

		// Nor can the partner change it — not "forbidden", "not found": the
		// row is invisible to them, so the reason must not say more than that.
		expect(
			await updatePerson(sql, partner, created.id, { phone: '+1-555-0199' }, created.updatedAt)
		).toMatchObject({ ok: false, reason: 'not_found' });
	});
});

describe('archiving a person', () => {
	it('leaves the live list and comes back', async () => {
		const created = ok(
			await createPerson(sql, owner, { name: 'Alex Fixtureton' }),
			'create'
		).record;

		const archived = ok(await setPersonArchived(sql, owner, created.id, true), 'archive').record;
		expect(archived.archivedAt).toBeInstanceOf(Date);
		// archived_at moving is what a version check depends on; base.ts's
		// generic archiveScoped gets this from a trigger `people` has never
		// had, which is exactly why setPersonArchived sets it by hand instead.
		expect(archived.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
		expect(await listPeople(sql, owner)).toEqual([]);
		expect(await listPeople(sql, owner, { includeArchived: true })).toHaveLength(1);

		const restored = ok(await setPersonArchived(sql, owner, created.id, false), 'restore').record;
		expect(restored.archivedAt).toBeNull();
		expect(await listPeople(sql, owner)).toHaveLength(1);
	});

	it('refuses the partner, who may read but not write a household-visible person owned by someone else', async () => {
		const created = ok(
			await createPerson(sql, owner, {
				name: 'Alex Fixtureton',
				ownerUserId: owner.userId,
				visibility: 'household'
			}),
			'create'
		).record;

		expect(await getPerson(sql, partner, created.id)).not.toBeNull();
		expect(await setPersonArchived(sql, partner, created.id, true)).toMatchObject({
			ok: false,
			reason: 'forbidden'
		});
	});
});

describe('important dates linked to a person', () => {
	it('attaches on create and lists by person', async () => {
		const jordan = ok(await createPerson(sql, owner, { name: 'Alex Fixtureton' }), 'create').record;

		const date = ok(
			await createImportantDate(sql, owner, {
				title: 'Sample Birthday',
				onDate: '2026-03-04',
				recurrence: 'yearly',
				personId: jordan.id
			}),
			'create a date for them'
		).record;
		expect(date.personId).toBe(jordan.id);

		const forPerson = await listImportantDates(sql, owner, { personId: jordan.id });
		expect(forPerson.map((d) => d.title)).toEqual(['Sample Birthday']);
	});

	it('drops a person id the viewer cannot read, on create and on update alike', async () => {
		// Owned and private: only the owner may read this record at all.
		const secret = ok(
			await createPerson(sql, owner, {
				name: 'Private Testperson',
				visibility: 'private',
				ownerUserId: owner.userId
			}),
			'create a private person'
		).record;

		// On create: the partner's own date (unowned defaults would also pass;
		// this is the partner's to write regardless), pointed at a person only
		// the owner can see. Checked in the same statement that writes it, not
		// a lookup beforehand that a race could get past.
		const created = ok(
			await createImportantDate(sql, partner, {
				title: 'Second Occasion',
				onDate: '2026-05-01',
				personId: secret.id
			}),
			'create a date the partner cannot attach'
		).record;
		expect(created.personId).toBeNull();

		// On update: the very same attempt, checked again by the write itself
		// rather than assumed to still hold from create time.
		const updated = ok(
			await updateImportantDate(
				sql,
				partner,
				created.id,
				{ personId: secret.id },
				created.updatedAt
			),
			'edit it, still pointed at a person the partner cannot see'
		).record;
		expect(updated.personId).toBeNull();
	});

	it('an edit that never mentions personId leaves the existing link alone', async () => {
		const jordan = ok(await createPerson(sql, owner, { name: 'Alex Fixtureton' }), 'create').record;
		const date = ok(
			await createImportantDate(sql, owner, {
				title: 'Sample Birthday',
				onDate: '2026-03-04',
				personId: jordan.id
			}),
			'create'
		).record;

		const edited = ok(
			await updateImportantDate(
				sql,
				owner,
				date.id,
				{ title: 'Sample Birthday, renamed' },
				date.updatedAt
			),
			'rename it'
		).record;
		expect(edited.personId).toBe(jordan.id);
	});
});

describe('editing a wishlist item', () => {
	it('changes fields and re-reads the recipient through the join', async () => {
		const jordan = ok(await createPerson(sql, owner, { name: 'Alex Fixtureton' }), 'create').record;
		const gift = ok(
			await createWishlistItem(sql, owner, { name: 'Sample Gift Item' }),
			'create a gift'
		).record;

		const edited = ok(
			await updateWishlistItem(
				sql,
				owner,
				gift.id,
				{ priceRange: '$$', occasion: 'Birthday', forPersonId: jordan.id },
				gift.updatedAt
			),
			'edit it'
		).record;
		expect(edited).toMatchObject({
			priceRange: '$$',
			occasion: 'Birthday',
			forPersonId: jordan.id,
			forPersonName: 'Alex Fixtureton'
		});
	});

	it('drops a recipient the partner cannot read rather than attaching it', async () => {
		const secret = ok(
			await createPerson(sql, owner, {
				name: 'Private Testperson',
				visibility: 'private',
				ownerUserId: owner.userId
			}),
			'create a private person'
		).record;
		const gift = ok(
			await createWishlistItem(sql, partner, { name: 'Second Gift Item' }),
			'create a gift as the partner'
		).record;

		const edited = ok(
			await updateWishlistItem(sql, partner, gift.id, { forPersonId: secret.id }, gift.updatedAt),
			'attempt to attach the private person'
		).record;
		expect(edited.forPersonId).toBeNull();
	});

	it('marks an item bought using the status CHECK’s own values, and back to wanted', async () => {
		const gift = ok(
			await createWishlistItem(sql, owner, { name: 'Sample Gift Item' }),
			'create'
		).record;
		expect(gift.status).toBe('wanted');

		const bought = ok(
			await setWishlistItemStatus(sql, owner, gift.id, 'bought'),
			'mark bought'
		).record;
		expect(bought.status).toBe('bought');

		const given = ok(
			await setWishlistItemStatus(sql, owner, gift.id, 'given'),
			'mark given'
		).record;
		expect(given.status).toBe('given');

		const backToWanted = ok(
			await setWishlistItemStatus(sql, owner, gift.id, 'wanted'),
			'move back to wanted'
		).record;
		expect(backToWanted.status).toBe('wanted');

		// The table's own CHECK, not just this module's `oneOf`.
		expect(await setWishlistItemStatus(sql, owner, gift.id, 'archived')).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});
});

describe('through a client configured the way the app’s is', () => {
	it('edits a person, edits a wishlist item, and links a date to a person', async () => {
		// `$lib/server/db` hands its client to drizzle(), which replaces the
		// driver's timestamp serializers with pass-throughs: a JS Date sent as
		// a parameter then reaches the wire unconverted and throws. Every write
		// path added for this page sends `expectedUpdatedAt` as a version
		// precondition (base.ts's `versionPrecondition`, always as an ISO
		// string, never a bare Date) — this proves that holds through the
		// client configured the way the app's actually is, not the plain one
		// the rest of this file uses.
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const person = ok(
				await createPerson(appLike, owner, { name: 'Alex Fixtureton' }),
				'create a person through the app-like client'
			).record;
			const editedPerson = ok(
				await updatePerson(appLike, owner, person.id, { phone: '+1-555-0182' }, person.updatedAt),
				'edit the person through the app-like client'
			).record;
			expect(editedPerson.phone).toBe('+1-555-0182');

			const gift = ok(
				await createWishlistItem(appLike, owner, { name: 'Sample Gift Item' }),
				'create a gift through the app-like client'
			).record;
			const editedGift = ok(
				await updateWishlistItem(
					appLike,
					owner,
					gift.id,
					{ forPersonId: person.id },
					gift.updatedAt
				),
				'edit the gift through the app-like client'
			).record;
			expect(editedGift.forPersonId).toBe(person.id);

			const date = ok(
				await createImportantDate(appLike, owner, {
					title: 'Sample Birthday',
					onDate: '2026-03-04',
					personId: person.id
				}),
				'create a date through the app-like client'
			).record;
			const editedDate = ok(
				await updateImportantDate(
					appLike,
					owner,
					date.id,
					{ onDate: '2026-03-05' },
					date.updatedAt
				),
				'edit the date through the app-like client'
			).record;
			expect(editedDate).toMatchObject({ onDate: '2026-03-05', personId: person.id });
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
