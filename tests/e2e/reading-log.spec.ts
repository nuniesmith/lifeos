import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * The reading log (Reading Tracker R2; migration 0033): starting, tracking,
 * pausing/resuming and finishing a read, DNF, the TBR picker, and the series
 * hub's per-viewer "next up". The book catalogue itself (adding a book,
 * editing every field, the home page's TBR/library sections) is
 * reading-catalogue.spec.ts's job, not this file's.
 *
 * Seeds an account of its own for the reason reading-catalogue.spec.ts does:
 * borrowing another file's credentials would make this one depend on the
 * order the suite runs in. Every book this spec's account created (and, by
 * cascade, its reads) is cleared before each test, so a retry meets a clean
 * catalogue rather than its first attempt's rows.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const PERSON = { username: 'e2e-readlog-owner', displayName: 'Readlog Owner', role: 'member' };
const PASSWORD = 'reading-log-spec-password-2026';

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
		// book_reads/book_authors/book_genres all cascade from books, and
		// authors/genres/book_series carry no dependency on each other.
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

/** Adds a book from its own full page and lands on it — every field this
 *  spec's tests need (pages, series, genres) lives there, not on the home
 *  page's title+author quick form. */
async function addBook(
	page: Page,
	title: string,
	options: { pages?: number; series?: string; position?: string; genre?: string } = {}
) {
	await page.goto('/reading/books/new');
	// "Title" and "Series" both need exact: true: "Subtitle" and "Position in
	// series" would otherwise also match as substrings (reading-catalogue.
	// spec.ts's own note).
	await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
	if (options.pages !== undefined) {
		await page.getByLabel('Pages').fill(String(options.pages));
	}
	if (options.series) {
		await page.getByLabel('Series', { exact: true }).fill(options.series);
		await page.getByLabel('Position in series').fill(options.position ?? '1');
	}
	if (options.genre) {
		await page.getByLabel('Genres').fill(options.genre);
	}
	await page.getByRole('button', { name: 'Save book' }).click();
	await expect(page).toHaveURL(/\/reading\/books\/[0-9a-f-]+$/);
	await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

test.describe('the reading log', () => {
	test.use({ viewport: PHONE });

	test('starts, tracks progress, pauses, resumes and finishes a read', async ({ page }) => {
		await signIn(page);
		await addBook(page, 'The Cycle Sample', { pages: 300 });

		await page.getByRole('button', { name: 'Start reading', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

		await page.getByRole('spinbutton', { name: 'Pages read' }).fill('150');
		await page.getByRole('button', { name: 'Save progress', exact: true }).click();
		await expect(page.getByRole('spinbutton', { name: 'Pages read' })).toHaveValue('150');

		await page.getByRole('button', { name: 'Pause', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Resume', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

		await page.getByRole('button', { name: 'Finish', exact: true }).click();
		// Not "Rating": the book's own catalogue rating (BookFields.svelte)
		// uses that exact label on this same page, so this read's own rating
		// is labelled distinctly.
		await page.getByLabel('Rating for this read').selectOption('4');
		await page.getByLabel('Review').fill('A satisfying read.');
		await page.getByRole('button', { name: 'Finish reading', exact: true }).click();

		// Finishing clears the open read: "Start reading" is back, this time
		// for a possible reread, and the count shows the first one landed.
		await expect(page.getByRole('button', { name: 'Start reading', exact: true })).toBeVisible();
		await expect(page.getByText('Read 1 time.', { exact: true })).toBeVisible();

		await page.goto('/reading');
		await expect(page.getByRole('region', { name: 'Currently reading' })).toContainText(
			'Nothing being read right now'
		);
		await expect(
			page
				.getByRole('region', { name: 'Recently read' })
				.getByRole('link', { name: 'The Cycle Sample' })
		).toBeVisible();
	});

	test('DNFs a read, with a reason, and it does not count as a finish', async ({ page }) => {
		await signIn(page);
		await addBook(page, 'The Abandoned Sample');

		await page.getByRole('button', { name: 'Start reading', exact: true }).click();
		await page.getByRole('button', { name: 'DNF', exact: true }).click();
		await page.getByLabel('Why did you stop? (optional)').fill('Not for me right now.');
		await page.getByRole('button', { name: 'Mark as DNF', exact: true }).click();

		await expect(page.getByRole('button', { name: 'Start reading', exact: true })).toBeVisible();
		// Not "Read N times": a DNF is not a finish, so the count never
		// appears at all rather than reading "Read 0 times".
		await expect(page.getByText(/^Read \d+ times?\.$/)).toHaveCount(0);

		await expect(page.getByRole('heading', { name: 'Read history', exact: true })).toBeVisible();
		// A substring match, not exact: the history row's meta line joins
		// dates and format with this word ("Started … · DNF"), so the row's
		// own text node is never *only* "DNF".
		await expect(page.getByText(/DNF/)).toBeVisible();

		await page.goto('/reading');
		await expect(page.getByRole('region', { name: 'Currently reading' })).toContainText(
			'Nothing being read right now'
		);
	});

	test('the TBR picker suggests the one book on the pile', async ({ page }) => {
		await signIn(page);
		await addBook(page, 'The Only TBR Sample', { genre: 'Cozy Mystery' });

		await page.goto('/reading/tbr');
		await expect(page.getByRole('link', { name: 'The Only TBR Sample' })).toBeVisible();

		// The suggestion's own name is a plain paragraph, not a link (unlike
		// the list row above it), and scoping to the paragraph's own class
		// avoids the title's second, linked occurrence in the list below — a
		// bare getByText would match both and fail strict mode.
		const suggestionName = page.locator('p.name');
		await expect(suggestionName).toHaveText('The Only TBR Sample');
		// With exactly one book on the pile, "Another" can only ever
		// re-suggest that same one.
		await page.getByRole('button', { name: 'Another', exact: true }).click();
		await expect(suggestionName).toHaveText('The Only TBR Sample');
	});

	test('the series hub highlights next up and counts the viewer’s own progress', async ({
		page
	}) => {
		await signIn(page);
		await addBook(page, 'The Series Sample One', {
			series: 'The Fictional Duology',
			position: '1'
		});

		// Finish book one before book two exists at all, so the series page
		// below shows exactly one book read and the other one still open —
		// starting and finishing this once book two also exists would finish
		// whichever book the "Start reading"/"Finish" buttons apply to at
		// that moment, which is not what this test means to prove.
		await page.getByRole('button', { name: 'Start reading', exact: true }).click();
		await page.getByRole('button', { name: 'Finish', exact: true }).click();
		await page.getByRole('button', { name: 'Finish reading', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Start reading', exact: true })).toBeVisible();

		await addBook(page, 'The Series Sample Two', {
			series: 'The Fictional Duology',
			position: '2'
		});
		// The series badge carries its position suffix ("#2" on this, book
		// two's own page — found-or-created by name, so it is the same series
		// book one named above as "#1").
		await page.getByRole('link', { name: 'The Fictional Duology #2', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'The Fictional Duology', level: 1 })
		).toBeVisible();

		const firstRow = page.getByRole('link', { name: 'The Series Sample One', exact: true });
		const secondRow = page.getByRole('link', { name: 'The Series Sample Two', exact: true });
		await expect(firstRow).toBeVisible();
		await expect(secondRow).toBeVisible();
		// "Next up" sits in the same row as the still-unread second book, not
		// the one the viewer already finished.
		await expect(
			secondRow.locator('xpath=ancestor::li[1]').getByText('Next up', { exact: true })
		).toBeVisible();
		await expect(
			firstRow.locator('xpath=ancestor::li[1]').getByText('Next up', { exact: true })
		).toHaveCount(0);

		await page.goto('/reading/series');
		await expect(page.getByText('1 of 2 read', { exact: true })).toBeVisible();
	});
});
