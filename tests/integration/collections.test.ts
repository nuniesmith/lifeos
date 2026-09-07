import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createBill,
	createPerson,
	createWishlistItem,
	listBills,
	listMedia,
	listPeople,
	listWishlist,
	monthlyCommitment,
	personGroups,
	setMediaStatus
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * People, wishlist, watchlist and bills (migration 0014).
 *
 * The two things here that are easy to get quietly wrong: a monthly total that
 * treats an annual bill as a monthly one, and a gift attached to a person from
 * another household.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let viewer: Viewer;
let elsewhere: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	const identity = {
		id: admin.id,
		username: 'admin',
		displayName: 'Admin',
		role: 'admin' as const,
		mustChangeCredentials: false,
		isBootstrap: true
	};
	viewer = viewerOf(identity, householdId);
	const [other] = await sql<{ id: string }[]>`
		insert into households (name) values ('Next door') returning id
	`;
	elsewhere = viewerOf(identity, other!.id);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what: string) => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

const person = async (name: string, extra: object = {}, who = viewer) =>
	ok(await createPerson(sql, who, { name, ...extra }), `create ${name}`).record;

const media = async (name: string, extra: Record<string, unknown> = {}) => {
	const [row] = await sql<{ id: string }[]>`
		insert into media_items (household_id, name, media_type, status, times_watched)
		values (${viewer.householdId}::uuid, ${name},
		        ${(extra.mediaType as string) ?? 'tv'},
		        ${(extra.status as string) ?? 'want_to_watch'},
		        ${(extra.timesWatched as number) ?? 0})
		returning id
	`;
	return row!.id;
};

