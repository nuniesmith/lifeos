import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Routines (Routines feature pack), on the phone the "do it now" view is for.
 *
 * Seeds an account of its own for the reason health-measurements.spec.ts's
 * does: borrowing another file's credentials would make this one depend on
 * the order the suite runs in. Its routines (and the habit it links one
 * step to) are cleared before each test, so a retry meets an empty account
 * rather than its first attempt's rows.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const PERSON = { username: 'e2e-routines-owner', displayName: 'Routines Owner', role: 'member' };
const PASSWORD = 'routines-spec-password-2026';

/** The device the acceptance gate names. */
const PHONE = { width: 390, height: 844 };

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
			delete from routines
			where owner_user_id = (select id from users where username = ${PERSON.username})
		`
	);
	await query(
		(sql) => sql`
			delete from habits
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

/**
 * Forms are located by their action rather than by reaching for a label on
 * the page as a whole — the same discipline journal-habits.spec.ts's
 * `editorForm` follows, needed here because "Name" and "Title" each appear
 * on more than one form on this page (the routine's own edit form and the
 * add-step form both have one).
 */
const addRoutineForm = (page: Page) => page.locator('form[action="?/create"]');
const addStepForm = (page: Page) => page.locator('form[action="?/addStep"]');
const editSheet = (page: Page) => page.getByRole('dialog', { name: 'Edit routine' });
const doItNowList = (page: Page) => page.getByRole('list', { name: 'Steps' });

/** Signs in and adds a routine from the list page, then opens it. Every test
 *  in this file starts here, so signing in lives here rather than being
 *  repeated at the top of each one. */
