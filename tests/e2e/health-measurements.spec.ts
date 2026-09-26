import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Units for glucose and weight on /health/measurements (migration 0022), on
 * the phone the readings are taken beside.
 *
 * Seeds an account of its own for the reason health-tags.spec.ts does:
 * borrowing another file's credentials would make this one depend on the
 * order the suite runs in. Its readings are cleared before each test, so a
 * retry meets an empty list rather than its first attempt's rows.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const PERSON = { username: 'e2e-units-owner', displayName: 'Units Owner', role: 'member' };
const PASSWORD = 'units-spec-password-2026';

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
	await query(
		(sql) => sql`
			delete from health_measurements
			where owner_user_id = (select id from users where username = ${PERSON.username})
		`
	);
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(PERSON.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

const recent = (page: Page) => page.getByRole('list', { name: 'Recent readings' });

test.describe('units for glucose and weight', () => {
	test.use({ viewport: PHONE });

	test('records each reading in the unit chosen, and offers that unit next time', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/health/measurements');

		await page.getByLabel('Blood glucose').fill('112');
		await page.getByLabel('Glucose unit').selectOption('mg/dL');
		await page.getByLabel('Weight', { exact: true }).fill('154.3');
		await page.getByLabel('Weight unit').selectOption('lb');
		await page.getByRole('button', { name: 'Save reading' }).click();

		await expect(recent(page)).toContainText('glucose 112 mg/dL · weight 154.3 lb');

		// The form is ready for the next reading, still in the units just used.
		await expect(page.getByLabel('Blood glucose')).toHaveValue('');
		await expect(page.getByLabel('Glucose unit')).toHaveValue('mg/dL');
		await expect(page.getByLabel('Weight unit')).toHaveValue('lb');

		// A second reading in the same visit, pickers untouched, is saved in the
		// same units. It also lands in the same minute as the first, which is
		// what used to stop this page updating at all: the chart keyed its
		// points by time, and two points at one instant made Svelte throw.
		await page.getByLabel('Weight', { exact: true }).fill('155');
		await page.getByRole('button', { name: 'Save reading' }).click();
		await expect(recent(page)).toContainText('weight 155 lb');
		await expect(page.getByLabel('Weight unit')).toHaveValue('lb');
		await expect(page.getByLabel('Glucose unit')).toHaveValue('mg/dL');

		// And on a fresh visit, from what is stored rather than what is on screen.
		await page.reload();
		await expect(page.getByLabel('Glucose unit')).toHaveValue('mg/dL');
		await expect(page.getByLabel('Weight unit')).toHaveValue('lb');
		// The chart says which unit it is drawn in.
		await expect(page.getByRole('figure', { name: 'Weight (lb)' })).toBeVisible();
	});

	test('refuses a glucose typed against the wrong unit, and says which unit it fits', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/health/measurements');

		await page.getByLabel('Blood glucose').fill('112');
		await page.getByLabel('Glucose unit').selectOption('mmol/L');
		await page.getByRole('button', { name: 'Save reading' }).click();

		await expect(page.getByRole('alert')).toContainText('did you mean mg/dL?');
		await expect(recent(page)).toHaveCount(0);
	});

	test('sets the unit of a reading imported without one', async ({ page }) => {
		await query(
			(sql) => sql`
				insert into health_measurements (household_id, owner_user_id, measured_at, glucose)
				select m.household_id, u.id, now() - interval '1 day', 7.7
				from users u join household_members m on m.user_id = u.id
				where u.username = ${PERSON.username}
			`
		);
		await signIn(page);
		await page.goto('/health/measurements');

		// Shown as recorded: a number, and no unit it never had.
		const row = recent(page).getByRole('listitem').filter({ hasText: 'glucose 7.7' });
		await expect(row).toHaveCount(1);
		await expect(row).not.toContainText('mmol/L');
		await expect(row).not.toContainText('mg/dL');

		await row.getByRole('button', { name: 'Edit' }).click();
		const sheet = page.getByRole('dialog', { name: 'Edit reading' });
		// Opens on "Not recorded", so saving any other change leaves it so.
		await expect(sheet.getByLabel('Glucose unit')).toHaveValue('');
		await sheet.getByLabel('Glucose unit').selectOption('mmol/L');
		await sheet.getByRole('button', { name: 'Save changes' }).click();

		await expect(recent(page)).toContainText('glucose 7.7 mmol/L');
	});
});