describe('people', () => {
	it('keeps groups as a list and surfaces the ones in use', async () => {
		await person('Jordan Smith', { groups: 'Family, Friends' });
		await person('The cabin', { kind: 'place' });

		const [jordan] = await listPeople(sql, viewer, { kind: 'person' });
		expect(jordan?.groups).toEqual(['Family', 'Friends']);
		expect(await personGroups(sql, viewer)).toEqual(['Family', 'Friends']);
	});

	it('filters by group', async () => {
		await person('Jordan Smith', { groups: 'Family' });
		await person('Kate', { groups: 'Friends' });
		expect((await listPeople(sql, viewer, { group: 'Family' })).map((p) => p.name)).toEqual([
			'Jordan Smith'
		]);
	});

	it('refuses a duplicate name and an unknown kind', async () => {
		await person('Jordan Smith');
		expect(await createPerson(sql, viewer, { name: 'jordan smith' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		expect(await createPerson(sql, viewer, { name: 'Ghost', kind: 'spirit' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});
});

describe('the wishlist', () => {
	it('attaches a gift to a person and reads their name back', async () => {
		const jordan = await person('Jordan Smith');
		const gift = ok(
			await createWishlistItem(sql, viewer, {
				name: 'Thermomix',
				occasion: 'Birthday',
				forPersonId: jordan.id
			}),
			'create gift'
		).record;

		expect(gift.forPersonId).toBe(jordan.id);
		// The name comes through the join, so the page does not need a second
		// query to say who it is for.
		expect(gift.forPersonName).toBe('Jordan Smith');
		expect(
			(await listWishlist(sql, viewer, { forPersonId: jordan.id })).map((w) => w.name)
		).toEqual(['Thermomix']);
	});

	it('drops a recipient from another household rather than linking them', async () => {
		const theirs = await person('Not ours', {}, elsewhere);
		const gift = ok(
			await createWishlistItem(sql, viewer, { name: 'Something', forPersonId: theirs.id }),
			'create gift'
		).record;

		// Resolved in SQL against the viewer's own household: an id from
		// somewhere else lands as null rather than as a cross-household row.
		expect(gift.forPersonId).toBeNull();
		expect(gift.forPersonName).toBeNull();
	});

	it('keeps a gift with no recipient, because that is a note to self', async () => {
		const gift = ok(
			await createWishlistItem(sql, viewer, { name: 'A thing I want' }),
			'create gift'
		).record;
		expect(gift.forPersonId).toBeNull();
		expect(gift.status).toBe('wanted');
	});
});

describe('the watchlist', () => {
	it('counts a watch when something is marked watched', async () => {
		const id = await media('SEAL Team', { status: 'watching', timesWatched: 1 });

		const done = ok(await setMediaStatus(sql, viewer, id, 'watched'), 'finish');
		expect(done.record.status).toBe('watched');
		// Marking it watched IS a watch; the count is what "watch again?" is
		// answered from.
		expect(done.record.timesWatched).toBe(2);
		expect(done.record.lastWatchedAt).toBeInstanceOf(Date);
	});

	it('does not count a watch when something is merely started', async () => {
		const id = await media('Foundation', { status: 'want_to_watch' });
		const started = ok(await setMediaStatus(sql, viewer, id, 'watching'), 'start');
		expect(started.record.timesWatched).toBe(0);
		// Starting still stamps the date: it is on the go, so it should sort as
		// recent.
		expect(started.record.lastWatchedAt).toBeInstanceOf(Date);
	});

	it('does not count a watch when something is dropped', async () => {
		const id = await media('Something dull', { status: 'watching' });
		const dropped = ok(await setMediaStatus(sql, viewer, id, 'dropped'), 'drop');
		expect(dropped.record.timesWatched).toBe(0);
	});

	it('never reaches another household', async () => {
		await media('Ours');
		expect(await listMedia(sql, elsewhere)).toEqual([]);
	});
});

describe('bills', () => {
	it('normalises every frequency to a monthly figure', async () => {
		ok(
			await createBill(sql, viewer, { name: 'Netflix', amount: 24.99, frequency: 'monthly' }),
			'a'
		);
		ok(await createBill(sql, viewer, { name: 'Costco', amount: 150, frequency: 'annual' }), 'b');

		const bills = await listBills(sql, viewer);
		const netflix = bills.find((b) => b.name === 'Netflix');
		const costco = bills.find((b) => b.name === 'Costco');

		expect(netflix?.monthlyEquivalent).toBe(24.99);
		// 150 a year is 12.50 a month, not 150 a month. Treating an annual bill
		// as monthly overstates the household's commitments by an order of
		// magnitude, which is the whole reason this figure is derived.
		expect(costco?.monthlyEquivalent).toBe(12.5);
	});

	it('gives a one-off no monthly cost at all', async () => {
		ok(
			await createBill(sql, viewer, { name: 'New laptop', amount: 2000, frequency: 'one_off' }),
			'x'
		);
		const [bill] = await listBills(sql, viewer);
		expect(bill?.monthlyEquivalent).toBe(0);
		expect((await monthlyCommitment(sql, viewer)).total).toBe(0);
	});

	it('has no monthly figure when the amount is unknown', async () => {
		ok(await createBill(sql, viewer, { name: 'Something', frequency: 'monthly' }), 'x');
		const [bill] = await listBills(sql, viewer);
		// Null, not zero: an unpriced bill is not a free one.
		expect(bill?.amount).toBeNull();
		expect(bill?.monthlyEquivalent).toBeNull();
	});

	it('totals only what is still being paid', async () => {
		ok(
			await createBill(sql, viewer, { name: 'Netflix', amount: 24.99, frequency: 'monthly' }),
			'a'
		);
		ok(await createBill(sql, viewer, { name: 'Costco', amount: 150, frequency: 'annual' }), 'b');
		ok(
			await createBill(sql, viewer, {
				name: 'Old gym',
				amount: 60,
				frequency: 'monthly',
				status: 'cancelled'
			}),
			'c'
		);

		const commitment = await monthlyCommitment(sql, viewer);
		expect(commitment.total).toBe(37.49);
		expect(commitment.count).toBe(2);
	});

	it('counts nothing from another household', async () => {
		ok(
			await createBill(sql, viewer, { name: 'Netflix', amount: 24.99, frequency: 'monthly' }),
			'a'
		);
		expect((await monthlyCommitment(sql, elsewhere)).total).toBe(0);
		expect(await listBills(sql, elsewhere)).toEqual([]);
	});
});
