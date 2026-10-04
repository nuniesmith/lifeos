import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Reading challenges and Reading Insights (Reading Tracker R3; migration
 * 0035): a count challenge's progress against a finished book, a prompts
 * challenge's prompt list (add, fill, clear, reorder), and the Insights
 * page's year totals.
 *
 * Seeds an account of its own for the reason reading-log.spec.ts's does:
 * borrowing another file's credentials would make this one depend on the
 * order the suite runs in. Every e2e user shares one household, so another
 * spec's household-visible books and challenges can sit alongside this
 * spec's own — every title and prompt below is prefixed uniquely to this
 * file, and every assertion is scoped to a specific row or region rather
 * than to "the only" one on a list (reading-log.spec.ts's own TBR-picker
 * lesson). Insights and a book's own reads are per-reader, though, so this
 * spec's own finished-count totals cannot be inflated by another spec's
 * different seeded user.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const PERSON = {
	username: 'e2e-challenges-owner',
	displayName: 'Challenges Owner',
	role: 'member'
};
const PASSWORD = 'reading-challenges-spec-password-2026';

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
		// reading_challenge_items cascades from reading_challenges; book_reads/
		// book_authors/book_genres all cascade from books, the same as
		// reading-log.spec.ts's own cleanup.
		await sql`delete from reading_challenges where created_by = ${user.id}`;
		await sql`delete from books where created_by = ${user.id}`;
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(PERSON.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

/** Adds a book from its own full page and lands on it. */
async function addBook(page: Page, title: string) {
	await page.goto('/reading/books/new');
	// Exact: true, the same reason reading-log.spec.ts's own addBook needs
	// it: "Subtitle" would otherwise also match "Title" as a substring.
	await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
	await page.getByRole('button', { name: 'Save book' }).click();
	await expect(page).toHaveURL(/\/reading\/books\/[0-9a-f-]+$/);
	await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

/** Starts and immediately finishes a read of the book already on screen, so
 *  it counts toward a count challenge or this year's Insights. */
async function finishBook(page: Page) {
	await page.getByRole('button', { name: 'Start reading', exact: true }).click();
	await page.getByRole('button', { name: 'Finish', exact: true }).click();
	await page.getByRole('button', { name: 'Finish reading', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Start reading', exact: true })).toBeVisible();
}

/** Adds a challenge from the list page's quick-add form and opens it. */
async function addChallenge(
	page: Page,
	title: string,
	options: { kind?: 'count' | 'prompts'; targetCount?: string } = {}
) {
	await page.goto('/reading/challenges');
	await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
	if (options.kind === 'prompts') {
		await page
			.getByLabel('Kind', { exact: true })
			.selectOption({ label: 'Prompts — a sheet to fill' });
	}
	if (options.targetCount) {
		await page
			.getByRole('spinbutton', { name: 'Target (for a count challenge)', exact: true })
			.fill(options.targetCount);
	}
	await page.getByRole('button', { name: 'Add challenge', exact: true }).click();
	await page.getByRole('link', { name: title, exact: true }).click();
	await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

test.describe('reading challenges', () => {
	test.use({ viewport: PHONE });

	test('a count challenge shows progress once a book is finished', async ({ page }) => {
		await signIn(page);
		await addBook(page, 'R3 E2E Count Progress Book');
		await finishBook(page);

		await addChallenge(page, 'R3 E2E Count Challenge', { targetCount: '3' });
		await expect(page.getByText('1 of 3', { exact: true })).toBeVisible();

		// Scoped to the named list, not a bare getByText: an empty state could
		// otherwise replace the whole card and this would pass vacuously.
		await expect(
			page.getByRole('list', { name: 'Books that count' }).getByText('R3 E2E Count Progress Book', {
				exact: true
			})
		).toBeVisible();
	});

	test('fills a prompt with a book, then clears it', async ({ page }) => {
		await signIn(page);
		await addBook(page, 'R3 E2E Fill Book');

		await addChallenge(page, 'R3 E2E Prompts Challenge', { kind: 'prompts' });

		await page.getByRole('button', { name: 'Edit', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Edit challenge' });
		await dialog
			.getByRole('textbox', { name: 'New prompt', exact: true })
			.fill('R3 E2E Blue cover prompt');
		await dialog.getByRole('button', { name: 'Add prompt', exact: true }).click();
		await expect(dialog.getByText('1. R3 E2E Blue cover prompt', { exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();

		const row = page
			.getByRole('list', { name: 'Prompts' })
			.getByRole('listitem')
			.filter({ hasText: 'R3 E2E Blue cover prompt' });
		await expect(row).toBeVisible();
		await row.getByLabel('Fill with', { exact: true }).selectOption({ label: 'R3 E2E Fill Book' });
		await row.getByRole('button', { name: 'Fill', exact: true }).click();

		// The filled book is a plain span. Scoped to it, because once the prompt
		// is cleared the row shows the "Fill with" picker again, and its
		// <option> carries the same title: a bare getByText found that option
		// and failed the "cleared" check on this spec's first CI run.
		const filled = row.locator('span.filled-book');
		await expect(filled).toHaveText('R3 E2E Fill Book');
		await expect(row.getByRole('button', { name: 'Clear', exact: true })).toBeVisible();

		await row.getByRole('button', { name: 'Clear', exact: true }).click();
		await expect(filled).toHaveCount(0);
		await expect(row.getByRole('button', { name: 'Fill', exact: true })).toBeVisible();
	});

	test('reorders prompts with Up/Down', async ({ page }) => {
		await signIn(page);
		await addChallenge(page, 'R3 E2E Reorder Challenge', { kind: 'prompts' });

		await page.getByRole('button', { name: 'Edit', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Edit challenge' });
		for (const prompt of ['R3 E2E Prompt Alpha', 'R3 E2E Prompt Beta']) {
			await dialog.getByRole('textbox', { name: 'New prompt', exact: true }).fill(prompt);
			await dialog.getByRole('button', { name: 'Add prompt', exact: true }).click();
			await expect(dialog.getByText(prompt, { exact: false })).toBeVisible();
		}

		const prompts = dialog.locator('.item-prompt');
		await expect(prompts).toHaveText([/Prompt Alpha$/, /Prompt Beta$/]);

		await dialog.getByRole('button', { name: 'Move prompt 2 up' }).click();
		await expect(prompts).toHaveText([/Prompt Beta$/, /Prompt Alpha$/]);
	});

	test('Reading Insights totals a finished book for the year', async ({ page }) => {
		await signIn(page);
		await addBook(page, 'R3 E2E Insights Book');
		await finishBook(page);

		await page.goto('/reading/insights');

		// Scoped to the stat tile that HAS a "Finished" label, not a bare
		// getByText('Finished') or getByText('1'): the chart card below is
		// titled "Finished per month" (a heading, not a `.tile-label`), and a
		// bare "1" would match any number anywhere on the page.
		const finishedTile = page.locator('.card').filter({
			has: page.locator('p.tile-label', { hasText: /^Finished$/ })
		});
		await expect(finishedTile.locator('p.tile-value')).toHaveText('1');
	});
});
