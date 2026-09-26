import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf, type Viewer } from '$lib/server/auth/authz';
import type { AuthUser } from '$lib/server/auth/service';
import { one } from '$lib/server/db/scalar';
import {
	createDailyLog,
	createHealthTerm,
	getDailyLogForDate,
	healthForLog,
	healthFrequencies,
	logHealthTerm
} from '$lib/server/repositories';
import { actions, load } from '../../src/routes/(app)/journal/[date]/+page.server';
import type { JournalData } from '../../src/routes/(app)/journal/entry';

/**
 * Tagging a journal day with health words, through the journal's own load and
 * actions (PACK3-001).
 *
 * The repository rules are proved in health.test.ts; these cases prove the
 * page's path over them — that the form names a day rather than an entry, so
 * it can only ever reach the viewer's own; that a day with no entry is started
 * by a tag and never by a look; that the picker offers symptoms, activity and
 * exercise and nothing else; and that what it writes is what `/health/symptoms`
 * Patterns counts.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

const DAY = '2026-08-08';

let owner: Viewer;
let partner: Viewer;
let ownerUser: AuthUser;
let partnerUser: AuthUser;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
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
	partnerUser = {
		id: created.userId,
		username: 'partner',
		displayName: 'Partner',
		role: 'member',
		mustChangeCredentials: false,
		isBootstrap: false
	};
	partner = viewerOf(partnerUser, householdId);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what: string) => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

const word = async (kind: string, name: string, who: Viewer = owner) =>
	ok(await createHealthTerm(sql, who, { kind, name }), `create ${name}`).record;

/** A form post to one of the journal's actions, as the signed-in `user`. */
async function post(
	action: 'tag' | 'addTag',
	user: AuthUser,
	fields: Record<string, string>
): Promise<{ status?: number; data?: Record<string, unknown> } & Record<string, unknown>> {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	const request = new Request(`http://localhost/journal/${fields.date ?? DAY}`, {
		method: 'POST',
		body
	});
	// The actions read only `locals` and `request`.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await actions[action]!({ locals: { user }, request } as any)) as never;
}

const tag = (user: AuthUser, id: string, on = true, date = DAY) =>
	post('tag', user, { date, id, on: String(on) });

/** The page's data for a day, as `user` sees it. */
const open = async (user: AuthUser, date = DAY) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(await load({ locals: { user }, params: { date } } as any)) as JournalData;

const taggedOn = (data: JournalData) =>
	data.tags.groups.flatMap((group) => group.words.filter((w) => w.tagged).map((w) => w.name));

const logs = async (viewer: Viewer) =>
	one(
		await sql<{ n: number }[]>`
			select count(*)::int as n from daily_logs where owner_user_id = ${viewer.userId}::uuid
		`
	).n;

describe('tagging a day from the journal', () => {
	it('tags and untags, and the page reads it back', async () => {
		const headache = await word('symptom', 'Headache');
		await word('symptom', 'Nausea');
		ok(await createDailyLog(sql, owner, { onDate: DAY, note: 'Slow start' }), 'write the day');

		expect(await tag(ownerUser, headache.id)).toMatchObject({
			tag: { id: headache.id, on: true }
		});
		expect(taggedOn(await open(ownerUser))).toEqual(['Headache']);

		expect(await tag(ownerUser, headache.id, false)).toMatchObject({
			tag: { id: headache.id, on: false }
		});
		expect(taggedOn(await open(ownerUser))).toEqual([]);
		// The words are still offered; only the day changed.
		const symptoms = (await open(ownerUser)).tags.groups.find((g) => g.kind === 'symptom');
		expect(symptoms?.words.map((w) => w.name)).toEqual(['Headache', 'Nausea']);
	});

	it('is idempotent: a double tap lands on the same row', async () => {
		const headache = await word('symptom', 'Headache');
		for (let i = 0; i < 3; i++) {
			expect(await tag(ownerUser, headache.id)).toMatchObject({ tag: { on: true } });
		}
		const day = await getDailyLogForDate(sql, owner, DAY);
		expect(await healthForLog(sql, owner, day!.id)).toHaveLength(1);
		expect(await logs(owner)).toBe(1);

		// And in reverse: removing twice leaves the day as asked, not an error.
		for (let i = 0; i < 2; i++) {
			expect(await tag(ownerUser, headache.id, false)).toMatchObject({ tag: { on: false } });
		}
		expect(await healthForLog(sql, owner, day!.id)).toEqual([]);
	});

	it('shows a tag in the Patterns on /health/symptoms, which is the point', async () => {
		const walk = await word('activity', 'Long walk');
		await tag(ownerUser, walk.id, true, '2026-08-01');
		await tag(ownerUser, walk.id, true, '2026-08-02');

		expect(await healthFrequencies(sql, owner, { from: '2026-07-01', to: '2026-08-31' })).toEqual([
			expect.objectContaining({ name: 'Long walk', kind: 'activity', days: 2 })
		]);
		// Counted for its author only.
		expect(await healthFrequencies(sql, partner)).toEqual([]);
	});
});