async function addRoutine(page: Page, name: string, timeOfDay = 'morning'): Promise<void> {
	await signIn(page);
	await page.goto('/routines');
	const form = addRoutineForm(page);
	await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
	await form.getByLabel('Time of day').selectOption(timeOfDay);
	await form.getByRole('button', { name: 'Add routine' }).click();

	await page
		.getByRole('list', { name: `${timeOfDay[0]!.toUpperCase()}${timeOfDay.slice(1)} routines` })
		.getByRole('link', { name, exact: true })
		.click();
	await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/**
 * A step's own line in the edit sheet ("2. Stretch"), matched whole. A bare
 * getByText(title) also matches the Linked habit picker's <option>s ("Read"
 * is inside "Read a page", and two habits can both say "Stretch"), which
 * failed strict mode the first time this spec ran.
 */
const stepLine = (title: string) =>
	new RegExp(`^\\d+\\. ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/**
 * Adds a step from the edit sheet. `averageVersion` is required, and its
 * label reads "Average version *" once the required marker is in — the
 * exact trap the brief's own locator lesson names, so this goes through
 * `getByRole('textbox', { name, exact: true })` rather than `getByLabel`.
 */
async function addStep(
	page: Page,
	fields: { title: string; averageVersion: string; highVersion?: string; habit?: string }
): Promise<void> {
	await page.getByRole('button', { name: 'Edit' }).click();
	const sheet = editSheet(page);
	const form = addStepForm(page);
	await form.getByRole('textbox', { name: 'Title', exact: true }).fill(fields.title);
	await form
		.getByRole('textbox', { name: 'Average version', exact: true })
		.fill(fields.averageVersion);
	if (fields.highVersion) {
		await form.getByLabel('High-energy version').fill(fields.highVersion);
	}
	if (fields.habit) {
		await form.getByLabel('Linked habit').selectOption({ label: fields.habit });
	}
	await form.getByRole('button', { name: 'Add step' }).click();
	await expect(sheet.getByText(stepLine(fields.title))).toBeVisible();
	await sheet.getByRole('button', { name: 'Close' }).click();
}

test.describe('routines', () => {
	test.use({ viewport: PHONE });

	test('adds a routine, adds a step, and completes it with one tap', async ({ page }) => {
		const name = 'Fictional Morning Routine';
		await addRoutine(page, name);
		await addStep(page, { title: 'Drink water', averageVersion: 'Drink a full glass of water' });

		const row = doItNowList(page).getByRole('listitem').filter({ hasText: 'Drink water' });
		await expect(row).toContainText('Drink a full glass of water');
		await expect(row.getByRole('button')).not.toHaveAttribute('aria-pressed', 'true');

		await row.getByRole('button').click();
		await expect(row.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
		await expect(row).toContainText('Done (Average)');

		// Survives a fresh request, so it was written and not merely toggled.
		await page.reload();
		const reloaded = doItNowList(page).getByRole('listitem').filter({ hasText: 'Drink water' });
		await expect(reloaded.getByRole('button')).toHaveAttribute('aria-pressed', 'true');

		// Tap again to undo.
		await reloaded.getByRole('button').click();
		await expect(reloaded.getByRole('button')).not.toHaveAttribute('aria-pressed', 'true');
	});

	test('the energy picker changes which version shows, and a reload keeps it', async ({ page }) => {
		await addRoutine(page, 'Fictional Evening Routine', 'evening');
		await addStep(page, {
			title: 'Read',
			averageVersion: 'Read a chapter',
			highVersion: 'Read for an hour'
		});

		const row = doItNowList(page).getByRole('listitem').filter({ hasText: 'Read' });
		await expect(row).toContainText('Read a chapter');

		await page.getByRole('link', { name: 'High', exact: true }).click();
		await expect(page).toHaveURL(/[?&]energy=high/);
		await expect(row).toContainText('Read for an hour');

		// A reload of that same URL keeps High, and the version shown with it.
		await page.reload();
		await expect(row).toContainText('Read for an hour');
	});

	test('reorders steps with Up and Down', async ({ page }) => {
		await addRoutine(page, 'Fictional Reorder Routine');
		await addStep(page, { title: 'First step', averageVersion: 'Do the first thing' });
		await addStep(page, { title: 'Second step', averageVersion: 'Do the second thing' });

		const titles = () => doItNowList(page).getByRole('listitem').allTextContents();
		expect((await titles()).map((t) => t.includes('First step'))).toEqual([true, false]);

		await page.getByRole('button', { name: 'Edit' }).click();
		await editSheet(page)
			.getByText('2. Second step')
			.locator('..')
			.getByRole('button', { name: 'Move Second step up' })
			.click();
		await editSheet(page).getByRole('button', { name: 'Close' }).click();

		const reordered = await titles();
		expect(reordered[0]).toContain('Second step');
		expect(reordered[1]).toContain('First step');
	});

	test('archiving a step removes it from the list, and archiving the routine returns to it', async ({
		page
	}) => {
		const name = 'Fictional Prune Routine';
		await addRoutine(page, name);
		await addStep(page, { title: 'Keep me', averageVersion: 'Stay on the list' });
		await addStep(page, { title: 'Remove me', averageVersion: 'Leave the list' });

		await expect(doItNowList(page).getByRole('listitem')).toHaveCount(2);

		await page.getByRole('button', { name: 'Edit' }).click();
		await editSheet(page)
			.getByText('2. Remove me')
			.locator('..')
			.getByRole('button', { name: 'Archive Remove me' })
			.click();
		await editSheet(page).getByRole('button', { name: 'Close' }).click();

		// A count, not `not.toContainText`: an empty state would also satisfy
		// the negative assertion, and one step remaining is the real claim.
		await expect(doItNowList(page).getByRole('listitem')).toHaveCount(1);
		await expect(doItNowList(page)).toContainText('Keep me');

		await page.getByRole('button', { name: 'Edit' }).click();
		await editSheet(page).getByRole('button', { name: 'Archive routine' }).click();
		await expect(page).toHaveURL('/routines');
		await expect(page.getByText(name, { exact: true })).toHaveCount(0);
	});

	test('completing a step linked to a habit logs the habit too, and undoing unlogs it', async ({
		page
	}) => {
		const habitName = 'Fictional Stretch Habit';
		await query(
			(sql) => sql`
				insert into habits (household_id, owner_user_id, name, created_by, updated_by)
				select m.household_id, u.id, ${habitName}, u.id, u.id
				from users u join household_members m on m.user_id = u.id
				where u.username = ${PERSON.username}
			`
		);

		await addRoutine(page, 'Fictional Linked Routine');
		await addStep(page, {
			title: 'Stretch',
			averageVersion: 'Stretch for five minutes',
			habit: habitName
		});

		const row = doItNowList(page).getByRole('listitem').filter({ hasText: 'Stretch' });
		await expect(row).toContainText(`Habit: ${habitName}`);
		await row.getByRole('button').click();

		const loggedCount = async () =>
			(
				await query(
					(sql) => sql<{ n: number }[]>`
						select count(*)::int as n from habit_logs hl
						join habits h on h.id = hl.habit_id
						where h.name = ${habitName}
					`
				)
			)[0]!.n;
		await expect.poll(loggedCount).toBe(1);

		await row.getByRole('button').click();
		await expect.poll(loggedCount).toBe(0);
	});

	/**
	 * Hard rule 5's exact failure mode: the add-step form stays open for
	 * adding several steps in a row and has a `<Select>` (the habit picker).
	 * Without `{#key addStepFormKey}`, a plain `use:enhance` reset reverts
	 * the picker to the DOM's original default rather than "No habit", which
	 * would leave the second step silently linked to the first one's habit.
	 */
	test('the add-step habit picker does not carry the previous step’s choice to the next add', async ({
		page
	}) => {
		const habitName = 'Fictional Picker Habit';
		await query(
			(sql) => sql`
				insert into habits (household_id, owner_user_id, name, created_by, updated_by)
				select m.household_id, u.id, ${habitName}, u.id, u.id
				from users u join household_members m on m.user_id = u.id
				where u.username = ${PERSON.username}
			`
		);

		await addRoutine(page, 'Fictional Picker Routine');
		await page.getByRole('button', { name: 'Edit' }).click();
		const form = addStepForm(page);

		await form.getByRole('textbox', { name: 'Title', exact: true }).fill('First step');
		await form
			.getByRole('textbox', { name: 'Average version', exact: true })
			.fill('Do the first thing');
		await form.getByLabel('Linked habit').selectOption({ label: habitName });
		await form.getByRole('button', { name: 'Add step' }).click();
		await expect(editSheet(page).getByText(stepLine('First step'))).toBeVisible();

		// The form the second step is typed into is the freshly-drawn one, not
		// the one that still held "Fictional Picker Habit" a moment ago.
		await expect(addStepForm(page).getByLabel('Linked habit')).toHaveValue('');
		await addStepForm(page)
			.getByRole('textbox', { name: 'Title', exact: true })
			.fill('Second step');
		await addStepForm(page)
			.getByRole('textbox', { name: 'Average version', exact: true })
			.fill('Do the second thing');
		await addStepForm(page).getByRole('button', { name: 'Add step' }).click();
		await expect(editSheet(page).getByText(stepLine('Second step'))).toBeVisible();
		await editSheet(page).getByRole('button', { name: 'Close' }).click();

		const secondStep = doItNowList(page).getByRole('listitem').filter({ hasText: 'Second step' });
		await expect(secondStep).not.toContainText('Habit:');
		const firstStep = doItNowList(page).getByRole('listitem').filter({ hasText: 'First step' });
		await expect(firstStep).toContainText(`Habit: ${habitName}`);
	});

	test('every tap target on the do-it-now view is at least 44px', async ({ page }) => {
		await addRoutine(page, 'Fictional Target Size Routine');
		await addStep(page, { title: 'Tap me', averageVersion: 'A step to tap' });

		const targets = [
			...(await doItNowList(page).getByRole('button').all()),
			...(await page.getByRole('link', { name: /^(High|Average|1% day)$/ }).all())
		];
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			const box = await target.boundingBox();
			expect(box).not.toBeNull();
			expect(box!.height).toBeGreaterThanOrEqual(44);
		}
	});

	test('the page never scrolls sideways', async ({ page }) => {
		await addRoutine(page, 'Fictional Width Routine');
		await addStep(page, { title: 'A step', averageVersion: 'Something to do' });

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});
});
