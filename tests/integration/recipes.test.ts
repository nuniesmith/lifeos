import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf, type Viewer } from '$lib/server/auth/authz';
import type { AuthUser } from '$lib/server/auth/service';
import { one } from '$lib/server/db/scalar';
import {
	addRecipeIngredient,
	bodyImagesForPage,
	coversForPages,
	createIngredient,
	createRecipe,
	getRecipe,
	householdToday,
	ingredientsForRecipe,
	listArchived,
	listRecipes,
	restore,
	search,
	setRecipeArchived,
	updateRecipe
} from '$lib/server/repositories';
import { actions, load } from '../../src/routes/(app)/food/recipes/[id]/+page.server';
import { actions as newRecipeActions } from '../../src/routes/(app)/food/recipes/new/+page.server';

/**
 * A recipe's own page, and the editing that makes imported recipes the
 * household's own again.
 *
 * Most of these are about who may see and change what. Recipes are household
 * records, but a recipe can still be made private, and one member's private
 * recipe must behave exactly like one that does not exist — to the page, to
 * each action, and to the ingredient list of a recipe the other member *can*
 * see. The route's own load and actions are called here, not only the
 * repository, because the page is where a forgotten check would leak.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;
let ownerUser: AuthUser;
let partnerUser: AuthUser;
let householdId: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
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

const recipe = async (name: string, extra: object = {}, viewer: Viewer = owner) =>
	ok(await createRecipe(sql, viewer, { name, ...extra }), `create ${name}`).record;

/** Someone else's recipe that only they can see. */
const privateTo = (viewer: Viewer) => ({
	visibility: 'private' as const,
	ownerUserId: viewer.userId
});

// ─── calling the route the way SvelteKit does ──────────────────────────────

type PageData = Exclude<Awaited<ReturnType<typeof load>>, void>;

const loadPage = async (id: string, user: AuthUser = ownerUser) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(await load({ locals: { user }, params: { id } } as any)) as PageData;

/** What a thrown `error()` or `redirect()` carries, or 200 when nothing was thrown. */
async function thrown(work: unknown): Promise<{ status: number; location?: string }> {
	try {
		await work;
		return { status: 200 };
	} catch (err) {
		const { status, location } = err as { status?: number; location?: string };
		if (typeof status !== 'number') throw err;
		return { status, location };
	}
}

async function act(
	name: keyof typeof actions,
	id: string,
	fields: Record<string, string> = {},
	user: AuthUser = ownerUser
) {
	const action = actions[name];
	if (!action) throw new Error(`no action ${String(name)}`);
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	const request = new Request('http://localhost/food/recipes/x', { method: 'POST', body });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await action({ locals: { user }, params: { id }, request } as any)) as {
		status?: number;
		data?: Record<string, unknown>;
	} & Record<string, unknown>;
}

// ─── editing ───────────────────────────────────────────────────────────────