describe('a day with no entry yet', () => {
	it('is not started by looking at it', async () => {
		await word('symptom', 'Headache');
		const data = await open(ownerUser);
		expect(data.entry).toBeNull();
		expect(taggedOn(data)).toEqual([]);
		expect(await logs(owner)).toBe(0);
	});

	it('is started by a tag, as the private entry a save would have made', async () => {
		const headache = await word('symptom', 'Headache');
		expect(await tag(ownerUser, headache.id)).toMatchObject({ tag: { on: true } });

		const day = await getDailyLogForDate(sql, owner, DAY);
		expect(day).toMatchObject({
			ownerUserId: owner.userId,
			visibility: 'private',
			onDate: DAY,
			note: null
		});
		const data = await open(ownerUser);
		expect(data.entry?.id).toBe(day!.id);
		expect(taggedOn(data)).toEqual(['Headache']);
	});

	it('is not started by taking a word off it', async () => {
		const headache = await word('symptom', 'Headache');
		expect(await tag(ownerUser, headache.id, false)).toMatchObject({ tag: { on: false } });
		expect(await logs(owner)).toBe(0);
	});

	it('is not started by a word that cannot be tagged', async () => {
		const content = await word('mood', 'Content');
		expect(await tag(ownerUser, content.id)).toMatchObject({ status: 404 });
		expect(await tag(ownerUser, crypto.randomUUID())).toMatchObject({ status: 404 });
		expect(await logs(owner)).toBe(0);
	});
});

describe('adding a word inline', () => {
	it('adds a new word to the list and tags the day with it', async () => {
		const result = await post('addTag', ownerUser, {
			date: DAY,
			kind: 'symptom',
			name: '  Tingling toes '
		});
		expect(result).toMatchObject({ tag: { on: true, added: true } });

		const data = await open(ownerUser);
		expect(taggedOn(data)).toEqual(['Tingling toes']);
		// The word is the household's; what was tagged is not.
		const partnerView = await open(partnerUser);
		const symptoms = partnerView.tags.groups.find((g) => g.kind === 'symptom');
		expect(symptoms?.words).toEqual([expect.objectContaining({ name: 'Tingling toes' })]);
		expect(taggedOn(partnerView)).toEqual([]);
	});

	it('tags the existing word when the name is already on the list', async () => {
		const headache = await word('symptom', 'Headache');
		const result = await post('addTag', ownerUser, {
			date: DAY,
			kind: 'symptom',
			name: 'headache'
		});
		expect(result).toMatchObject({ tag: { id: headache.id, on: true, added: false } });
		expect(taggedOn(await open(ownerUser))).toEqual(['Headache']);
	});

	it('refuses a list the picker does not offer, and starts no day', async () => {
		for (const kind of ['mood', 'energy', 'vitamin', 'astrology']) {
			const result = await post('addTag', ownerUser, { date: DAY, kind, name: 'Something' });
			expect(result).toMatchObject({ status: 400 });
		}
		const words = await sql`select 1 from health_vocabulary`;
		expect(words).toHaveLength(0);
		expect(await logs(owner)).toBe(0);
	});

	it('refuses a blank word, and starts no day', async () => {
		const result = await post('addTag', ownerUser, { date: DAY, kind: 'symptom', name: '   ' });
		expect(result).toMatchObject({ status: 400, data: { tagKind: 'symptom' } });
		expect(await logs(owner)).toBe(0);
	});
});

