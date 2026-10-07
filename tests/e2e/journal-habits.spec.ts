import { expect, test, type Locator, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * The journal and the habit check-in (UI-009), on the phone they are for.
 *
 * ── Why this file seeds its own accounts ──────────────────────────────────
 * auth.spec.ts owns the bootstrap administrator and renames it, so borrowing
 * those credentials would make this file's result depend on run order. This
 * file writes two accounts of its own with the project's own password
 * hashing, as an upsert so it is idempotent and safe against itself.
 *
 * Two accounts, in the *same household*, and the second one is an admin. A
 * privacy claim proved by an outsider proves nothing: household isolation
 * would refuse that read anyway. The claim this file has to prove is the
 * narrower one — a daily log is private from the other member of your own
 * household, including an administrator of it.
 * ─────────────────────────────────────────────────────────────────────────
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const OWNER = { username: 'e2e-journal-owner', displayName: 'Journal Owner', role: 'member' };
const OTHER = { username: 'e2e-journal-other', displayName: 'Journal Other', role: 'admin' };
const PASSWORD = 'journal-spec-password-2026';

/** The device the acceptance gate names. */
const PHONE = { width: 390, height: 844 };

/**
 * Days in the past, so the editor is never asked to write a future date and
 * the "next day" step is always available from them.
 */
const EARLIER = '2026-04-10';
const LATER = '2026-04-11';

/** Runs one query and closes the connection; there is no pool to leak. */
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
			// An upsert rather than delete-then-insert, so the seed is safe to
			// run again against a database that is not fresh.
			const [user] = await sql<{ id: string }[]>`
				insert into users (username, display_name, role, password_hash, must_change_credentials)
				values (
					${person.username}, ${person.displayName}, ${person.role}, ${passwordHash}, false
				)
				on conflict (username) where username is not null do update set
					display_name = excluded.display_name,
					role = excluded.role,
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

async function signIn(page: Page, username: string) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

/**
 * Forms are located by their action rather than by reaching for a label on the
 * page as a whole. A habit's tick carries an accessible name like "Log Old
 * name", which a page-wide `getByLabel('Name')` matches — scoping the lookup
 * to the form is what keeps the test asking about the field it means.
 */
const editorForm = (page: Page) => page.locator('form[action="?/save"]');
const addHabitForm = (page: Page) => page.locator('form[action="?/create"]');

/** A name unique to this attempt, so a retry cannot collide with its own first
    run's records in a database that is only reset per suite. */
const attempt = (name: string) => {
	const retry = test.info().retry;
	return retry === 0 ? name : `${name} ${retry}`;
};

/** Fills the editor and saves, waiting for the save to have actually landed. */
async function writeEntry(page: Page, fields: Record<string, string>) {
	const form = editorForm(page);
	const version = form.locator('input[name="updatedAt"]');
	// Absent until the day has an entry. Either way the value must change
	// before the save can be said to have happened.
	const before = (await version.count()) > 0 ? await version.inputValue() : '';

	for (const [label, value] of Object.entries(fields)) {
		await form.getByLabel(label, { exact: true }).fill(value);
	}
	await form.getByRole('button', { name: /entry$/ }).click();

	// The confirmation on its own is not a signal: after the first save it is
	// still on screen and would pass instantly. The row's version is.
	await expect(version).not.toHaveValue(before);
	await expect(page.getByRole('status')).toHaveText('Saved.');
}

test.describe('the journal', () => {
	test.use({ viewport: PHONE });

	test('opens on today and saves an entry that reads back', async ({ page }) => {
		await signIn(page, OWNER.username);
		await page.goto('/journal');

		// The day comes from the server in the household's timezone; the test
		// must not decide what "today" is from its own clock.
		const today = await editorForm(page).locator('input[name="date"]').inputValue();
		expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		// Nothing offers to write tomorrow.
		await expect(page.getByRole('link', { name: 'Next day' })).toHaveCount(0);

		await writeEntry(page, {
			Mood: 'Level',
			Highlight: 'Sat in the sun',
			'Grateful for': 'A slow morning',
			'Today, as it happened': 'Nothing much happened and that was the good part.'
		});
		// Scoped to the Energy fieldset: migration 0038 added two more 1-5
		// scales (Activation, Effectiveness) to the same form, each also
		// offering a radio named "4" -- a page-wide lookup is now ambiguous.
		await editorForm(page)
			.locator('fieldset')
			.filter({ hasText: 'Energy' })
			.getByRole('radio', { name: '4' })
			.check();
		await writeEntry(page, {});

		// A fresh request, not the state the form was left in.
		await page.reload();
		const form = editorForm(page);
		await expect(form.getByLabel('Highlight')).toHaveValue('Sat in the sun');
		await expect(form.getByLabel('Today, as it happened')).toHaveValue(
			'Nothing much happened and that was the good part.'
		);
		await expect(
			form.locator('fieldset').filter({ hasText: 'Energy' }).getByRole('radio', { name: '4' })
		).toBeChecked();
	});

	test('a second save edits the day rather than failing on it', async ({ page }) => {
		await signIn(page, OWNER.username);
		await page.goto(`/journal/${EARLIER}`);

		await writeEntry(page, { Highlight: 'First go' });
		await writeEntry(page, { Highlight: 'Second go' });

		await page.reload();
		await expect(editorForm(page).getByLabel('Highlight')).toHaveValue('Second go');

		// One entry per person per day is a database constraint. The editor has
		// to treat that as an edit, so the row count is the real assertion.
		const rows = await query(
			(sql) =>
				sql<{ n: number }[]>`
					select count(*)::int as n from daily_logs dl
					join users u on u.id = dl.owner_user_id
					where u.username = ${OWNER.username} and dl.on_date = ${EARLIER}::date
				`
		);
		expect(rows[0]!.n).toBe(1);
	});

	test('the other member cannot read it, even as an admin', async ({ page }) => {
		await signIn(page, OWNER.username);
		await page.goto(`/journal/${LATER}`);
		await writeEntry(page, {
			Highlight: 'Something private',
			'Today, as it happened': 'Written by the owner and nobody else.'
		});

		// The row really is private, not merely unrendered.
		const stored = await query(
			(sql) =>
				sql<{ visibility: string }[]>`
					select dl.visibility from daily_logs dl
					join users u on u.id = dl.owner_user_id
					where u.username = ${OWNER.username} and dl.on_date = ${LATER}::date
				`
		);
		expect(stored[0]!.visibility).toBe('private');

		await page.context().clearCookies();
		await signIn(page, OTHER.username);
		await page.goto(`/journal/${LATER}`);

		// The same day, the same household, an administrator — and an empty
		// editor, because the entry belongs to somebody else.
		const form = editorForm(page);
		await expect(form.getByLabel('Highlight')).toHaveValue('');
		await expect(form.getByLabel('Today, as it happened')).toHaveValue('');
		await expect(page.getByText('Something private')).toHaveCount(0);
		await expect(page.getByText('Written by the owner and nobody else.')).toHaveCount(0);
		// Not in the history list, and no version to edit it with either.
		await expect(page.locator(`a[href$="/journal/${LATER}"]`)).toHaveCount(0);
		await expect(form.locator('input[name="updatedAt"]')).toHaveCount(0);
	});

	test('steps between days and lists what has been written', async ({ page }) => {
		await signIn(page, OWNER.username);

		await page.goto(`/journal/${EARLIER}`);
		await writeEntry(page, { Highlight: 'The earlier day' });
		await page.goto(`/journal/${LATER}`);
		await writeEntry(page, { Highlight: 'The later day' });

		const days = page.getByRole('navigation', { name: 'Choose a day' });
		await days.getByRole('link', { name: 'Previous day' }).click();
		await expect(page).toHaveURL(`/journal/${EARLIER}`);
		await expect(editorForm(page).getByLabel('Highlight')).toHaveValue('The earlier day');

		await days.getByRole('link', { name: 'Next day' }).click();
		await expect(page).toHaveURL(`/journal/${LATER}`);
		await expect(editorForm(page).getByLabel('Highlight')).toHaveValue('The later day');

		// The history carries both, and each one opens its own day.
		const history = page.getByRole('list', { name: 'Journal history' });
		await expect(history.getByText('The earlier day')).toBeVisible();
		await history
			.getByRole('listitem')
			.filter({ hasText: 'The earlier day' })
			.getByRole('link')
			.click();
		await expect(page).toHaveURL(`/journal/${EARLIER}`);

		// And back to today in one tap from wherever you got to.
		await days.getByRole('link', { name: 'Today' }).click();
		await expect(page).toHaveURL('/journal');
	});

	test('jumps to a chosen day', async ({ page }) => {
		await signIn(page, OWNER.username);
		await page.goto('/journal');

		const jump = page.locator('form[action="?/go"]');
		await jump.getByLabel('Date').fill(EARLIER);
		await jump.getByRole('button', { name: 'Open' }).click();
		await expect(page).toHaveURL(`/journal/${EARLIER}`);
	});

	test('the page never scrolls sideways', async ({ page }) => {
		await signIn(page, OWNER.username);
		await page.goto('/journal');

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});
});

test.describe('habits', () => {
	test.use({ viewport: PHONE });

	/** Adds a habit from the list page and returns its row. */
	async function addHabit(page: Page, name: string, count = 1, period = 'day'): Promise<Locator> {
		await page.goto('/habits');
		const form = addHabitForm(page);
		await form.getByLabel('Name').fill(name);
		await form.getByLabel('How many').fill(String(count));
		await form.getByLabel('How often').selectOption(period);
		await form.getByRole('button', { name: 'Add habit' }).click();

		const row = page.getByRole('listitem').filter({ hasText: name });
		await expect(row).toHaveCount(1);
		return row;
	}

	test('adds a habit and checks it in with one tap', async ({ page }) => {
		await signIn(page, OWNER.username);
		const name = attempt('Stretch');
		const row = await addHabit(page, name);

		await expect(row).toContainText('Not yet today');
		await row.getByRole('button', { name: `Log ${name}` }).click();

		await expect(row.getByRole('button', { name: `Undo ${name}` })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(row).toContainText('Done today');

		// Survives a fresh request, so it was written and not merely toggled.
		await page.reload();
		await expect(page.getByRole('listitem').filter({ hasText: name })).toContainText('Done today');
	});

	test('a check-in is idempotent', async ({ page }) => {
		await signIn(page, OWNER.username);
		const name = attempt('Floss');
		const row = await addHabit(page, name);

		const habitId = await row.locator('input[name="id"]').inputValue();
		const day = await row.locator('input[name="day"]').inputValue();
		const origin = new URL(page.url()).origin;

		const post = (done: string) =>
			page.request.post('/habits?/toggle', {
				headers: { origin },
				form: { id: habitId, day, done }
			});

		// The same check-in three times, posted the way a form posts it. The
		// database is unique on (habit, person, day), so the second and third
		// must land on the same row rather than adding one or failing.
		for (let i = 0; i < 3; i++) {
			expect((await post('true')).ok()).toBe(true);
		}
		const ticked = await query(
			(sql) =>
				sql<{ n: number }[]>`
					select count(*)::int as n from habit_logs
					where habit_id = ${habitId}::uuid and on_date = ${day}::date
				`
		);
		expect(ticked[0]!.n).toBe(1);

		await page.reload();
		await expect(
			page
				.getByRole('listitem')
				.filter({ hasText: name })
				.getByRole('button', { name: `Undo ${name}` })
		).toHaveAttribute('aria-pressed', 'true');

		// Un-ticking twice is the same story in reverse: the day ends unlogged
		// either way, and neither call is an error.
		for (let i = 0; i < 2; i++) {
			expect((await post('false')).ok()).toBe(true);
		}
		const cleared = await query(
			(sql) =>
				sql<{ n: number }[]>`
					select count(*)::int as n from habit_logs
					where habit_id = ${habitId}::uuid and on_date = ${day}::date
				`
		);
		expect(cleared[0]!.n).toBe(0);
	});

	test('counts progress against a weekly target', async ({ page }) => {
		await signIn(page, OWNER.username);
		const name = attempt('Long walk');
		const row = await addHabit(page, name, 3, 'week');

		await expect(row).toContainText('0 of 3 this week');
		await row.getByRole('button', { name: `Log ${name}` }).click();
		await expect(page.getByRole('listitem').filter({ hasText: name })).toContainText(
			'1 of 3 this week'
		);
	});

	test('shows a habit history and takes a correction for a past day', async ({ page }) => {
		await signIn(page, OWNER.username);
		const name = attempt('Read a page');
		const row = await addHabit(page, name);
		await row.getByRole('link', { name }).click();

		await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Progress' })).toBeVisible();

		// Every day in the grid is a control, and a past one still works: a
		// tracker that cannot record yesterday is one people stop believing.
		const missed = page.getByRole('button', { name: /, not done$/ }).first();
		const label = (await missed.getAttribute('aria-label'))!;
		await missed.click();
		await expect(
			page.getByRole('button', { name: `${label.replace(', not done', '')}, done` })
		).toHaveCount(1);
	});

	test('pauses a habit and brings it back', async ({ page }) => {
		await signIn(page, OWNER.username);
		const name = attempt('Cold shower');
		const row = await addHabit(page, name);
		await row.getByRole('link', { name }).click();

		await page.getByRole('button', { name: 'Pause habit' }).click();
		await expect(page.getByRole('status')).toHaveText('Saved.');

		await page.goto('/habits');
		const paused = page.getByRole('list', { name: 'Paused habits' });
		await expect(paused.getByText(name)).toBeVisible();
		await expect(page.getByRole('list', { name: 'Habits for today' }).getByText(name)).toHaveCount(
			0
		);

		await paused
			.getByRole('listitem')
			.filter({ hasText: name })
			.getByRole('button', { name: 'Resume' })
			.click();
		await expect(
			page.getByRole('list', { name: 'Habits for today' }).getByText(name)
		).toBeVisible();
	});

	test('edits a habit name and target', async ({ page }) => {
		await signIn(page, OWNER.username);
		const before = attempt('Old name');
		const after = attempt('New name');

		const row = await addHabit(page, before);
		await row.getByRole('link', { name: before }).click();

		const form = editorForm(page);
		await form.getByLabel('Name').fill(after);
		await form.getByLabel('How many').fill('2');
		await form.getByLabel('How often').selectOption('week');
		await form.getByRole('button', { name: 'Save habit' }).click();
		await expect(page.getByRole('status')).toHaveText('Saved.');

		await page.goto('/habits');
		await expect(page.getByRole('listitem').filter({ hasText: after })).toContainText(
			'0 of 2 this week'
		);
		await expect(page.getByText(before, { exact: true })).toHaveCount(0);
	});

	test('every check-in target is at least 44px', async ({ page }) => {
		await signIn(page, OWNER.username);
		await addHabit(page, attempt('Water'));

		const ticks = page
			.getByRole('list', { name: 'Habits for today' })
			.getByRole('button', { name: /^(Log|Undo) / });
		expect(await ticks.count()).toBeGreaterThan(0);

		for (const tick of await ticks.all()) {
			const box = await tick.boundingBox();
			expect(box).not.toBeNull();
			expect(box!.height).toBeGreaterThanOrEqual(44);
			expect(box!.width).toBeGreaterThanOrEqual(44);
		}
	});

	test('the page never scrolls sideways', async ({ page }) => {
		await signIn(page, OWNER.username);
		await page.goto('/habits');

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});
});
