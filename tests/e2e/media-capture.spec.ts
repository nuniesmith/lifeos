import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * The watchlist end to end (PACK5-001): adding a title, editing it fully,
 * logging a viewing, archiving/restoring it, and "what should we watch?".
 *
 * Seeds an account of its own for the reason health-tags.spec.ts and
 * recipes.spec.ts do: borrowing another file's credentials would make this
 * one depend on run order. Every title this file seeds or creates carries
 * the same name prefix, so `beforeEach` can clear exactly its own rows
 * without touching another spec's data in the shared household.
 */

const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-media-owner', displayName: 'Media Owner', role: 'member' };
const PASSWORD = 'media-spec-password-2026';
const PHONE = { width: 375, height: 812 };
const PREFIX = 'E2E Media ';

/** A name unique to this attempt, so a retry never finds its first run's title. */
const attempt = (name: string) => {
	const retry = test.info().retry;
	return retry === 0 ? name : `${name} ${retry}`;
};

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

const firstHousehold = async (sql: postgres.Sql) =>
	(await sql<{ id: string }[]>`select id from households order by created_at limit 1`)[0]!.id;

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

test.beforeEach(async () => {
	await withDb(async (sql) => {
		await sql`
			delete from media_viewings
			where media_item_id in (select id from media_items where name like ${PREFIX + '%'})
		`;
		await sql`delete from media_items where name like ${PREFIX + '%'}`;
	});
});

/** A title seeded directly, the way the picker's candidates need to exist
 *  before the page that suggests them is ever opened. */
async function seedTitle(name: string, status = 'want_to_watch') {
	await withDb(async (sql) => {
		const householdId = await firstHousehold(sql);
		await sql`
			insert into media_items (household_id, name, media_type, status)
			values (${householdId}::uuid, ${name}, 'movie', ${status})
		`;
	});
}

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

test.describe('the watchlist on a phone', () => {
	test.use({ viewport: PHONE });

	test('adds a title, edits it fully, logs a viewing, and archives/restores it', async ({
		page
	}) => {
		const name = attempt(`${PREFIX}Alpha`);

		await signIn(page);
		await page.goto('/entertainment');
		await page.getByRole('link', { name: 'New title', exact: true }).click();
		await expect(page).toHaveURL('/entertainment/new');

		// Feature 1: only a name is required, but this one takes the optional
		// fields too.
		// By role, not by label: Field puts an aria-hidden "*" inside a required
		// field's <label>, so the label's text is "Name *" and an exact
		// getByLabel('Name') never matches, while the accessible name is "Name".
		await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
		await page.getByLabel('Type', { exact: true }).selectOption('tv');
		await page.getByLabel('Streaming service', { exact: true }).fill('Testflix');
		await page.getByRole('button', { name: 'Save title', exact: true }).click();

		await expect(page).toHaveURL(/\/entertainment\/[0-9a-f-]{36}$/);
		await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

		// Feature 2: the full edit -- progress, rating, favourite, watch again,
		// why saved.
		const editor = page.locator('form[action="?/save"]');
		await editor.getByLabel('Genre', { exact: true }).fill('Comedy');
		await editor.getByLabel('Current season', { exact: true }).fill('1');
		await editor.getByLabel('Current episode', { exact: true }).fill('3');
		await editor.getByLabel('Rating', { exact: true }).selectOption('4');
		await editor.getByLabel('Why saved', { exact: true }).fill('a placeholder reason');
		await editor.getByLabel('Favourite', { exact: true }).check();
		await editor.getByLabel('Watch again', { exact: true }).check();
		await editor.getByRole('button', { name: 'Save title', exact: true }).click();
		await expect(editor.getByRole('status')).toHaveText('Saved.');

		// Reloaded from the database, not just from what the form still holds.
		await page.reload();
		await expect(page.getByLabel('Genre', { exact: true })).toHaveValue('Comedy');
		await expect(page.getByLabel('Current episode', { exact: true })).toHaveValue('3');
		await expect(page.getByLabel('Favourite', { exact: true })).toBeChecked();
		await expect(page.getByLabel('Watch again', { exact: true })).toBeChecked();

		// Feature 3: logging a viewing updates times_watched and the history.
		const logForm = page.locator('form[action="?/logViewing"]');
		await logForm.getByLabel('Note', { exact: true }).fill('a placeholder note');
		await logForm.getByRole('button', { name: 'Log a viewing', exact: true }).click();
		await expect(logForm.getByRole('status')).toHaveText('Logged.');
		await expect(page.getByText('watched 1×')).toBeVisible();
		await expect(page.getByText('a placeholder note')).toBeVisible();

		// A second viewing adds to the count rather than replacing it.
		await logForm.getByRole('button', { name: 'Log a viewing', exact: true }).click();
		await expect(page.getByText('watched 2×')).toBeVisible();

		// Archiving and restoring, from the title's own page.
		await page.getByRole('button', { name: 'Archive title', exact: true }).click();
		await expect(
			page.getByText('Archived. It is off Entertainment and waiting in the Archive.')
		).toBeVisible();
		const restore = page.getByRole('button', { name: 'Restore title', exact: true });
		await expect(restore).toBeVisible();
		await restore.click();
		await expect(page.getByText('Restored.', { exact: true })).toBeVisible();
	});

	test('"what should we watch?" suggests something unwatched and links to it', async ({ page }) => {
		const nameA = attempt(`${PREFIX}Pick One`);
		const nameB = attempt(`${PREFIX}Pick Two`);
		await seedTitle(nameA);
		await seedTitle(nameB);
		// Not a candidate: already watching, so it must never be suggested.
		await seedTitle(attempt(`${PREFIX}Pick Started`), 'watching');

		await signIn(page);
		await page.goto('/entertainment/pick');

		const suggestionName = page.locator('.name');
		await expect(suggestionName).toBeVisible();
		const first = (await suggestionName.textContent())?.trim();
		expect([nameA, nameB]).toContain(first);

		// "Another" re-rolls; either candidate is a valid answer both times.
		await page.getByRole('button', { name: 'Another', exact: true }).click();
		await expect(suggestionName).toBeVisible();
		const second = (await suggestionName.textContent())?.trim();
		expect([nameA, nameB]).toContain(second);

		await page.getByRole('link', { name: 'Open title', exact: true }).click();
		await expect(page).toHaveURL(/\/entertainment\/[0-9a-f-]{36}$/);
		const opened = await page.getByRole('heading', { level: 1 }).textContent();
		expect([nameA, nameB]).toContain(opened?.trim());
	});
});