describe('editing a recipe', () => {
	it('changes the core fields and nothing else', async () => {
		const soup = await recipe('Broccoli soup', { courses: 'Lunch, Dinner', cuisine: 'British' });

		const saved = ok(
			await updateRecipe(
				sql,
				owner,
				soup.id,
				{
					name: 'Broccoli & cheddar soup',
					servings: '4',
					prepMinutes: '10',
					cookMinutes: '25',
					additionalMinutes: '',
					url: 'https://example.com/soup',
					notes: '1. Sweat the onion.\n2. Add the broccoli.'
				},
				soup.updatedAt
			),
			'save'
		).record;

		expect(saved).toMatchObject({
			name: 'Broccoli & cheddar soup',
			servings: 4,
			prepMinutes: 10,
			cookMinutes: 25,
			additionalMinutes: null,
			totalMinutes: 35,
			url: 'https://example.com/soup',
			notes: '1. Sweat the onion.\n2. Add the broccoli.',
			// Not in the patch, so kept.
			courses: ['Lunch', 'Dinner'],
			cuisine: 'British',
			isFavourite: false
		});
		expect((await getRecipe(sql, owner, soup.id))?.name).toBe('Broccoli & cheddar soup');
	});

	it('refuses a save from a stale page, and says what is there now', async () => {
		const soup = await recipe('Soup');
		const stale = soup.updatedAt;
		ok(await updateRecipe(sql, partner, soup.id, { servings: '6' }, stale), 'first save');

		const second = await updateRecipe(sql, owner, soup.id, { servings: '2' }, stale);
		expect(second).toMatchObject({ ok: false, reason: 'conflict' });
		expect(second.ok ? null : second.current?.servings).toBe(6);
		expect((await getRecipe(sql, owner, soup.id))?.servings).toBe(6);
	});

	it('treats a blank number as not recorded, and a bad one as bad input rather than a crash', async () => {
		const soup = await recipe('Soup', { servings: '4', prepMinutes: '5' });
		const cleared = ok(
			await updateRecipe(sql, owner, soup.id, { servings: '', prepMinutes: '' }),
			'clear'
		).record;
		expect(cleared).toMatchObject({ servings: null, prepMinutes: null, totalMinutes: null });

		for (const patch of [
			{ servings: '0' },
			{ servings: '-2' },
			{ servings: 'lots' },
			{ cookMinutes: '-5' },
			{ name: '   ' }
		]) {
			expect(await updateRecipe(sql, owner, soup.id, patch), JSON.stringify(patch)).toMatchObject({
				ok: false,
				reason: 'invalid'
			});
		}
	});

	it('creates a recipe from a form where only the name was filled in', async () => {
		// Every field a form leaves blank arrives as ''. Servings used to pass
		// through as 0, which the table refuses — a 500 for an untouched field.
		const made = ok(
			await createRecipe(sql, owner, {
				name: 'Flapjacks',
				servings: '',
				prepMinutes: '',
				cookMinutes: '',
				url: '',
				notes: ''
			}),
			'create'
		).record;
		expect(made).toMatchObject({
			name: 'Flapjacks',
			servings: null,
			prepMinutes: null,
			url: null,
			notes: null,
			visibility: 'household',
			ownerUserId: null
		});
		expect(await createRecipe(sql, owner, { name: '' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('only stores a source link that is a web address', async () => {
		const soup = await recipe('Soup');
		for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'not a link']) {
			expect(await updateRecipe(sql, owner, soup.id, { url }), url).toMatchObject({
				ok: false,
				reason: 'invalid'
			});
			expect(await createRecipe(sql, owner, { name: 'Other', url }), url).toMatchObject({
				ok: false,
				reason: 'invalid'
			});
		}
		ok(await updateRecipe(sql, owner, soup.id, { url: 'https://example.com/a' }), 'web address');
	});

	it('does not let an imported link in some other shape block an unrelated edit', async () => {
		const soup = await recipe('Soup');
		await sql`update recipes set url = 'Grandma’s red notebook' where id = ${soup.id}::uuid`;
		const saved = ok(
			await updateRecipe(sql, owner, soup.id, { url: 'Grandma’s red notebook', servings: '2' }),
			'save'
		).record;
		expect(saved).toMatchObject({ url: 'Grandma’s red notebook', servings: 2 });
	});

	it('marks a favourite and the day it was made', async () => {
		const soup = await recipe('Soup');
		const fav = ok(await updateRecipe(sql, owner, soup.id, { isFavourite: true }), 'fav').record;
		expect(fav.isFavourite).toBe(true);
		const made = ok(
			await updateRecipe(sql, owner, soup.id, { lastMadeOn: '2026-09-20' }),
			'made'
		).record;
		expect(made).toMatchObject({ isFavourite: true, lastMadeOn: '2026-09-20' });
		expect(await updateRecipe(sql, owner, soup.id, { lastMadeOn: 'yesterday' })).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
	});

	it('archives out of the live list and restores from the Archive, linking back to the page', async () => {
		const soup = await recipe('Soup');
		ok(await setRecipeArchived(sql, owner, soup.id, true), 'archive');

		expect(await listRecipes(sql, owner)).toEqual([]);
		// Still readable: the Archive links to this page, and it must open.
		expect((await getRecipe(sql, owner, soup.id))?.archivedAt).not.toBeNull();

		const [entry] = await listArchived(sql, owner);
		expect(entry).toMatchObject({ kind: 'recipe', path: `/food/recipes/${soup.id}` });

		ok(await restore(sql, owner, 'recipe', soup.id), 'restore');
		expect((await listRecipes(sql, owner)).map((r) => r.name)).toEqual(['Soup']);
	});

	it('is found by search, which links to the page', async () => {
		const soup = await recipe('Mulligatawny');
		const [hit] = await search(sql, owner, 'mulligatawny');
		expect(hit).toMatchObject({ kind: 'recipe', path: `/food/recipes/${soup.id}` });
	});
});

// ─── privacy ───────────────────────────────────────────────────────────────

describe('privacy', () => {
	it('treats another member’s private recipe as one that does not exist', async () => {
		const theirs = await recipe('Secret stew', privateTo(partner), partner);

		expect(owner.role).toBe('admin');
		expect(await getRecipe(sql, owner, theirs.id)).toBeNull();
		for (const [what, attempt] of [
			['edit', updateRecipe(sql, owner, theirs.id, { name: 'Mine now' })],
			['favourite', updateRecipe(sql, owner, theirs.id, { isFavourite: true })],
			['archive', setRecipeArchived(sql, owner, theirs.id, true)]
		] as const) {
			// not_found, not forbidden: forbidden would confirm it exists.
			expect(await attempt, what).toMatchObject({ ok: false, reason: 'not_found' });
		}
		expect(await ingredientsForRecipe(sql, owner, theirs.id)).toEqual([]);

		// Genuinely untouched, as its owner sees it.
		expect(await getRecipe(sql, partner, theirs.id)).toMatchObject({
			name: 'Secret stew',
			isFavourite: false,
			archivedAt: null
		});
	});

	it('lets both members read a shared recipe but only its owner change it', async () => {
		const theirs = await recipe(
			'Their curry',
			{ visibility: 'household', ownerUserId: partner.userId },
			partner
		);
		expect((await getRecipe(sql, owner, theirs.id))?.name).toBe('Their curry');
		expect(await updateRecipe(sql, owner, theirs.id, { name: 'Our curry' })).toMatchObject({
			ok: false,
			reason: 'forbidden'
		});
		expect(await setRecipeArchived(sql, owner, theirs.id, true)).toMatchObject({ ok: false });
		expect((await getRecipe(sql, partner, theirs.id))?.name).toBe('Their curry');

		ok(await updateRecipe(sql, partner, theirs.id, { name: 'Their best curry' }), 'owner edit');
	});

	it('never lists an ingredient the viewer cannot read, even on a recipe they can', async () => {
		const shared = await recipe('Shared salad');
		const lettuce = ok(await createIngredient(sql, owner, { name: 'Lettuce' }), 'lettuce').record;
		const dressing = ok(
			await createIngredient(sql, partner, { name: 'Secret dressing', ...privateTo(partner) }),
			'dressing'
		).record;
		ok(await addRecipeIngredient(sql, owner, shared.id, lettuce.id, '1 head'), 'link lettuce');
		// Linked by the member who can see it.
		await sql`
			insert into recipe_ingredients (recipe_id, ingredient_id, amount)
			values (${shared.id}::uuid, ${dressing.id}::uuid, '2 tbsp')
		`;

		const names = async (viewer: Viewer) =>
			(await ingredientsForRecipe(sql, viewer, shared.id)).map((i) => i.ingredient.name);
		expect(await names(owner)).toEqual(['Lettuce']);
		expect(await names(partner)).toEqual(['Lettuce', 'Secret dressing']);

		// And on the page itself.
		const page = await loadPage(shared.id);
		expect(page.ingredients).toEqual([
			{ id: lettuce.id, name: 'Lettuce', amount: '1 head', status: 'in_stock' }
		]);
	});

	it('crosses no household boundary', async () => {
		const soup = await recipe('Soup');
		const elsewhere: Viewer = { ...owner, householdId: crypto.randomUUID() };

		expect(await getRecipe(sql, elsewhere, soup.id)).toBeNull();
		expect(await updateRecipe(sql, elsewhere, soup.id, { name: 'Taken' })).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(await setRecipeArchived(sql, elsewhere, soup.id, true)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(await ingredientsForRecipe(sql, elsewhere, soup.id)).toEqual([]);
		expect((await getRecipe(sql, owner, soup.id))?.name).toBe('Soup');
	});
});

// ─── the page ──────────────────────────────────────────────────────────────

describe('the recipe page', () => {
	it('renders the method from Markdown, sanitized, on the server', async () => {
		const soup = await recipe('Soup', {
			notes:
				'## Method\n\n1. Sweat the onion.\n2. Add the stock.\n\n' +
				'<script>alert(1)</script>\n\n' +
				'Serve [with bread](javascript:alert(1)).\n\n' +
				'<img src=x onerror=alert(1)>'
		});
		const page = await loadPage(soup.id);

		// Under the card's own <h2>, not beside it.
		expect(page.instructions).toContain('<h4>Method</h4>');
		expect(page.instructions).toContain('<li>Sweat the onion.</li>');
		expect(page.instructions).not.toMatch(/<script|onerror|href=|<img/);
		expect(page.instructions).toContain('<p>Serve with bread.</p>');
		expect(page.canEdit).toBe(true);
	});

	it('404s another member’s private recipe, and refuses every action on it', async () => {
		const theirs = await recipe('Secret stew', privateTo(partner), partner);

		expect((await thrown(loadPage(theirs.id))).status).toBe(404);
		expect((await thrown(loadPage(theirs.id, partnerUser))).status).toBe(200);

		const save = await act('save', theirs.id, {
			name: 'Mine now',
			updatedAt: theirs.updatedAt.toISOString()
		});
		expect(save.status).toBe(404);
		expect((await act('favourite', theirs.id, { favourite: 'true' })).status).toBe(404);
		expect((await act('made', theirs.id)).status).toBe(404);
		expect((await act('archive', theirs.id, { archived: 'true' })).status).toBe(404);

		expect(await getRecipe(sql, partner, theirs.id)).toMatchObject({
			name: 'Secret stew',
			isFavourite: false,
			lastMadeOn: null,
			archivedAt: null
		});
	});

	it('404s a recipe id that is malformed or from another household', async () => {
		const other = one(
			await sql<{ id: string }[]>`insert into households (name) values ('Next door') returning id`
		);
		const [theirs] = await sql<{ id: string }[]>`
			insert into recipes (household_id, name) values (${other.id}::uuid, 'Their soup')
			returning id
		`;
		expect((await thrown(loadPage(theirs!.id))).status).toBe(404);
		expect((await thrown(loadPage('not-a-uuid'))).status).toBe(404);
		expect((await act('save', theirs!.id, { name: 'Ours' })).status).toBe(404);
	});

	it('saves the edit form, and refuses one rendered before someone else saved', async () => {
		const soup = await recipe('Soup');
		const version = soup.updatedAt.toISOString();

		const saved = await act('save', soup.id, {
			name: 'Leek soup',
			servings: '3',
			prepMinutes: '',
			cookMinutes: '20',
			additionalMinutes: '',
			url: '',
			notes: '# Method\n\n1. Wash the leeks.\n2. Slice them.',
			updatedAt: version
		});
		expect(saved).toEqual({ saved: true });
		// A browser submits a textarea with \r\n; it is stored as the import
		// stores a body, with \n.
		expect(await getRecipe(sql, owner, soup.id)).toMatchObject({
			name: 'Leek soup',
			servings: 3,
			cookMinutes: 20,
			notes: '# Method\n\n1. Wash the leeks.\n2. Slice them.'
		});

		// The same, now-stale version again.
		const stale = await act('save', soup.id, { name: 'Potato soup', updatedAt: version });
		expect(stale.status).toBe(409);
		expect(stale.data).toMatchObject({ action: 'save' });
		expect((await getRecipe(sql, owner, soup.id))?.name).toBe('Leek soup');
	});

	it('marks a favourite and made today on the household’s clock', async () => {
		const soup = await recipe('Soup');
		await act('favourite', soup.id, { favourite: 'true' });
		await act('made', soup.id);

		const today = await householdToday(sql, householdId);
		expect(await getRecipe(sql, owner, soup.id)).toMatchObject({
			isFavourite: true,
			lastMadeOn: today
		});

		await act('favourite', soup.id, { favourite: 'false' });
		expect((await getRecipe(sql, owner, soup.id))?.isFavourite).toBe(false);
	});

	it('archives back to Food HQ', async () => {
		const soup = await recipe('Soup');
		expect(await thrown(act('archive', soup.id, { archived: 'true' }))).toEqual({
			status: 303,
			location: '/food'
		});
		expect((await getRecipe(sql, owner, soup.id))?.archivedAt).not.toBeNull();
	});

	it('does not offer editing to a member who may only read', async () => {
		const theirs = await recipe(
			'Their curry',
			{ visibility: 'household', ownerUserId: partner.userId },
			partner
		);
		expect((await loadPage(theirs.id)).canEdit).toBe(false);
		expect((await act('favourite', theirs.id, { favourite: 'true' })).status).toBe(403);
	});

	it('links a source only when it is a web address', async () => {
		const linked = await recipe('Linked', { url: 'https://cooking.example.com/soup' });
		expect((await loadPage(linked.id)).source).toEqual({
			href: 'https://cooking.example.com/soup',
			label: 'cooking.example.com'
		});

		// What an import can carry, which never passed the repository's check.
		const odd = await recipe('Odd');
		await sql`update recipes set url = 'javascript:alert(1)' where id = ${odd.id}::uuid`;
		expect((await loadPage(odd.id)).source).toEqual({ href: null, label: 'javascript:alert(1)' });
	});

	it('creates a recipe from the new-recipe form and opens it', async () => {
		const action = newRecipeActions.default;
		if (!action) throw new Error('no default action');
		const body = new FormData();
		body.set('name', 'Soda bread');
		body.set('servings', '');
		body.set('notes', '1. Mix.\n2. Bake.');
		const request = new Request('http://localhost/food/recipes/new', { method: 'POST', body });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await thrown(action({ locals: { user: ownerUser }, request } as any));
		const [made] = await listRecipes(sql, owner);
		expect(made).toMatchObject({ name: 'Soda bread', servings: null, notes: '1. Mix.\n2. Bake.' });
		expect(result).toEqual({ status: 303, location: `/food/recipes/${made!.id}` });
	});

	it('refuses a nameless recipe and hands the typed method back', async () => {
		const action = newRecipeActions.default;
		if (!action) throw new Error('no default action');
		const body = new FormData();
		body.set('name', '');
		body.set('notes', 'A long method, typed out on a phone.');
		const request = new Request('http://localhost/food/recipes/new', { method: 'POST', body });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = (await action({ locals: { user: ownerUser }, request } as any)) as {
			status: number;
			data: { values: { notes: string } };
		};
		expect(result.status).toBe(400);
		expect(result.data.values.notes).toBe('A long method, typed out on a phone.');
		expect(await listRecipes(sql, owner)).toEqual([]);
	});
});

// ─── pictures ──────────────────────────────────────────────────────────────

/**
 * An imported page with images in its body, stored the way the importer
 * stores one: the references in `body_images`, and a `body_image` link at the
 * position of each reference it found a file for.
 */
async function importedPage(
	household: string,
	pageId: string,
	references: string[],
	stored: Record<number, string>
) {
	const run = one(
		await sql<{ id: string }[]>`
			insert into import_runs (household_id, status, dry_run, importer_version)
			values (${household}::uuid, 'succeeded', false, 'test') returning id
		`
	);
	const source = one(
		await sql<{ id: string }[]>`
			insert into import_sources (import_run_id, relative_path, kind, sha256, byte_size)
			values (${run.id}::uuid, ${pageId}, 'markdown', decode(md5(${pageId}), 'hex'), 1)
			returning id
		`
	);
	const record = one(
		await sql<{ id: string }[]>`
			insert into source_records (import_run_id, source_id, notion_page_id, database_name,
			                            title, ordinal, raw, body_images)
			values (${run.id}::uuid, ${source.id}::uuid, ${pageId}::uuid, 'Recipes Database',
			        'A recipe', 0, '{}'::text::jsonb, ${references})
			returning id
		`
	);
	const ids: Record<string, string> = {};
	for (const [position, key] of Object.entries(stored)) {
		const attachment = one(
			await sql<{ id: string }[]>`
				insert into attachments (household_id, sha256, byte_size, content_type, width, height,
				                         storage_key)
				values (${household}::uuid, decode(md5(${household + key}), 'hex'), 10, 'image/png',
				        640, 480, ${key})
				returning id
			`
		);
		await sql`
			insert into attachment_links (attachment_id, entity_type, entity_id, role, position)
			values (${attachment.id}::uuid, 'source_record', ${record.id}::uuid, 'body_image',
			        ${Number(position)})
		`;
		ids[key] = attachment.id;
	}
	return ids;
}

describe('pictures in a recipe', () => {
	const PAGE = 'a1b2c3d4-0000-4000-8000-000000000001';

	it('serves a body image the import stored, where the body puts it', async () => {
		const ids = await importedPage(
			householdId,
			PAGE,
			['Soup/pot.png', 'Soup/lost.png', 'https://example.com/remote.png'],
			{ 0: 'aa/pot.png' }
		);
		const soup = await recipe('Soup', {
			notes:
				'Before\n\n![The pot](Soup/pot.png)\n\n![Gone](Soup/lost.png)\n\n' +
				'![Remote](https://example.com/remote.png)\n\nAfter'
		});
		await sql`update recipes set notion_page_id = ${PAGE}::uuid where id = ${soup.id}::uuid`;

		const images = await bodyImagesForPage(sql, owner, PAGE);
		expect([...images.keys()]).toEqual(['Soup/pot.png']);

		const page = await loadPage(soup.id);
		expect(page.instructions).toContain(`src="/api/media/${ids['aa/pot.png']}"`);
		expect(page.instructions).toContain('width="640"');
		expect(page.instructions).not.toContain('lost.png');
		expect(page.instructions).not.toContain('example.com');
		expect(page.instructions.match(/<img/g)).toHaveLength(1);
	});

	it('prefers the display copy of a body image', async () => {
		const ids = await importedPage(householdId, PAGE, ['Soup/pot.png'], { 0: 'bb/pot.png' });
		const [display] = await sql<{ id: string }[]>`
			insert into attachments (household_id, sha256, byte_size, content_type, width, height,
			                         storage_key, variant_of, variant_kind)
			values (${householdId}::uuid, decode(md5('display'), 'hex'), 5, 'image/webp', 640, 480,
			        'bb/pot.webp', ${ids['bb/pot.png']!}::uuid, 'display')
			returning id
		`;
		expect((await bodyImagesForPage(sql, owner, PAGE)).get('Soup/pot.png')?.id).toBe(display!.id);
	});

	it('never resolves an image through another household’s import', async () => {
		const other = one(
			await sql<{ id: string }[]>`insert into households (name) values ('Next door') returning id`
		);
		await importedPage(other.id, PAGE, ['Soup/pot.png'], { 0: 'cc/pot.png' });
		expect(await bodyImagesForPage(sql, owner, PAGE)).toEqual(new Map());
	});

	it('shows the page’s cover at display size', async () => {
		const run = one(
			await sql<{ id: string }[]>`
				insert into import_runs (household_id, status, dry_run, importer_version)
				values (${householdId}::uuid, 'succeeded', false, 'test') returning id
			`
		);
		const source = one(
			await sql<{ id: string }[]>`
				insert into import_sources (import_run_id, relative_path, kind, sha256, byte_size)
				values (${run.id}::uuid, 'cover', 'html', decode(md5('cover'), 'hex'), 1) returning id
			`
		);
		const record = one(
			await sql<{ id: string }[]>`
				insert into source_records (import_run_id, source_id, notion_page_id, database_name,
				                            title, ordinal, raw)
				values (${run.id}::uuid, ${source.id}::uuid, ${PAGE}::uuid, 'Recipes Database',
				        'Soup', 0, '{}'::text::jsonb)
				returning id
			`
		);
		const [cover] = await sql<{ id: string }[]>`
			insert into attachments (household_id, sha256, byte_size, content_type, storage_key)
			values (${householdId}::uuid, decode(md5('c'), 'hex'), 10, 'image/png', 'dd/c.png')
			returning id
		`;
		await sql`
			insert into attachment_links (attachment_id, entity_type, entity_id, role)
			values (${cover!.id}::uuid, 'source_record', ${record.id}::uuid, 'cover')
		`;
		const variant = async (kind: string) =>
			one(
				await sql<{ id: string }[]>`
					insert into attachments (household_id, sha256, byte_size, content_type, storage_key,
					                         variant_of, variant_kind)
					values (${householdId}::uuid, decode(md5(${kind}), 'hex'), 5, 'image/webp',
					        ${'dd/' + kind}, ${cover!.id}::uuid, ${kind})
					returning id
				`
			).id;
		const thumb = await variant('thumb');
		const display = await variant('display');

		expect((await coversForPages(sql, owner, [PAGE])).get(PAGE)?.id).toBe(thumb);
		expect((await coversForPages(sql, owner, [PAGE], 'display')).get(PAGE)?.id).toBe(display);

		const soup = await recipe('Soup');
		await sql`update recipes set notion_page_id = ${PAGE}::uuid where id = ${soup.id}::uuid`;
		expect((await loadPage(soup.id)).cover?.id).toBe(display);
	});
});
