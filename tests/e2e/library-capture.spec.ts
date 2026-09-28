import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * "Everything about a library entry can be done in LifeOS" (PACK1-001): adding
 * an entry, changing its topics, reading its notes as rendered Markdown,
 * linking it to another entry, and archiving it — all from the app, none of
 * it left to editing the database by hand.
 *
 * Seeds an account of its own for the reason health-tags.spec.ts does:
 * borrowing another file's credentials would make this one depend on the
 * order the suite runs in. Its entries and any topic it creates are cleared
 * before each test, so a retry meets a clean library rather than its first
 * attempt's rows — and so a topic name is free to reuse (tags are unique per
 * household by name).
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const PERSON = { username: 'e2e-library-owner', displayName: 'Library Owner', role: 'member' };
const PASSWORD = 'library-spec-password-2026';

/** A topic this spec both creates and attaches; cleared every run so the
 *  household-unique name never collides with a previous attempt. */
const TOPIC_NAME = 'E2E Sample Topic';

/** The narrowest phone the layout is held to. */
const PHONE = { width: 375, height: 812 };

async function query<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

test.beforeAll(async () => {
	await query(async (sql) => {
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
			values (${PERSON.username}, ${PERSON.displayName}, ${PERSON.role}, ${passwordHash}, false)
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
	await query(async (sql) => {
		const [user] = await sql<{ id: string }[]>`
			select id from users where username = ${PERSON.username}
		`;
		if (!user) return;
		// entity_tags has no foreign key onto library_items — it is polymorphic
		// across every taggable table — so it is cleared explicitly rather than
		// relying on a cascade.
		await sql`
			delete from entity_tags
			where entity_type = 'library_item'
			  and entity_id in (select id from library_items where created_by = ${user.id})
		`;
		// library_links cascades from either FK, so removing the items removes
		// their links too.
		await sql`delete from library_items where created_by = ${user.id}`;
		await sql`
			delete from tags
			where name = ${TOPIC_NAME}
			  and household_id in (
			      select household_id from household_members where user_id = ${user.id}
			  )
		`;
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(PERSON.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

test.describe('library capture', () => {
	test.use({ viewport: PHONE });

	test('adds an entry from /library, and its format and link can be edited afterward', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/library');

		await page.getByRole('link', { name: 'New entry' }).click();
		await expect(page).toHaveURL('/library/new');

		await page.getByLabel('Title').fill('A Sample Reference Entry');
		await page.getByLabel('Type').selectOption('reference');
		await page.getByLabel('Format').fill('Website');
		await page.getByLabel('Author').fill('Sample Author');
		await page.getByRole('button', { name: 'Save entry' }).click();

		// createLibraryItem redirects straight to the new entry's own page.
		await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);
		await expect(page.getByRole('heading', { name: 'A Sample Reference Entry' })).toBeVisible();
		await expect(page.getByLabel('Format')).toHaveValue('Website');

		// Format and the link are editable afterward, not only at creation.
		await page.getByLabel('Format').fill('Video');
		await page.getByLabel('Link').fill('https://example.com/sample');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Saved.')).toBeVisible();
		await page.reload();
		await expect(page.getByLabel('Format')).toHaveValue('Video');
		await expect(page.getByLabel('Link')).toHaveValue('https://example.com/sample');
	});

	test('adding to the reading list from /reading lands the entry there, not in the inbox', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/reading');

		await page.getByRole('link', { name: 'Add to reading list' }).click();
		await expect(page).toHaveURL(/\/library\/new\?status=reading_list/);
		// The status picker already reflects where this entry is headed.
		await expect(page.getByLabel('Status')).toHaveValue('reading_list');

		await page.getByLabel('Title').fill('A Book For The Reading List');
		await page.getByRole('button', { name: 'Save entry' }).click();
		await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);

		await page.goto('/reading');
		await expect(page.getByRole('list', { name: 'Nothing on the reading list' })).toContainText(
			'A Book For The Reading List'
		);
	});

	test('creates a topic, attaches it to a second entry, and removes it — twice in a row', async ({
		page
	}) => {
		await signIn(page);

		// The first entry creates the topic in place — the one departure from
		// how tags work on /projects, /goals and /areas, where the picker never
		// creates one.
		await page.goto('/library/new');
		await page.getByLabel('Title').fill('Topic Origin Entry');
		await page.getByRole('button', { name: 'Save entry' }).click();
		await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);

		await page.getByLabel('New topic').fill(TOPIC_NAME);
		await page.getByRole('button', { name: 'Create' }).click();
		await expect(page.getByRole('link', { name: TOPIC_NAME })).toBeVisible();

		// A second entry attaches the now-existing topic from the picker —
		// exercising the Select twice in a row is what would have caught the
		// stale-option bug documented on health/measurements' addFormKey: a
		// naive form reset puts a <Select> back on the option the page was
		// first served with, not on the list the server just sent back.
		await page.goto('/library/new');
		await page.getByLabel('Title').fill('Second Topic Entry');
		await page.getByRole('button', { name: 'Save entry' }).click();
		await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);

		await page.getByLabel('Add a topic').selectOption(TOPIC_NAME);
		// Exact: a name match is a case-insensitive substring by default, and
		// the app shell's "Quick add" button would match "Add" too.
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByRole('link', { name: TOPIC_NAME })).toBeVisible();
		// Attached, so the picker no longer offers it — the household has only
		// the one topic this spec made.
		await expect(page.getByLabel('Add a topic')).toHaveCount(0);

		await page
			.getByRole('button', { name: `Remove topic ${TOPIC_NAME} from Second Topic Entry` })
			.click();
		await expect(page.getByRole('link', { name: TOPIC_NAME })).toHaveCount(0);
		// Removed here, so the picker (now offering it again) is back — a
		// second successful attach in the same visit is the real regression
		// test for the addFormKey-style fix, not just the first one.
		await page.getByLabel('Add a topic').selectOption(TOPIC_NAME);
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByRole('link', { name: TOPIC_NAME })).toBeVisible();
	});

	test('renders notes as sanitized Markdown, while editing stays plain text', async ({ page }) => {
		await signIn(page);
		await page.goto('/library/new');
		await page.getByLabel('Title').fill('Notes Rendering Entry');
		await page.getByRole('button', { name: 'Save entry' }).click();
		await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);

		const markdown = '### A heading\n\nSome **bold** text and a list:\n\n- one\n- two';
		await page.getByLabel('Notes').fill(markdown);
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Saved.')).toBeVisible();

		// Rendered, sanitized HTML in the Notes card — not the raw characters.
		const prose = page.locator('.prose');
		await expect(prose.getByRole('heading', { name: 'A heading' })).toBeVisible();
		await expect(prose.locator('strong')).toHaveText('bold');
		await expect(prose.locator('li')).toHaveCount(2);
		await expect(page.locator('.prose')).not.toContainText('###');

		// The edit form underneath still holds plain Markdown, unrendered.
		await expect(page.getByLabel('Notes')).toHaveValue(markdown);
	});

	test('links two entries, shows the link on both pages, and removes it', async ({ page }) => {
		await signIn(page);

		await page.goto('/library/new');
		await page.getByLabel('Title').fill('Link Origin Entry');
		await page.getByRole('button', { name: 'Save entry' }).click();
		await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);
		const originUrl = page.url();

		await page.goto('/library/new');
		await page.getByLabel('Title').fill('Link Target Entry');
		await page.getByRole('button', { name: 'Save entry' }).click();
		await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);

		await page.goto(originUrl);
		await page.getByLabel('Link to another entry').selectOption('Link Target Entry');
		await page.getByRole('button', { name: 'Link' }).click();
		await expect(page.getByRole('link', { name: 'Link Target Entry', exact: true })).toBeVisible();

		// The same edge, read from the other end — a library link has no
		// direction, unlike a task dependency.
		await page.getByRole('link', { name: 'Link Target Entry', exact: true }).click();
		await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);
		await expect(page.getByRole('heading', { name: 'Link Target Entry' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Link Origin Entry', exact: true })).toBeVisible();

		await page.getByRole('button', { name: 'Remove the link to Link Origin Entry' }).click();
		await expect(page.getByText('Nothing linked yet')).toBeVisible();

		await page.goto(originUrl);
		await expect(page.getByText('Nothing linked yet')).toBeVisible();
	});

	test('archiving takes an entry off the library, and restoring brings it back', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/library/new');
		await page.getByLabel('Title').fill('Entry To Archive');
		await page.getByRole('button', { name: 'Save entry' }).click();
		await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);
		const entryUrl = page.url();

		await page.getByRole('button', { name: 'Archive entry' }).click();
		await expect(page).toHaveURL('/library');
		await expect(page.getByText('Entry To Archive')).toHaveCount(0);

		// Still reachable directly, and can be brought back — recoverable the
		// same way as everywhere else in LifeOS.
		await page.goto(entryUrl);
		await expect(page.getByRole('heading', { name: 'Entry To Archive' })).toBeVisible();
		await expect(page.getByText('Archived', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Restore entry' }).click();
		await expect(page.getByText('Restored. It is back in the library.')).toBeVisible();

		await page.goto('/library');
		await expect(page.getByText('Entry To Archive')).toBeVisible();
	});
});
