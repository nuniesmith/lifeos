import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	SEARCH_KINDS,
	createArea,
	createBill,
	createDailyLog,
	createHabit,
	createHealthMeasurement,
	createHealthTerm,
	createIngredient,
	createLabMarker,
	createMedicalVisit,
	createMedication,
	createPerson,
	createRecipe,
	createWishlistItem,
	createLibraryItem,
	createGoal,
	createProject,
	createTask,
	search,
	setTaskArchived
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';
import { routeMatchers } from './route-matchers';

/**
 * Search reaches across every table at once, which makes it the easiest place
 * in the application to leak: a single missing predicate is invisible in the
 * output, because a result list cannot show what it wrongly included. The
 * privacy cases below are therefore the point of this file, and the
 * find-the-thing cases are what stops them passing vacuously.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;
let householdId: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(
		await sql<{ id: string; role: 'admin' | 'member' }[]>`select id, role from users limit 1`
	);
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
	if (!result.ok) throw new Error(`could not create ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};

const titles = (hits: { title: string }[]) => hits.map((h) => h.title);

describe('every search result links somewhere real', () => {
	it('generates a path that matches an existing route, for every kind', async () => {
		// One record of each searchable kind, all sharing a word.
		const word = 'quokka';
		ok(await createTask(sql, owner, { title: `${word} task` }), 'task');
		ok(await createProject(sql, owner, { name: `${word} project` }), 'project');
		ok(await createGoal(sql, owner, { title: `${word} goal` }), 'goal');
		ok(await createArea(sql, owner, { name: `${word} area` }), 'area');
		ok(await createLibraryItem(sql, owner, { title: `${word} book` }), 'library item');
		ok(await createDailyLog(sql, owner, { onDate: '2026-04-01', note: `${word} day` }), 'log');
		await sql`
			insert into important_dates (household_id, owner_user_id, title, on_date, created_by)
			values (${owner.householdId}::uuid, ${owner.userId}::uuid, ${word + ' date'},
			        '2026-04-02', ${owner.userId}::uuid)
		`;

		// The feature packs. Every kind must be present, which is the point of the
		// assertion below: a branch with no record of its own never has its path
		// checked, and that is exactly how /library/<id> once shipped pointing at a
		// route that did not exist.
		const recipe = ok(await createRecipe(sql, owner, { name: `${word} soup` }), 'recipe').record;
		ok(await createIngredient(sql, owner, { name: `${word} root` }), 'ingredient');
		ok(await createPerson(sql, owner, { name: `${word} keeper` }), 'person');
		ok(await createHabit(sql, owner, { name: `${word} walk` }), 'habit');
		ok(await createWishlistItem(sql, owner, { name: `${word} hutch` }), 'wishlist item');
		ok(await createBill(sql, owner, { name: `${word} insurance` }), 'bill');
		ok(await createHealthTerm(sql, owner, { kind: 'symptom', name: `${word} ache` }), 'term');
		ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-04-03T08:00',
				weight: 70,
				notes: `${word} reading`
			}),
			'health measurement'
		);
		ok(
			await createMedication(sql, owner, { name: `${word} oil`, type: 'supplement' }),
			'medication'
		);
		const marker = ok(
			await createLabMarker(sql, owner, { name: `${word} index` }),
			'lab marker'
		).record;
		const visit = ok(
			await createMedicalVisit(sql, owner, {
				reason: `${word} check`,
				visitDate: '2026-04-04',
				visitTime: '10:00'
			}),
			'medical visit'
		).record;
		// Media items are import-only — there is no create path — so this one is
		// inserted directly rather than skipped, which would leave its branch
		// unchecked.
		await sql`
			insert into media_items (household_id, owner_user_id, name, status, created_by)
			values (${owner.householdId}::uuid, ${owner.userId}::uuid, ${word + ' series'},
			        'watching', ${owner.userId}::uuid)
		`;

		const hits = await search(sql, owner, word);
		const routes = routeMatchers();

		// Every kind is represented, so no branch escapes the check by being
		// absent from the results.
		expect(new Set(hits.map((h) => h.kind)).size).toBe(SEARCH_KINDS.length);

		for (const hit of hits) {
			const matched = routes.some((r) => r.test(hit.path));
			// The bug this exists for: search linked every library hit to
			// /library/<id> while that route did not exist, so a result that
			// looked right went to a 404.
			expect(matched, `${hit.kind} -> ${hit.path} matches no route`).toBe(true);
		}

		// A detail route has to be given the record's own id, not merely exist.
		const pathOf = (kind: string) => hits.find((h) => h.kind === kind)?.path;
		expect(pathOf('lab_marker')).toBe(`/health/labs/${marker.id}`);
		expect(pathOf('medical_visit')).toBe(`/health/visits/${visit.id}`);
		expect(pathOf('medication')).toBe('/health/medications');
		// A recipe's method is only readable on its own page, so that is where
		// a hit goes — not to the list on /food, which shows a dozen cards.
		expect(pathOf('recipe')).toBe(`/food/recipes/${recipe.id}`);
		// Important dates are shown on the calendar; /areas never lists them.
		expect(pathOf('important_date')).toBe('/calendar');
	});
});

describe('search', () => {
	it('finds a task by a word in its title', async () => {
		ok(await createTask(sql, owner, { title: 'Replace the kitchen tap' }), 'task');
		ok(await createTask(sql, owner, { title: 'Book the ferry' }), 'task');

		const hits = await search(sql, owner, 'kitchen');
		expect(titles(hits)).toEqual(['Replace the kitchen tap']);
		expect(hits[0]?.kind).toBe('task');
		expect(hits[0]?.path).toMatch(/^\/tasks\//);
	});

	it('finds a project by a word only in its description', async () => {
		ok(
			await createProject(sql, owner, {
				name: 'Spring list',
				description: 'Strip and repaint the verandah railings'
			}),
			'project'
		);

		const hits = await search(sql, owner, 'verandah');
		expect(titles(hits)).toEqual(['Spring list']);
		expect(hits[0]?.kind).toBe('project');
	});

	it('stems, so a search for one form finds the other', async () => {
		ok(await createGoal(sql, owner, { title: 'Run a half marathon' }), 'goal');

		// 'english' stemming is the reason the index is an expression index; a
		// plain LIKE would miss this and nobody would notice until they searched
		// for a word they had actually written.
		expect(titles(await search(sql, owner, 'running'))).toEqual(['Run a half marathon']);
	});

	it('marks the matched words in the excerpt', async () => {
		ok(
			await createArea(sql, owner, {
				name: 'Home',
				description: 'The house, the garden, and everything that leaks in them'
			}),
			'area'
		);

		const [hit] = await search(sql, owner, 'garden');
		expect(hit?.excerpt).toContain('«garden»');
	});

	it('ranks a live record above an archived one', async () => {
		const live = ok(await createTask(sql, owner, { title: 'Order compost' }), 'task');
		const gone = ok(await createTask(sql, owner, { title: 'Order compost bins' }), 'task');
		ok(await setTaskArchived(sql, owner, gone.record.id, true), 'archive');

		const hits = await search(sql, owner, 'compost');
		expect(hits).toHaveLength(2);
		expect(hits[0]?.id).toBe(live.record.id);
		expect(hits[0]?.archived).toBe(false);
		expect(hits[1]?.archived).toBe(true);
	});

	it('titles a journal day and a reading with the day of the month', async () => {
		// 17 April 2026 is a Friday. `D` in to_char is the day of the *week*, so
		// the old format printed "Friday 6 Apr 2026" — plausible enough to pass
		// by eye, and exactly right on the one date in four weeks where the two
		// numbers happen to agree, which is the date the privacy case below uses.
		ok(await createDailyLog(sql, owner, { onDate: '2026-04-17', note: 'Tidal pools' }), 'log');
		ok(
			await createHealthMeasurement(sql, owner, {
				measuredAt: '2026-04-17T07:15',
				weight: 70,
				notes: 'Tidal pools, then weighed'
			}),
			'reading'
		);

		expect(titles(await search(sql, owner, 'tidal')).sort()).toEqual([
			'Friday 17 Apr 2026',
			'Reading — Friday 17 Apr 2026'
		]);
	});

	it('does not find a health word of a kind /health no longer lists', async () => {
		// Written as the old add form did before vitamins became medications
		// (migration 0018); the table's CHECK still permits the kind.
		await sql`
			insert into health_vocabulary (household_id, owner_user_id, kind, name, created_by)
			values (${owner.householdId}::uuid, ${owner.userId}::uuid, 'vitamin', 'Wombat drops',
			        ${owner.userId}::uuid)
		`;
		ok(await createHealthTerm(sql, owner, { kind: 'symptom', name: 'Wombat ache' }), 'term');

		expect(titles(await search(sql, owner, 'wombat'))).toEqual(['Wombat ache']);
	});

	it('restricts to the kinds asked for, and reads no other table', async () => {
		ok(await createTask(sql, owner, { title: 'Anemone planting' }), 'task');
		ok(await createProject(sql, owner, { name: 'Anemone bed' }), 'project');

		const hits = await search(sql, owner, 'anemone', { kinds: ['project'] });
		expect(titles(hits)).toEqual(['Anemone bed']);
	});

	it('returns nothing for a term too short to be a query', async () => {
		ok(await createTask(sql, owner, { title: 'a bicycle' }), 'task');
		expect(await search(sql, owner, 'a')).toEqual([]);
		expect(await search(sql, owner, '   ')).toEqual([]);
	});

	it('does not raise on input a person could plausibly type', async () => {
		ok(await createTask(sql, owner, { title: 'Quoted thing' }), 'task');
		// websearch_to_tsquery is used precisely so these are queries, not errors.
		await expect(search(sql, owner, '"unbalanced')).resolves.toBeInstanceOf(Array);
		await expect(search(sql, owner, 'thing -quoted')).resolves.toBeInstanceOf(Array);
		await expect(search(sql, owner, '& | ! (')).resolves.toBeInstanceOf(Array);
	});

	describe('privacy', () => {
		it('never returns another member’s private record', async () => {
			ok(
				await createTask(sql, partner, {
					title: 'Hospital appointment',
					visibility: 'private',
					ownerUserId: partner.userId
				}),
				'private task'
			);

			// The admin is still an admin. Private means private from the other
			// member *including* an admin, so the role must not help here.
			expect(owner.role).toBe('admin');
			expect(await search(sql, owner, 'hospital')).toEqual([]);
			expect(titles(await search(sql, partner, 'hospital'))).toEqual(['Hospital appointment']);
		});

		it('applies the same scope to the feature packs, not just tasks', async () => {
			// The new kinds all go through readableScope, but "all of them use the
			// helper" is a claim about code, not about behaviour. A recipe is the
			// cheapest way to check the behaviour is really there.
			ok(
				await createRecipe(sql, partner, {
					name: 'Hangover cure',
					visibility: 'private',
					ownerUserId: partner.userId
				}),
				'private recipe'
			);

			expect(owner.role).toBe('admin');
			expect(await search(sql, owner, 'hangover')).toEqual([]);
			expect(titles(await search(sql, partner, 'hangover'))).toEqual(['Hangover cure']);
		});

		it('never returns another member’s private medication, marker or visit', async () => {
			// Each is checked on its own branch: they are three separate predicates,
			// and one passing says nothing about the other two.
			const privately = { visibility: 'private' as const, ownerUserId: partner.userId };
			ok(
				await createMedication(sql, partner, {
					name: 'Sertraline',
					type: 'prescription',
					...privately
				}),
				'private medication'
			);
			ok(await createLabMarker(sql, partner, { name: 'Prolactin', ...privately }), 'marker');
			ok(
				await createMedicalVisit(sql, partner, {
					reason: 'Dermatology referral',
					visitDate: '2026-05-06',
					visitTime: '14:40',
					...privately
				}),
				'private visit'
			);

			expect(owner.role).toBe('admin');
			for (const term of ['sertraline', 'prolactin', 'dermatology']) {
				expect(await search(sql, owner, term), term).toEqual([]);
			}
			expect(titles(await search(sql, partner, 'sertraline'))).toEqual(['Sertraline']);
			expect(titles(await search(sql, partner, 'prolactin'))).toEqual(['Prolactin']);
			expect(titles(await search(sql, partner, 'dermatology'))).toEqual([
				'Dermatology referral — 6 May 2026'
			]);
		});

		it('returns household-shared health records to both members', async () => {
			// These default to shared (migrations 0018 and 0020): a partner helping
			// to manage an illness is expected to find the other's medication.
			ok(
				await createMedication(sql, partner, { name: 'Magnesium glycinate', type: 'supplement' }),
				'medication'
			);
			ok(
				await createMedicalVisit(sql, partner, {
					reason: 'Physiotherapy',
					visitDate: '2026-05-06',
					visitTime: '08:15'
				}),
				'visit'
			);
			expect(titles(await search(sql, owner, 'magnesium'))).toEqual(['Magnesium glycinate']);
			expect(titles(await search(sql, owner, 'physiotherapy'))).toEqual([
				'Physiotherapy — 6 May 2026'
			]);
		});

		it('returns a household record to both members', async () => {
			ok(await createTask(sql, partner, { title: 'Renew the insurance' }), 'task');
			expect(titles(await search(sql, owner, 'insurance'))).toEqual(['Renew the insurance']);
		});

		it('never returns another member’s journal, whatever its visibility', async () => {
			ok(
				await createDailyLog(sql, partner, {
					onDate: '2026-03-04',
					note: 'Felt wretched about the argument',
					visibility: 'household',
					ownerUserId: partner.userId
				}),
				'daily log'
			);

			// Deliberately stricter than visibility: a journal is owner-scoped in
			// search even when its row says household, because nobody writes a
			// diary expecting their partner to reach it by typing a word.
			expect(await search(sql, owner, 'wretched')).toEqual([]);
			expect(await search(sql, partner, 'wretched')).toHaveLength(1);
		});

		it('never crosses a household boundary', async () => {
			ok(await createTask(sql, owner, { title: 'Zeppelin tickets' }), 'task');

			const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };
			expect(await search(sql, elsewhere, 'zeppelin')).toEqual([]);
		});
	});
});
