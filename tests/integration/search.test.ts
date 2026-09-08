import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
	createHealthTerm,
	createIngredient,
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

/**
 * The application's real routes, as matchers.
 *
 * Read from disk rather than listed by hand: a hand-written list is a second
 * copy of the route tree and drifts from it silently, which is the exact
 * failure this guards against.
 */
function routeMatchers(): RegExp[] {
	const root = 'src/routes/(app)';
	const out: RegExp[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (!statSync(full).isDirectory()) continue;
			// Route groups like (app) do not appear in the URL.
			const segment = entry.startsWith('(') && entry.endsWith(')') ? '' : `/${entry}`;
			const path = prefix + segment;
			try {
				statSync(join(full, '+page.svelte'));
				// [id] and [date] match one non-slash segment.
				out.push(new RegExp(`^${path.replace(/\[[^\]]+\]/g, '[^/]+')}$`));
			} catch {
				// A directory without a page is just a container.
			}
			walk(full, path);
		}
	};
	walk(root, '');
	return out;
}

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
		ok(await createRecipe(sql, owner, { name: `${word} soup` }), 'recipe');
		ok(await createIngredient(sql, owner, { name: `${word} root` }), 'ingredient');
		ok(await createPerson(sql, owner, { name: `${word} keeper` }), 'person');
		ok(await createHabit(sql, owner, { name: `${word} walk` }), 'habit');
		ok(await createWishlistItem(sql, owner, { name: `${word} hutch` }), 'wishlist item');
		ok(await createBill(sql, owner, { name: `${word} insurance` }), 'bill');
		ok(await createHealthTerm(sql, owner, { kind: 'symptom', name: `${word} ache` }), 'term');
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
