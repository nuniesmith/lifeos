import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Quick capture (UI-003), driven through the browser.
 *
 * The control is a `<dialog>` opened with `showModal()` and submitted with
 * `fetch`, so none of it is exercised by a server-side test. The point of the
 * feature is that capture never fails for want of a decision, which is only
 * observable by opening it and typing.
 */

const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-capture', displayName: 'Capture User', role: 'admin' };
const PASSWORD = 'capture-spec-password-2026';
const PHONE = { width: 390, height: 844 };

const unique = (label: string) =>
	`${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test.beforeAll(async () => {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
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
			values (${householdId}, ${user!.id}) on conflict do nothing
		`;
	} finally {
		await sql.end();
	}
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

async function openCapture(page: Page) {
	await page
		.getByRole('button', { name: /quick add|add/i })
		.first()
		.click();
	await expect(page.getByRole('dialog')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('a captured task reaches the task list', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await signIn(page);

	const title = unique('Call the plumber');
	await openCapture(page);
	await page.getByRole('dialog').getByLabel(/what/i).fill(title);
	await page
		.getByRole('dialog')
		.getByRole('button', { name: /add|save|capture/i })
		.click();

	// The dialog closing is the success signal; it stays open on failure.
	await expect(page.getByRole('dialog')).toBeHidden();

	await page.goto('/tasks');
	await expect(page.getByRole('link', { name: title })).toBeVisible();
});

test('an empty capture cannot be submitted at all', async ({ page }) => {
	await signIn(page);
	await openCapture(page);

	// Stronger than the endpoint refusing it: the control is disabled until
	// there is something to save, so the round trip never happens and the
	// dialog cannot close on a capture that saved nothing.
	const dialog = page.getByRole('dialog');
	const submit = dialog.getByRole('button', { name: /add|save|capture/i });

	await expect(submit).toBeDisabled();
	await dialog.getByLabel(/what/i).fill('   ');
	await expect(submit, 'whitespace is not content').toBeDisabled();

	await dialog.getByLabel(/what/i).fill('Something real');
	await expect(submit).toBeEnabled();
});

test('the capture control is thumb-reachable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await signIn(page);

	const button = page.getByRole('button', { name: /quick add|add/i }).first();
	const box = await button.boundingBox();
	expect(box, 'the capture button should be rendered').not.toBeNull();
	expect(box!.height).toBeGreaterThanOrEqual(44);
	// Bottom half of the screen: the most-used control should not be a stretch.
	expect(box!.y).toBeGreaterThan(PHONE.height / 2);
});
