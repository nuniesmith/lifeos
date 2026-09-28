import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * The Financial Hub (PACK4-002): bills and subscriptions editable end to
 * end, the payment log "mark paid" writes and "undo" reverses, income, and
 * savings toward a goal.
 *
 * Seeds an account of its own for the reason health-measurements.spec.ts and
 * people-pages.spec.ts do: borrowing another file's credentials would make
 * this file's result depend on run order. Every row either account might
 * have left behind is cleared before each test, so a retry meets nothing.
 *
 * All amounts and payees here are invented for this test — nothing is read
 * from the household's own data.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const OWNER = { username: 'e2e-finance-owner', displayName: 'Finance Owner', role: 'member' };
const OTHER = { username: 'e2e-finance-other', displayName: 'Finance Other', role: 'admin' };
const PASSWORD = 'finance-spec-password-2026';

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

		for (const person of [OWNER, OTHER]) {
			const [user] = await sql<{ id: string }[]>`
				insert into users (username, display_name, role, password_hash, must_change_credentials)
				values (${person.username}, ${person.displayName}, ${person.role}, ${passwordHash}, false)
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
		}
	});
});

/** Every row either account might have left behind, so a retry meets nothing. */
test.beforeEach(async () => {
	await query(async (sql) => {
		const owners = await sql<{ id: string }[]>`
			select id from users where username in (${OWNER.username}, ${OTHER.username})
		`;
		const ids = owners.map((u) => u.id);
		await sql`delete from bill_payments where created_by = any(${ids})`;
		await sql`delete from bills where created_by = any(${ids})`;
		await sql`delete from income_entries where created_by = any(${ids})`;
		await sql`delete from savings_contributions where created_by = any(${ids})`;
		await sql`delete from goals where created_by = any(${ids})`;
	});
});

async function signIn(page: Page, username: string) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

const firstHousehold = async (sql: Sql) =>
	(await sql<{ id: string }[]>`select id from households order by created_at limit 1`)[0]!.id;

const idOf = async (sql: Sql, username: string) =>
	(await sql<{ id: string }[]>`select id from users where username = ${username}`)[0]!.id;

async function seedGoal(username: string, title: string) {
	return query(async (sql) => {
		const householdId = await firstHousehold(sql);
		const userId = await idOf(sql, username);
		const [row] = await sql<{ id: string }[]>`
			insert into goals (household_id, title, created_by, updated_by)
			values (${householdId}, ${title}, ${userId}, ${userId})
			returning id
		`;
		return row!.id;
	});
}

async function seedBill(
	username: string,
	fields: { name: string; visibility?: 'household' | 'private' }
) {
	return query(async (sql) => {
		const householdId = await firstHousehold(sql);
		const userId = await idOf(sql, username);
		const [row] = await sql<{ id: string }[]>`
			insert into bills (household_id, owner_user_id, visibility, name, created_by, updated_by)
			values (${householdId}, ${userId}, ${fields.visibility ?? 'household'}, ${fields.name}, ${userId}, ${userId})
			returning id
		`;
		return row!.id;
	});
}

/** How far the document scrolls sideways; a phone page must not at all. */
const sideways = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('the Financial Hub', () => {
	test.use({ viewport: PHONE });

	test('adds a bill, edits every field, marks it paid, undoes the payment, then archives and restores it', async ({
		page
	}) => {
		await signIn(page, OWNER.username);
		await page.goto('/finance');

		const addBillForm = page.locator('form[action="?/addBill"]');
		await addBillForm
			.getByRole('textbox', { name: 'Name', exact: true })
			.fill('Fictional Fibernet');
		await addBillForm.getByLabel('Type', { exact: true }).selectOption('subscription');
		await addBillForm.getByLabel('Amount', { exact: true }).fill('64.99');
		await addBillForm.getByLabel('Frequency', { exact: true }).selectOption('monthly');
		await addBillForm.getByLabel('Next due', { exact: true }).fill('2026-10-01');
		await addBillForm.getByRole('button', { name: 'Add bill' }).click();

		const bills = page.getByRole('list', { name: 'Bills and subscriptions' });
		await expect(bills).toContainText('Fictional Fibernet');

		await page.getByRole('link', { name: 'Fictional Fibernet' }).click();
		await expect(page.getByRole('heading', { name: 'Fictional Fibernet', level: 1 })).toBeVisible();
		const billUrl = page.url();

		// Edit every field, including three <Select>s — the update({reset:
		// false}) form.
		await page.getByText('Edit bill').click();
		const editor = page.locator('form[action="?/save"]');
		await editor
			.getByRole('textbox', { name: 'Name', exact: true })
			.fill('Fictional Fibernet Plus');
		await editor.getByLabel('Frequency', { exact: true }).selectOption('annual');
		await editor.getByLabel('Status', { exact: true }).selectOption('paused');
		await editor.getByLabel('Category', { exact: true }).fill('Internet');
		await editor.getByRole('button', { name: 'Save changes' }).click();
		await expect(editor.getByRole('status')).toHaveText('Saved.');
		// Still on this page, no reload: the Selects must show what was just
		// saved rather than reverting to the option the page first rendered
		// with — the same proof people-pages.spec.ts runs for its own <Select>.
		await expect(editor.getByLabel('Frequency', { exact: true })).toHaveValue('annual');
		await expect(editor.getByLabel('Status', { exact: true })).toHaveValue('paused');

		await page.reload();
		await expect(
			page.getByRole('heading', { name: 'Fictional Fibernet Plus', level: 1 })
		).toBeVisible();
		await expect(page.getByText('Internet', { exact: true })).toBeVisible();

		// Mark it paid, then undo.
		await page.getByRole('button', { name: 'Mark paid' }).click();
		const history = page.getByRole('list', { name: 'Payment history' });
		// CA$, not $: Intl.NumberFormat disambiguates a non-local currency from
		// the reader's own under an en-US locale, and CAD is this app's default.
		await expect(history).toContainText('CA$64.99');

		await history.getByRole('button', { name: 'Undo' }).click();
		await expect(page.getByText('No payments recorded')).toBeVisible();

		// Archive takes it off the hub; restore brings it back to this page.
		await page.getByRole('button', { name: 'Archive' }).click();
		await expect(page).toHaveURL('/finance');
		await expect(page.getByText('Fictional Fibernet Plus')).toHaveCount(0);

		await page.goto(billUrl);
		await expect(page.getByText('Archived', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Restore' }).click();
		await expect(page.getByText('Restored. It is back on the Financial Hub.')).toBeVisible();

		expect(await sideways(page)).toBeLessThanOrEqual(0);
	});

	test('adds income, edits it in a sheet, and money at a glance reflects it', async ({ page }) => {
		await signIn(page, OWNER.username);
		await page.goto('/finance');

		const addIncomeForm = page.locator('form[action="?/addIncome"]');
		await addIncomeForm
			.getByRole('textbox', { name: 'Title', exact: true })
			.fill('Fictional Paycheque');
		await addIncomeForm.getByLabel('Source', { exact: true }).fill('Fictional Employer');
		await addIncomeForm.getByLabel('Expected', { exact: true }).fill('2000');
		const today = new Date().toISOString().slice(0, 10);
		await addIncomeForm.getByRole('textbox', { name: 'Date', exact: true }).fill(today);
		await addIncomeForm.getByRole('button', { name: 'Add income' }).click();

		const income = page.getByRole('list', { name: 'Income' });
		await expect(income).toContainText('Fictional Paycheque');

		await income.getByRole('button', { name: 'Edit' }).click();
		const sheet = page.getByRole('dialog', { name: 'Edit income' });
		await sheet.getByLabel('Actual', { exact: true }).fill('1980');
		await sheet.getByRole('button', { name: 'Save changes' }).click();
		await expect(sheet).toBeHidden();

		// CA$, not $: see the identical note on the bill payment above.
		await expect(income).toContainText('-CA$20.00');

		// Money at a glance: received this month now includes the $1980 actual.
		await expect(page.getByText('CA$1,980.00')).toBeVisible();
	});

	test('adds a savings contribution toward a goal and shows the total by goal', async ({
		page
	}) => {
		const goalId = await seedGoal(OWNER.username, 'Fictional Emergency Fund');

		await signIn(page, OWNER.username);
		await page.goto('/finance');

		const addSavingsForm = page.locator('form[action="?/addSavings"]');
		await addSavingsForm
			.getByRole('textbox', { name: 'Title', exact: true })
			.fill('Fictional Transfer');
		await addSavingsForm.getByRole('spinbutton', { name: 'Amount', exact: true }).fill('150');
		const today = new Date().toISOString().slice(0, 10);
		await addSavingsForm.getByRole('textbox', { name: 'Date', exact: true }).fill(today);
		await addSavingsForm.getByLabel('Goal', { exact: true }).selectOption(goalId);
		await addSavingsForm.getByRole('button', { name: 'Add contribution' }).click();

		const savedByGoal = page.getByRole('heading', { name: 'Saved by goal' });
		await expect(savedByGoal).toBeVisible();
		const perGoal = page.locator('.per-goal');
		await expect(perGoal).toContainText('Fictional Emergency Fund');
		// CA$, not $: see the identical note on the bill payment test above.
		await expect(perGoal).toContainText('CA$150.00');

		const savings = page.getByRole('list', { name: 'Savings contributions' });
		await expect(savings).toContainText('Fictional Transfer');

		await savings.getByRole('button', { name: 'Edit' }).click();
		const sheet = page.getByRole('dialog', { name: 'Edit contribution' });
		await sheet.getByRole('spinbutton', { name: 'Amount', exact: true }).fill('200');
		await sheet.getByRole('button', { name: 'Save changes' }).click();
		await expect(sheet).toBeHidden();

		await expect(perGoal).toContainText('CA$200.00');

		// Archiving a contribution takes it, and its money, out of the totals.
		await savings.getByRole('button', { name: 'Edit' }).click();
		await page
			.getByRole('dialog', { name: 'Edit contribution' })
			.getByRole('button', { name: 'Archive' })
			.click();
		await expect(page.getByText('Fictional Transfer')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Saved by goal' })).toHaveCount(0);
	});

	test('the other household member cannot reach a private bill', async ({ page }) => {
		const billId = await seedBill(OWNER.username, {
			name: 'Fictional Private Bill',
			visibility: 'private'
		});

		await signIn(page, OTHER.username);
		const response = await page.goto(`/finance/bills/${billId}`);
		expect(response?.status()).toBe(404);

		await page.goto('/finance');
		await expect(page.getByText('Fictional Private Bill')).toHaveCount(0);
	});
});
