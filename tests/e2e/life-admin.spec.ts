import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Life Admin HQ (migration 0036): add a document, see it need attention,
 * renew it off that list, then archive and restore it end to end.
 *
 * Seeds an account of its own for the reason finance.spec.ts and
 * health-measurements.spec.ts do: borrowing another file's credentials would
 * make this file's result depend on run order. Every row the account might
 * have left behind is cleared before each test, so a retry meets nothing.
 *
 * All titles and dates below are invented for this test -- nothing is read
 * from the household's own data.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const OWNER = { username: 'e2e-lifeadmin-owner', displayName: 'Life Admin Owner', role: 'member' };
const PASSWORD = 'life-admin-spec-password-2026';

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

/**
 * The household's own day, on its own clock, optionally offset by whole
 * days -- computed in SQL, never with `new Date()`. Between 00:00 and 04:00
 * UTC, `new Date().toISOString().slice(0, 10)` and Postgres's `current_date`
 * are already tomorrow in this household's own timezone (America/Toronto),
 * which is exactly the gap a food-log e2e test once fell into every evening.
 * `attentionState` (documents.ts) decides "needs attention" against the
 * household's clock, so the dates this spec hands the form have to be
 * computed the same way or the test would flip outcomes depending on the
 * hour it happens to run.
 */
async function householdDay(offsetDays = 0): Promise<string> {
	return query(async (sql) => {
		const [row] = await sql<{ day: string }[]>`
			select ((now() at time zone timezone)::date + ${offsetDays}::int)::text as day
			from households
			order by created_at limit 1
		`;
		return row!.day;
	});
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
			values (${OWNER.username}, ${OWNER.displayName}, ${OWNER.role}, ${passwordHash}, false)
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

/** Every row the account might have left behind, so a retry meets nothing. */
test.beforeEach(async () => {
	await query(async (sql) => {
		const [user] = await sql<
			{ id: string }[]
		>`select id from users where username = ${OWNER.username}`;
		if (!user) return;
		await sql`delete from document_renewals where created_by = ${user.id}`;
		await sql`delete from documents where created_by = ${user.id}`;
	});
});

async function signIn(page: Page, username: string) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

test.describe('Life Admin HQ', () => {
	test.use({ viewport: PHONE });

	test('adds a document, sees it need attention, renews it off that list, then archives and restores it', async ({
		page
	}) => {
		// Every e2e user shares one household, so the title has to be unique --
		// borrowed from another run, a stale "LA E2E" row would make this
		// test's own list assertions ambiguous.
		const title = `LA E2E Fictional Passport ${Date.now()}`;
		const dueSoon = await householdDay(5);
		const farFuture = await householdDay(400);

		await signIn(page, OWNER.username);
		await page.goto('/life-admin');

		const addForm = page.locator('form[action="?/create"]');
		await addForm.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
		await addForm.getByLabel('Expires on', { exact: true }).fill(dueSoon);
		await addForm.getByRole('button', { name: 'Add document', exact: true }).click();

		// Due in 5 days, with the table's own default 30-day lead time: well
		// inside the window, so it lands under Needs attention right away.
		await expect(page.getByRole('list', { name: 'Needs attention' })).toContainText(title);

		await page.getByRole('link', { name: title }).click();
		await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
		const documentUrl = page.url();

		// Renew it far into the future, which takes it off Needs attention.
		await page.getByRole('textbox', { name: 'New expiry date', exact: true }).fill(farFuture);
		await page.getByRole('button', { name: 'Renew', exact: true }).click();
		await expect(page.getByText('Renewed.')).toBeVisible();
		await expect(page.getByRole('list', { name: 'Renewal history' })).toContainText('Undo');

		await page.goto('/life-admin');
		// Needs attention has no list at all once it is empty (an EmptyState
		// stands in its place), so the check is against the section itself --
		// a <section aria-labelledby> region, which exists either way -- not
		// the <ul>, which would not.
		await expect(page.getByRole('region', { name: 'Needs attention' })).not.toContainText(title);
		await expect(page.getByRole('list', { name: 'Everything else' })).toContainText(title);

		// Archive takes it off the hub; restore brings it back to this page.
		await page.goto(documentUrl);
		await page.getByRole('button', { name: 'Archive', exact: true }).click();
		await expect(page).toHaveURL('/life-admin');
		await expect(page.getByText(title)).toHaveCount(0);

		await page.goto(documentUrl);
		await expect(page.getByText('Archived', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Restore', exact: true }).click();
		await expect(page.getByText('Restored. It is back on Life Admin HQ.')).toBeVisible();

		await page.goto('/life-admin');
		await expect(page.getByRole('list', { name: 'Everything else' })).toContainText(title);
	});
});
