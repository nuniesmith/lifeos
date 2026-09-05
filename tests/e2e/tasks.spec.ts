import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Tasks, driven the way a person drives them.
 *
 * This file exists because of a bug the rest of the suite could not have
 * caught. Every task form carries the row's `updatedAt` as an optimistic
 * concurrency token, and the pages interpolated the `Date` directly — whose
 * `toString()` renders "Sat Sep 05 2026 17:00:38 GMT-0400" and drops the
 * milliseconds. The precondition compares to the millisecond, so the token
 * never matched and *every* completion and save returned 409.
 *
 * It was invisible to the integration tests, which call the repositories with
 * a real Date, and to a curl check that read the timestamp out of PostgreSQL
 * and posted it back. Both skipped the one step that was broken: rendering.
 * So these cases go through the browser and click the control.
 */

const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-tasks-owner', displayName: 'Tasks Owner', role: 'admin' };
const PASSWORD = 'tasks-spec-password-2026';
const PHONE = { width: 390, height: 844 };

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

		// Upsert, matching shell.spec.ts: the seed must be safe to run twice
		// and must not remove a row another spec is mid-sign-in with.
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

/**
 * Titles are made unique per call. Playwright retries a failed case, and a
 * fixed title would then exist twice — every locator becomes a strict-mode
 * violation and the real result is buried under a selector error.
 */
const unique = (label: string) =>
	`${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function addTask(page: Page, title: string) {
	await page.goto('/tasks');
	await page.getByLabel('New task').fill(title);
	// Scoped to the create form: the detail page has an Add for subtasks too.
	await page.locator('form[action="?/create"]').getByRole('button', { name: 'Add' }).click();
	await expect(page.getByRole('link', { name: title })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('the concurrency token round-trips through the rendered form', async ({ page }) => {
	await signIn(page);
	await addTask(page, unique('Token round trip'));

	// The precondition compares to the millisecond, so the rendered value must
	// carry them. A Date interpolated directly renders as a locale string and
	// silently loses them.
	const token = await page.locator('input[name="updatedAt"]').first().inputValue();
	expect(token, 'updatedAt must render as an ISO timestamp').toMatch(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
	);
});

test('completing a task from the list actually completes it', async ({ page }) => {
	await signIn(page);
	const title = unique('Complete from list');
	await addTask(page, title);

	await page.getByRole('button', { name: `Complete ${title}` }).click();

	// The give-away for the original bug: the row stays open and the page
	// reports a conflict for a task nobody else touched.
	await expect(page.getByRole('alert')).toHaveCount(0);
	await page.goto('/tasks?view=done');
	await expect(page.getByRole('link', { name: title })).toBeVisible();
});

test('a task can be edited from its detail page', async ({ page }) => {
	await signIn(page);
	const title = unique('Edit me');
	const renamed = unique('Edited properly');
	await addTask(page, title);

	await page.getByRole('link', { name: title }).click();
	await expect(page.getByRole('heading', { name: title })).toBeVisible();

	await page.getByLabel('Title').fill(renamed);
	await page.getByLabel('Notes').fill('With a note.');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByRole('status')).toHaveText('Saved.');
	await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
});

test('a subtask can be added and completed', async ({ page }) => {
	await signIn(page);
	const parent = unique('Parent task');
	const child = unique('A small step');
	await addTask(page, parent);
	await page.getByRole('link', { name: parent }).click();

	await page.getByLabel('Add a subtask').fill(child);
	await page.locator('form[action="?/addSubtask"]').getByRole('button', { name: 'Add' }).click();
	await expect(page.getByRole('link', { name: child })).toBeVisible();

	await page.getByRole('button', { name: `Complete ${child}` }).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the task list is usable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await signIn(page);
	const title = unique('Phone sized');
	await addTask(page, title);

	// The completion control is the one thing that must be thumb-reachable.
	const tick = page.getByRole('button', { name: `Complete ${title}` });
	const box = await tick.boundingBox();
	expect(box, 'the tick should be rendered').not.toBeNull();
	expect(box!.height).toBeGreaterThanOrEqual(44);
	expect(box!.width).toBeGreaterThanOrEqual(44);
});
