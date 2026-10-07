import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Daily planning (migration 0038): Today's Three, a task's theme and
 * category, the fuller journal check-in, and the habits page with no streak.
 *
 * This file seeds its own account, `e2e-planning-owner`, matching
 * planning.spec.ts's own reasoning: every spec in this suite shares ONE
 * database and ONE household, so a borrowed account's state depends on run
 * order, and every title created here is made unique for the same reason —
 * another spec's own fixture rows are not this file's to count or assert
 * against as "the only one".
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-planning-owner', displayName: 'Planning Owner', role: 'member' };
const PASSWORD = 'daily-planning-spec-password-2026';
const PHONE = { width: 390, height: 844 };

/** One short-lived connection; the pages under test use the server's own. */
async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

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

		// Upsert, matching planning.spec.ts: the seed must be safe to run twice
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
	});
});

/**
 * Removes only THIS user's own rows from a previous run -- a retry, or a
 * prior failed run -- never a blanket delete, since the household is shared
 * with every other spec in the suite. Tasks are found by their title prefix
 * rather than by owner: Today's Three picks are made by this user but the
 * tasks themselves may be household-wide (owner_user_id null), which a
 * owner-scoped delete would miss and leave to collide with this run.
 */
test.beforeEach(async () => {
	await withDb(async (sql) => {
		const [user] = await sql<
			{ id: string }[]
		>`select id from users where username = ${USER.username}`;
		if (!user) return;
		await sql`delete from todays_three where user_id = ${user.id}::uuid`;
		await sql`delete from daily_logs where owner_user_id = ${user.id}::uuid`;
		await sql`delete from tasks where title like 'LP E2E %'`;
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

/**
 * Unique per call, like planning.spec.ts's own `unique`: a retry must not
 * collide with its own first attempt's rows in a database reset only once
 * per suite, and every title the household itself might type is excluded by
 * the "LP E2E" prefix the cleanup above also keys on.
 */
const unique = (label: string) =>
	`LP E2E ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Creates an open task from /tasks' own quick-add form and returns its title. */
async function addTask(page: Page, title: string) {
	await page.goto('/tasks');
	// Required field: "New task *" is not what getByLabel({ exact: true })
	// looks for (the asterisk is decorative, excluded from the accessible
	// name computed for a role query, but getByLabel matches the label's own
	// text, asterisk included) -- hard rule 5.
	await page.getByRole('textbox', { name: 'New task', exact: true }).fill(title);
	await page.locator('form[action="?/create"]').getByRole('button', { name: 'Add' }).click();
	await expect(page.getByRole('link', { name: title })).toBeVisible();
}

/** A Today's Three slot's own <li>, found by its fixed hint rather than by
 *  DOM order -- the same row whether it is showing the picker or the pick. */
const slotRow = (page: Page, hint: string) =>
	page.locator('.three-list li').filter({ hasText: hint });

const SLOT_HINT = {
	due: 'A task with a real deadline or consequence.',
	hard: 'Something you’ve been avoiding.',
	easy: 'One genuinely finishable task.'
};

async function pickForSlot(page: Page, hint: string, taskTitle: string) {
	const row = slotRow(page, hint);
	await row.getByRole('combobox').selectOption({ label: taskTitle });
	await row.getByRole('button', { name: 'Pick' }).click();
	await expect(row.getByRole('link', { name: taskTitle })).toBeVisible();
}

test.describe('Today’s Three', () => {
	test.use({ viewport: PHONE });

	test('picks a task for each slot, completes one, and clears one', async ({ page }) => {
		await signIn(page);
		const due = unique('Due task');
		const hard = unique('Hard task');
		const easy = unique('Easy task');
		await addTask(page, due);
		await addTask(page, hard);
		await addTask(page, easy);

		await page.goto('/');
		await pickForSlot(page, SLOT_HINT.due, due);
		await pickForSlot(page, SLOT_HINT.hard, hard);
		await pickForSlot(page, SLOT_HINT.easy, easy);

		// Complete the DUE pick.
		const dueRow = slotRow(page, SLOT_HINT.due);
		await dueRow.getByRole('button', { name: `Complete ${due}` }).click();
		await expect(dueRow.getByRole('button', { name: `Reopen ${due}` })).toBeVisible();
		// Struck, not vanished (the brief's own rule).
		await expect(dueRow.getByRole('link', { name: due })).toBeVisible();

		// Clear the HARD pick: the slot goes back to offering a picker.
		const hardRow = slotRow(page, SLOT_HINT.hard);
		await hardRow.getByRole('button', { name: 'Clear' }).click();
		await expect(hardRow.getByRole('combobox')).toBeVisible();
		await expect(hardRow.getByRole('link', { name: hard })).toHaveCount(0);

		// The EASY pick is untouched by either of the other two actions.
		const easyRow = slotRow(page, SLOT_HINT.easy);
		await expect(easyRow.getByRole('link', { name: easy })).toBeVisible();
		await expect(easyRow.getByRole('button', { name: `Complete ${easy}` })).toBeVisible();

		// Survives a fresh request, so each action was written, not merely
		// reflected in the form's own local state.
		await page.reload();
		await expect(
			slotRow(page, SLOT_HINT.due).getByRole('button', { name: `Reopen ${due}` })
		).toBeVisible();
		await expect(slotRow(page, SLOT_HINT.hard).getByRole('combobox')).toBeVisible();
		await expect(slotRow(page, SLOT_HINT.easy).getByRole('link', { name: easy })).toBeVisible();
	});
});

test.describe('task theme and category', () => {
	test.use({ viewport: PHONE });

	test('sets a task’s theme and category, and filters the list by theme', async ({ page }) => {
		await signIn(page);
		const title = unique('Fictional Errand');
		await addTask(page, title);

		await page.getByRole('link', { name: title }).click();
		await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();

		// Neither Select is required, so plain getByLabel matches (hard rule 5
		// only bites a required field).
		await page.getByLabel('Theme', { exact: true }).selectOption('errands_appointments');
		await page.getByLabel('List', { exact: true }).selectOption('hard_deadline');
		await page
			.locator('form[action="?/save"]')
			.getByRole('button', { name: 'Save', exact: true })
			.click();
		await expect(page.getByRole('status')).toHaveText('Saved.');

		// A fresh request, to prove the save landed rather than reading the
		// form's own post-submit state back.
		await page.reload();
		await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('errands_appointments');
		await expect(page.getByLabel('List', { exact: true })).toHaveValue('hard_deadline');

		await page.goto('/tasks?view=open');
		await page.getByLabel('Theme', { exact: true }).selectOption('errands_appointments');
		await page.getByRole('button', { name: 'Filter' }).click();
		await expect(page).toHaveURL(/theme=errands_appointments/);
		await expect(page.getByRole('link', { name: title })).toBeVisible();
	});
});

test.describe('the journal check-in', () => {
	test.use({ viewport: PHONE });

	test('fills the check-in fields on today’s journal page and sees them saved', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/journal');

		const intention = unique('intention');
		await page.getByRole('textbox', { name: 'Intention', exact: true }).fill(intention);
		await page.getByLabel('Pattern tags', { exact: true }).fill('Rainy day, Low energy');
		await page.getByLabel('Theme', { exact: true }).selectOption('self_care');
		// Scoped to its own fieldset: Energy, Activation and Effectiveness are
		// three separate 1-5 scales on the same page, each offering a radio
		// named "3" -- a bare, page-wide lookup would be ambiguous.
		await page
			.locator('fieldset')
			.filter({ hasText: 'Activation' })
			.getByRole('radio', { name: '3 of 5' })
			.check();
		await page.getByRole('spinbutton', { name: 'Water', exact: true }).fill('4');

		await page.getByRole('button', { name: /entry$/ }).click();
		await expect(page.getByRole('status')).toHaveText('Saved.');

		await page.reload();
		await expect(page.getByRole('textbox', { name: 'Intention', exact: true })).toHaveValue(
			intention
		);
		await expect(page.getByLabel('Pattern tags', { exact: true })).toHaveValue(
			'Rainy day, Low energy'
		);
		await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('self_care');
		await expect(
			page
				.locator('fieldset')
				.filter({ hasText: 'Activation' })
				.getByRole('radio', { name: '3 of 5' })
		).toBeChecked();
		await expect(page.getByRole('spinbutton', { name: 'Water', exact: true })).toHaveValue('4');
	});
});

test.describe('habits without streaks', () => {
	test.use({ viewport: PHONE });

	test('shows progress and a return nudge, never a streak', async ({ page }) => {
		await signIn(page);
		const name = unique('habit');
		await page.goto('/habits');
		await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
		await page
			.locator('form[action="?/create"]')
			.getByRole('button', { name: 'Add habit' })
			.click();

		const row = page.getByRole('listitem').filter({ hasText: name });
		await expect(row).toHaveCount(1);
		await expect(row).toContainText('Not yet today');
		await expect(row).not.toContainText(/streak/i);

		await row.getByRole('button', { name: `Log ${name}` }).click();
		await expect(row).toContainText('Done today');
		await expect(row).not.toContainText(/streak/i);

		// A brand-new habit has no prior full period to have missed, so it
		// must not open on the return nudge either.
		await expect(row).not.toContainText('Plan the return');

		await page.reload();
		await expect(page.getByRole('listitem').filter({ hasText: name })).toContainText('Done today');
	});
});
