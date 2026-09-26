import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * The pages wired in this pass: search, inbox, brain dump, review, archive,
 * topics, dashboard and system.
 *
 * These run against the real adapter-node build rather than `src/`, which is
 * the only place three previous bugs in this repo were visible: the tests
 * imported the source, production ran the bundle, and a driver helper behaved
 * differently there. Every page here is therefore *loaded*, not just unit
 * tested — a load function that throws in the bundle is a blank screen no
 * integration test would catch.
 */

const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-workspace-owner', displayName: 'Workspace Owner', role: 'admin' };
const PASSWORD = 'workspace-spec-password-2026';

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

test.beforeAll(async () => {
	await withDb(async (sql) => {
		const passwordHash = await hashPassword(PASSWORD);
		const existing = await sql<
			{ id: string }[]
		>`select id from households order by created_at limit 1`;
		const householdId =
			existing[0]?.id ??
			(
				await sql<{ id: string }[]>`
					insert into households (name) values ('Household') returning id
				`
			)[0]!.id;

		const [user] = await sql<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash, must_change_credentials)
			values (${USER.username}, ${USER.displayName}, ${USER.role}, ${passwordHash}, false)
			on conflict (username) where username is not null do update set
				password_hash = excluded.password_hash,
				must_change_credentials = false,
				disabled_at = null,
				failed_login_count = 0,
				locked_until = null
			returning id
		`;
		await sql`
			insert into household_members (household_id, user_id)
			values (${householdId}, ${user!.id})
			on conflict do nothing
		`;
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

/** Unique per call: Playwright retries, and a fixed name would then exist twice. */
const unique = (prefix: string) => `${prefix} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

test('every wired page loads in the built app', async ({ page }) => {
	await signIn(page);

	const pages: [string, string][] = [
		['/search', 'Search'],
		['/inbox', 'Quick Drop | Inbox'],
		['/brain-dump', 'Brain Dump'],
		['/review', 'For Review'],
		['/archive', 'Archive'],
		['/topics', 'Topics & Resources'],
		['/dashboard', 'Master Dashboards'],
		['/system', 'System'],
		['/health', 'Health & Fitness'],
		['/food', 'Food HQ'],
		['/library', 'Library'],
		['/reading', 'Reading Tracker'],
		['/knowledge', 'Knowledge Hub'],
		['/people', 'People & Places'],
		['/wishlist', 'Wishlist'],
		['/entertainment', 'Entertainment'],
		['/finance', 'Financial Hub'],
		['/perspectives', 'Perspectives'],
		['/yearly-review', 'Reflect & Reset'],
		['/store', 'Etsy Store'],
		['/content', 'Content Creation']
	];

	for (const [path, heading] of pages) {
		await page.goto(path);
		await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
	}
});

test('the old tags URL still reaches the topics page', async ({ page }) => {
	await signIn(page);
	// A 308: bookmarks and the household's own links must not break.
	await page.goto('/areas/tags');
	await expect(page).toHaveURL('/topics');
	await expect(page.getByRole('heading', { name: 'Topics & Resources', level: 1 })).toBeVisible();
});

test('the bin is the archive filtered to tasks', async ({ page }) => {
	await signIn(page);
	await page.goto('/bin');
	await expect(page).toHaveURL('/archive?kind=task');
});

test('capture, triage and restore make a full round trip', async ({ page }) => {
	await signIn(page);
	const title = unique('Sort me out');

	// Capture.
	await page.goto('/inbox');
	await page.getByLabel('What is on your mind?').fill(title);
	await page.getByRole('button', { name: 'Drop it in' }).click();
	await expect(page.getByRole('link', { name: title })).toBeVisible();

	// It counts as open work, so it is not swallowed by the capture box.
	await page.goto('/tasks?view=open');
	await expect(page.getByRole('link', { name: title })).toBeVisible();

	// Triage out of the inbox.
	await page.goto('/inbox');
	const row = page.locator('li').filter({ hasText: title });
	await row.getByRole('button', { name: `File ${title}` }).click();
	await expect(page.getByRole('link', { name: title })).toBeHidden();

	// Archive it from the task page, then bring it back from the archive.
	await page.goto('/tasks?view=open');
	await page.getByRole('link', { name: title }).click();
	await page.getByRole('button', { name: 'Archive task' }).click();
	// Archiving is a removal from view, so the action redirects back to the
	// list. Waiting for that is also what stops the navigation below racing
	// the POST.
	await expect(page).toHaveURL('/tasks');

	await page.goto('/archive?kind=task');
	const archived = page.locator('li').filter({ hasText: title });
	await expect(archived).toBeVisible();
	await archived.getByRole('button', { name: `Restore ${title}` }).click();
	await expect(page.locator('li').filter({ hasText: title })).toBeHidden();

	await page.goto('/tasks?view=open');
	await expect(page.getByRole('link', { name: title })).toBeVisible();
});

test('a brain dump becomes one inbox item per line', async ({ page }) => {
	await signIn(page);
	const stamp = Date.now();
	const lines = [`dentist ${stamp}`, `- book ${stamp}`, `hall light ${stamp}`];

	await page.goto('/brain-dump');
	await page.getByLabel('Everything on your mind').fill(lines.join('\n'));
	await page.getByRole('button', { name: 'Drop it all in' }).click();

	await expect(page.getByRole('status')).toContainText('3 dropped into the inbox');

	await page.goto('/inbox');
	await expect(page.getByRole('link', { name: `dentist ${stamp}` })).toBeVisible();
	// The bullet is stripped rather than becoming part of the title.
	await expect(page.getByRole('link', { name: `book ${stamp}`, exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: `hall light ${stamp}` })).toBeVisible();
});

test('search finds a captured task and links to it', async ({ page }) => {
	await signIn(page);
	const word = `zeppelin${Date.now()}`;

	await page.goto('/inbox');
	await page.getByLabel('What is on your mind?').fill(`Buy ${word} tickets`);
	await page.getByRole('button', { name: 'Drop it in' }).click();
	// Wait for the row before touching the database: the submit is an enhanced
	// POST, so without this the update below races it and silently updates
	// nothing.
	await expect(page.getByRole('link', { name: `Buy ${word} tickets` })).toBeVisible();

	// The excerpt is built from the body, so a task whose only text is its
	// title correctly has none — the title is already on the row. Give it a
	// note so the «…» markers actually have something to mark.
	await withDb(async (sql) => {
		await sql`update tasks set notes = ${`Standing in the rain for ${word} again`}
		          where title = ${`Buy ${word} tickets`}`;
	});

	await page.goto('/search');
	await page.getByRole('searchbox', { name: 'Search' }).fill(word);
	await page.getByRole('button', { name: 'Search' }).click();

	await expect(page.getByRole('link', { name: `Buy ${word} tickets` })).toBeVisible();
	// The excerpt renders the match as a <mark>, not as literal « » markers.
	await expect(page.locator('mark')).toContainText(word);
	await expect(page.getByText('«')).toBeHidden();
});

test('a review falls due, and marking it clears the queue', async ({ page }) => {
	await signIn(page);
	const name = unique('Reviewable area');

	await page.goto('/areas');
	await page.getByLabel('New area').fill(name);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	// Same as above: wait for the row before reaching into the database.
	await expect(page.getByRole('link', { name })).toBeVisible();

	// An area with a cadence and no review yet is due today, not never.
	await withDb(async (sql) => {
		await sql`update areas set review_every_days = 30 where name = ${name}`;
	});

	await page.goto('/review');
	const row = page.locator('li').filter({ hasText: name });
	await expect(row).toContainText('Never reviewed');

	await row.getByRole('button', { name: `Mark ${name} reviewed` }).click();
	await expect(page.locator('li').filter({ hasText: name })).toBeHidden();
});

test('a health term can be added and starts showing up', async ({ page }) => {
	await signIn(page);
	const name = unique('Wobbliness');

	// The vocabulary lives at /health/symptoms since /health became the hub;
	// the old address still lands here, which is worth proving on the way in.
	await page.goto('/health?kind=symptom');
	await expect(page).toHaveURL(/\/health\/symptoms\?kind=symptom$/);
	await page.getByLabel('New symptom').fill(name);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByText(name, { exact: true })).toBeVisible();

	// The chip count is derived, so it moving is what proves the write landed
	// rather than the word merely being echoed back into the form.
	// "Symptoms" followed by its count: the filter chip, not the
	// "Symptoms & mood" tab in the health sub-navigation.
	const chip = page.getByRole('link', { name: /^Symptoms \d/ });
	await expect(chip).toContainText(/[1-9]/);
});