describe('privacy', () => {
	it('only ever reaches the viewer’s own day, even on the same date', async () => {
		const headache = await word('symptom', 'Headache');
		const nausea = await word('symptom', 'Nausea');
		await tag(ownerUser, headache.id);

		// The partner tags the same date: that is the partner's own day, a new
		// one, and the owner's is untouched.
		await tag(partnerUser, nausea.id);
		// And "untagging" the owner's word on that date reaches nothing.
		await tag(partnerUser, headache.id, false);

		expect(taggedOn(await open(ownerUser))).toEqual(['Headache']);
		expect(taggedOn(await open(partnerUser))).toEqual(['Nausea']);
		const [ownerDay, partnerDay] = await Promise.all([
			getDailyLogForDate(sql, owner, DAY),
			getDailyLogForDate(sql, partner, DAY)
		]);
		expect(ownerDay!.id).not.toBe(partnerDay!.id);
	});

	it('does not show the other member’s tags on the same date', async () => {
		const nausea = await word('symptom', 'Nausea');
		const theirs = ok(await createDailyLog(sql, partner, { onDate: DAY }), 'their day').record;
		ok(await logHealthTerm(sql, partner, theirs.id, nausea.id), 'their tag');
		// Even shared with the household: a journal is its author's.
		await sql`update daily_logs set visibility = 'household' where id = ${theirs.id}::uuid`;

		const data = await open(ownerUser);
		expect(data.entry).toBeNull();
		expect(taggedOn(data)).toEqual([]);
		expect(data.tags.alsoLogged).toEqual([]);
	});

	it('will not tag with a word from another household', async () => {
		const [other] = await sql<{ id: string }[]>`
			insert into households (name) values ('Next door') returning id
		`;
		const theirs = await word('symptom', 'Nausea', { ...owner, householdId: other!.id });

		expect(await tag(ownerUser, theirs.id)).toMatchObject({ status: 404 });
		expect(await logs(owner)).toBe(0);
		// Nor offer it.
		expect((await open(ownerUser)).tags.groups.flatMap((g) => g.words)).toEqual([]);
	});

	it('will not tag with, or offer, another member’s private word', async () => {
		const secret = ok(
			await createHealthTerm(sql, partner, {
				kind: 'symptom',
				name: 'Private word',
				ownerUserId: partner.userId,
				visibility: 'private'
			}),
			'create a private word'
		).record;

		expect(await tag(ownerUser, secret.id)).toMatchObject({ status: 404 });
		expect(await logs(owner)).toBe(0);
		expect((await open(ownerUser)).tags.groups.flatMap((g) => g.words)).toEqual([]);
		// Typing its name gets the owner a word of their own, not theirs.
		const result = await post('addTag', ownerUser, {
			date: DAY,
			kind: 'symptom',
			name: 'Private word'
		});
		expect(result).toMatchObject({ tag: { added: true } });
		expect((result.tag as { id: string }).id).not.toBe(secret.id);
	});
});

describe('what the picker offers', () => {
	it('offers symptoms, activity and exercise, and shows imported mood and energy read-only', async () => {
		await word('symptom', 'Headache');
		await word('activity', 'Gardening');
		await word('exercise', 'Swim');
		const content = await word('mood', 'Content');
		const balanced = await word('energy', 'Balanced');
		const archived = await word('symptom', 'Old word');
		await sql`update health_vocabulary set archived_at = now() where id = ${archived.id}::uuid`;

		// What an import leaves: mood and energy linked to the day directly.
		const day = ok(await createDailyLog(sql, owner, { onDate: DAY }), 'the day').record;
		ok(await logHealthTerm(sql, owner, day.id, content.id), 'imported mood');
		ok(await logHealthTerm(sql, owner, day.id, balanced.id), 'imported energy');

		const data = await open(ownerUser);
		expect(data.tags.groups.map((g) => [g.kind, g.words.map((w) => w.name)])).toEqual([
			['symptom', ['Headache']],
			['activity', ['Gardening']],
			['exercise', ['Swim']]
		]);
		expect(data.tags.alsoLogged.map((t) => [t.kind, t.name])).toEqual([
			['energy', 'Balanced'],
			['mood', 'Content']
		]);

		// And the picker's actions cannot change them.
		expect(await tag(ownerUser, content.id)).toMatchObject({ status: 404 });
		await tag(ownerUser, content.id, false);
		expect((await healthForLog(sql, owner, day.id)).map((t) => t.name)).toEqual([
			'Balanced',
			'Content'
		]);
	});

	it('keeps a word archived since it was tagged on the day, and lets it be removed', async () => {
		const old = await word('symptom', 'Old word');
		await tag(ownerUser, old.id);
		await sql`update health_vocabulary set archived_at = now() where id = ${old.id}::uuid`;

		let symptoms = (await open(ownerUser)).tags.groups.find((g) => g.kind === 'symptom');
		expect(symptoms?.words).toEqual([{ id: old.id, name: 'Old word', tagged: true }]);

		await tag(ownerUser, old.id, false);
		symptoms = (await open(ownerUser)).tags.groups.find((g) => g.kind === 'symptom');
		expect(symptoms?.words).toEqual([]);
		// And, archived, it cannot be put back.
		expect(await tag(ownerUser, old.id)).toMatchObject({ status: 404 });
	});

	it('refuses a retired vitamin', async () => {
		const [leftover] = await sql<{ id: string }[]>`
			insert into health_vocabulary (household_id, visibility, kind, name)
			values (${owner.householdId}::uuid, 'household', 'vitamin', 'Vitamin Q')
			returning id
		`;
		expect(await tag(ownerUser, leftover!.id)).toMatchObject({ status: 404 });
		expect(await logs(owner)).toBe(0);
		expect((await open(ownerUser)).tags.groups.flatMap((g) => g.words)).toEqual([]);
	});
});
