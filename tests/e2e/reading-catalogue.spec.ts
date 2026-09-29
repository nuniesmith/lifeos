import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * The Reading Tracker's book catalogue (Reading Tracker R1): adding a book
 * from the home page's quick form and from its own full page, editing every
 * kind of field (including a `<Select>`, which must show what was just saved
 * rather than reverting — hard rule 5), moving between the home page's three
 * lists as status changes, filtering the catalogue from a genre link, and
 * renaming/archiving a genre inline.
 *
 * Seeds an account of its own for the reason library-capture.spec.ts does:
 * borrowing another file's credentials would make this one depend on the
 * order the suite runs in. Its books, authors, series and genres are cleared
 * before each test, so a retry meets a clean catalogue rather than its first
 * attempt's rows — and so a household-unique name (author, series, genre) is
 * free to reuse.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const PERSON = { username: 'e2e-reading-owner', displayName: 'Reading Owner', role: 'member' };
const PASSWORD = 'reading-spec-password-2026';

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
		// book_authors/book_genres cascade from books, authors and genres, so
		// clearing the four tables this spec writes to is enough.
		await sql`delete from books where created_by = ${user.id}`;
		await sql`delete from authors where created_by = ${user.id}`;
		await sql`delete from book_series where created_by = ${user.id}`;
		await sql`delete from genres where created_by = ${user.id}`;
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(PERSON.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

test.describe('reading catalogue', () => {
	test.use({ viewport: PHONE });

	test('adds a book from the home page’s quick form, landing on the TBR', async ({ page }) => {
		await signIn(page);
		await page.goto('/reading');

		await page.getByRole('textbox', { name: 'Title', exact: true }).fill('The Quick Add Sample');
		await page.getByLabel('Author').fill('Fictional Author');
		await page.getByRole('button', { name: 'Add book', exact: true }).click();

		const upNext = page.getByRole('region', { name: 'Up next' });
		await expect(upNext.getByRole('link', { name: 'The Quick Add Sample' })).toBeVisible();

		await upNext.getByRole('link', { name: 'The Quick Add Sample' }).click();
		await expect(page).toHaveURL(/\/reading\/books\/[0-9a-f-]+$/);
		await expect(
			page.getByRole('heading', { name: 'The Quick Add Sample', level: 1 })
		).toBeVisible();
		await expect(page.getByLabel('Status')).toHaveValue('tbr');
		await expect(page.getByRole('link', { name: 'Fictional Author' })).toBeVisible();
	});

	test('creates a book with a series, authors and genres, and a Select shows what was just saved', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/reading/books/new');

		// "Title" and "Series" both need `exact: true`: "Subtitle" and
		// "Position in series" would otherwise also match as substrings.
		await page.getByRole('textbox', { name: 'Title', exact: true }).fill('The Sample Saga');
		await page.getByLabel('Subtitle').fill('A Fictional Tale');
		await page.getByLabel('Series', { exact: true }).fill('The Sample Chronicles');
		await page.getByLabel('Position in series').fill('1');
		await page.getByLabel('Authors').fill('Fictional Author, Second Author');
		await page.getByLabel('Genres').fill('Speculative Fiction');
		await page.getByLabel('Status').selectOption('reading');
		await page.getByLabel('Rating').selectOption('3.75');
		await page.getByLabel('Owned').check();

		await page.getByRole('button', { name: 'Save book' }).click();
		await expect(page).toHaveURL(/\/reading\/books\/[0-9a-f-]+$/);
		await expect(page.getByRole('heading', { name: 'The Sample Saga', level: 1 })).toBeVisible();

		// Authors, series and genres were found-or-created and linked; the
		// series link carries its position ("#1"), so this is a substring match
		// rather than an exact one.
		await expect(page.getByRole('link', { name: 'Fictional Author' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Second Author' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'The Sample Chronicles' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Speculative Fiction' })).toBeVisible();

		await expect(page.getByLabel('Status')).toHaveValue('reading');
		await expect(page.getByLabel('Rating')).toHaveValue('3.75');
		await expect(page.getByLabel('Owned')).toBeChecked();

		// Changing the Select and saving again must show 'paused' afterward,
		// not revert to 'reading' — the exact failure a plain form reset (or a
		// redraw seeded from stale data) would cause (hard rule 5).
		await page.getByLabel('Status').selectOption('paused');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Saved.')).toBeVisible();
		await expect(page.getByLabel('Status')).toHaveValue('paused');
		await page.reload();
		await expect(page.getByLabel('Status')).toHaveValue('paused');
	});

	test('moves a book between the home page’s lists as its status changes', async ({ page }) => {
		await signIn(page);
		await page.goto('/reading');

		await page.getByRole('textbox', { name: 'Title', exact: true }).fill('The Status Sample');
		await page.getByLabel('Author').fill('Fictional Author');
		await page.getByRole('button', { name: 'Add book', exact: true }).click();

		const upNext = page.getByRole('region', { name: 'Up next' });
		await expect(upNext.getByRole('link', { name: 'The Status Sample' })).toBeVisible();

		await upNext.getByRole('link', { name: 'The Status Sample' }).click();
		await page.getByLabel('Status').selectOption('reading');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Saved.')).toBeVisible();

		await page.goto('/reading');
		await expect(
			page.getByRole('region', { name: 'Currently reading' }).getByRole('link', {
				name: 'The Status Sample'
			})
		).toBeVisible();
		// Not `not.toContainText`, which an empty-state swap can make pass for
		// the wrong reason: asserting the empty state's own text is the
		// positive form of "nothing is there any more".
		await expect(page.getByRole('region', { name: 'Up next' })).toContainText(
			'Nothing on the TBR yet'
		);
	});

	test('filters the catalogue from a genre link, and archives the book from its own page', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/reading/books/new');
		await page.getByRole('textbox', { name: 'Title', exact: true }).fill('The Genre Sample');
		await page.getByLabel('Genres').fill('Cozy Mystery');
		await page.getByRole('button', { name: 'Save book' }).click();
		await expect(page).toHaveURL(/\/reading\/books\/[0-9a-f-]+$/);

		await page.getByRole('link', { name: 'Cozy Mystery' }).click();
		await expect(page).toHaveURL(/\/reading\/books\?genre=[0-9a-f-]+$/);
		await expect(page.getByText('Filtered by')).toContainText('Cozy Mystery');
		await expect(page.getByRole('link', { name: 'The Genre Sample' })).toBeVisible();

		await page.getByRole('link', { name: 'The Genre Sample' }).click();
		await page.getByRole('button', { name: 'Archive book' }).click();
		await expect(page).toHaveURL('/reading/books');
		// The positive form of "it is gone": archiving the only book leaves the
		// unfiltered catalogue's own empty state, rather than asserting the
		// title's absence on a list an empty state may have replaced.
		await expect(page.getByText('No books yet')).toBeVisible();
	});

	test('renames and archives a genre inline, from its own list', async ({ page }) => {
		await signIn(page);
		await page.goto('/reading/books/new');
		await page.getByRole('textbox', { name: 'Title', exact: true }).fill('The Inline Sample');
		await page.getByLabel('Genres').fill('Cozy Mystery');
		await page.getByRole('button', { name: 'Save book' }).click();
		await expect(page).toHaveURL(/\/reading\/books\/[0-9a-f-]+$/);

		await page.goto('/reading/genres');
		await page.getByRole('textbox', { name: 'Rename Cozy Mystery' }).fill('Cosy Mystery');
		await page.getByRole('button', { name: 'Rename Cozy Mystery' }).click();
		await expect(page.getByRole('textbox', { name: 'Rename Cosy Mystery' })).toHaveValue(
			'Cosy Mystery'
		);

		await page.getByRole('button', { name: 'Archive Cosy Mystery' }).click();
		await expect(page.getByText('No genres yet')).toBeVisible();
	});
});
