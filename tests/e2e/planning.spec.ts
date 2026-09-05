import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Projects, goals and life areas, driven the way a person drives them
 * (UI-005, UI-006, UI-007).
 *
 * Two things here can only be caught in a browser.
 *
 * The first is the concurrency token. Every edit form carries the row's
 * `updatedAt`, and rendering the `Date` directly drops its milliseconds — the
 * precondition compares to the millisecond, so *every* save comes back 409.
 * `tasks.spec.ts` exists because that shipped once; these are the same guards
 * for the planning forms, and they check both halves: that an ordinary save
 * succeeds, and that a genuinely stale one is refused.
 *
 * The second is derived progress. The numbers on these pages are counted from
 * live tasks rather than stored, so the only honest test drives the tasks and
 * then reads the page — including reading the same figure in two places, which
 * is what a stored percentage used to get wrong.
 */

const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-planning-owner', displayName: 'Planning Owner', role: 'admin' };
const PASSWORD = 'planning-spec-password-2026';
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

		// Upsert, matching tasks.spec.ts: the seed must be safe to run twice and
		// must not remove a row another spec is mid-sign-in with.
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

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

/**
 * Names are made unique per call. Playwright retries a failed case, and a fixed
 * name would then exist twice — every locator becomes a strict-mode violation
 * and the real failure is buried under a selector error.
 */
const unique = (label: string) =>
	`${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Creates a record from a list page and opens it. */
async function create(page: Page, path: string, field: string, name: string) {
	await page.goto(path);
	await page.getByLabel(field).fill(name);
	await page.locator('form[action="?/create"]').getByRole('button', { name: 'Add' }).click();
	await expect(page.getByRole('link', { name })).toBeVisible();
}

const openProject = async (page: Page, name: string) => {
	await create(page, '/projects', 'New project', name);
	await page.getByRole('link', { name }).click();
	await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
};

/** The "add a task" form on a project page, told apart by its hidden kind. */
const addForm = (page: Page, kind: 'task' | 'milestone') =>
	page.locator(`form:has(input[name="kind"][value="${kind}"])`);

async function addProjectTask(page: Page, kind: 'task' | 'milestone', title: string) {
	const form = addForm(page, kind);
	await form.getByLabel(kind === 'task' ? 'Add a task' : 'Add a milestone').fill(title);
	await form.getByRole('button', { name: 'Add' }).click();
	await expect(page.getByRole('link', { name: title })).toBeVisible();
}

test('a project saves, and its concurrency token renders as an ISO timestamp', async ({ page }) => {
	await signIn(page);
	const name = unique('Token round trip');
	const renamed = unique('Renamed properly');
	await openProject(page, name);

	// The precondition compares to the millisecond, so the rendered value must
	// carry them. A Date interpolated directly renders as a locale string.
	const token = await page.locator('form[action="?/save"] input[name="updatedAt"]').inputValue();
	expect(token, 'updatedAt must render as an ISO timestamp').toMatch(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
	);

	// And the save itself must go through: the milliseconds bug turned every
	// one of these into a 409 for a record nobody else had touched.
	await page.getByLabel('Name').fill(renamed);
	await page.getByLabel('Status').selectOption('on_hold');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByRole('status')).toHaveText('Saved.');
	await expect(page.getByRole('heading', { name: renamed, level: 1 })).toBeVisible();
	await expect(page.getByText('On hold').first()).toBeVisible();
});

test('project progress is counted from its tasks, and the list agrees', async ({ page }) => {
	await signIn(page);
	const name = unique('Counted project');
	await openProject(page, name);

	const first = unique('Step one');
	await addProjectTask(page, 'task', first);
	await addProjectTask(page, 'task', unique('Step two'));
	await addProjectTask(page, 'milestone', unique('Ready to paint'));

	// Nothing done yet: three tasks, none closed. A milestone is a task, so it
	// counts here too.
	await expect(page.getByText('3 open · 0 closed of 3')).toBeVisible();

	await page.getByRole('button', { name: `Complete ${first}` }).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.getByText('2 open · 1 closed of 3')).toBeVisible();
	await expect(
		page.getByRole('progressbar', { name: `${name}: 1 of 3 tasks closed` })
	).toBeVisible();

	// The same figure on the list, which reaches it through a different query.
	// A stored percentage is exactly what used to make these two disagree.
	await page.goto('/projects');
	await expect(
		page.getByRole('progressbar', { name: `${name}: 1 of 3 tasks closed` })
	).toBeVisible();
});

test('a save from a stale tab is refused', async ({ page }) => {
	await signIn(page);
	const name = unique('Two tabs');
	await openProject(page, name);
	const url = page.url();

	// A second tab, in the same session, saves first. The first tab is now
	// holding a token for a version that no longer exists.
	const other = await page.context().newPage();
	await other.goto(url);
	await other.getByLabel('Description').fill('Changed from the other tab.');
	await other.getByRole('button', { name: 'Save' }).click();
	await expect(other.getByRole('status')).toHaveText('Saved.');
	await other.close();

	await page.getByLabel('Description').fill('Changed from the stale tab.');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByRole('alert')).toContainText('changed elsewhere');

	// And the refusal was real: the other tab's text is still what is stored.
	await page.reload();
	await expect(page.getByLabel('Description')).toHaveValue('Changed from the other tab.');
});

test('a project can be archived and brought back', async ({ page }) => {
	await signIn(page);
	const name = unique('Archive me');
	await openProject(page, name);

	await page.getByRole('button', { name: 'Archive project' }).click();
	await expect(page).toHaveURL('/projects');
	await expect(page.getByRole('link', { name })).toHaveCount(0);

	await page.goto('/projects?view=archived');
	await page.getByRole('link', { name }).click();
	await page.getByRole('button', { name: 'Restore project' }).click();
	// Wait for the restore to land rather than for the click: the control flips
	// to "Archive" only once the action has come back and the page reloaded.
	await expect(page.getByRole('button', { name: 'Archive project' })).toBeVisible();

	await page.goto('/projects');
	await expect(page.getByRole('link', { name })).toBeVisible();
});

test('an area tracks when it was last reviewed', async ({ page }) => {
	await signIn(page);
	const name = unique('Reviewed area');
	await create(page, '/areas', 'New area', name);
	await page.getByRole('link', { name }).click();

	await expect(page.getByText('No review cadence').first()).toBeVisible();

	await page.getByLabel('Review every').fill('7');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await expect(page.getByText('Never reviewed · every 7 days').first()).toBeVisible();

	await page.getByRole('button', { name: 'Mark reviewed today' }).click();
	await expect(page.getByRole('status')).toHaveText('Marked as reviewed today.');
	await expect(page.getByText('Review in 7 days').first()).toBeVisible();

	// And the list agrees, which is the whole point of a review cadence.
	await page.goto('/areas');
	await expect(page.getByText('Review in 7 days').first()).toBeVisible();
});

test('an area counts the tasks put straight onto it', async ({ page }) => {
	await signIn(page);
	const name = unique('Direct tasks area');
	await create(page, '/areas', 'New area', name);
	await page.getByRole('link', { name }).click();

	const task = unique('Straight onto the area');
	await page.getByLabel('Add a task to this area').fill(task);
	await page.locator('form[action="?/addTask"]').getByRole('button', { name: 'Add' }).click();

	await expect(page.getByRole('link', { name: task })).toBeVisible();
	await expect(page.getByText('1 open · 0 closed of 1')).toBeVisible();

	await page.goto('/areas');
	const tile = page.locator('.tile').filter({ hasText: name });
	await expect(tile.getByText('1 open direct task')).toBeVisible();
});

test('a goal shows the projects and areas linked to it', async ({ page }) => {
	await signIn(page);
	const goalTitle = unique('Linked goal');
	const projectName = unique('Linked project');
	const areaName = unique('Linked area');
	// Two records that are *not* linked, so the page has to be filtering rather
	// than simply listing everything the household owns.
	const otherProject = unique('Unlinked project');
	const otherArea = unique('Unlinked area');

	await create(page, '/goals', 'New goal', goalTitle);
	await create(page, '/areas', 'New area', areaName);
	await create(page, '/areas', 'New area', otherArea);
	await create(page, '/projects', 'New project', otherProject);
	await openProject(page, projectName);
	await addProjectTask(page, 'task', unique('Work for the goal'));

	// The join tables are import-only — the repositories expose no writer, so
	// the pages offer no control for them and the links are seeded here the way
	// the importer makes them.
	const goalId = await withDb(async (sql) => {
		const [goal] = await sql<{ id: string }[]>`select id from goals where title = ${goalTitle}`;
		const [project] = await sql<
			{ id: string }[]
		>`select id from projects where name = ${projectName}`;
		const [area] = await sql<{ id: string }[]>`select id from areas where name = ${areaName}`;
		await sql`insert into project_goals (project_id, goal_id) values (${project!.id}, ${goal!.id})`;
		await sql`insert into goal_areas (goal_id, area_id) values (${goal!.id}, ${area!.id})`;
		return goal!.id;
	});

	await page.goto(`/goals/${goalId}`);
	await expect(page.getByRole('link', { name: projectName })).toBeVisible();
	await expect(page.getByRole('link', { name: areaName })).toBeVisible();
	await expect(page.getByRole('link', { name: otherProject })).toHaveCount(0);
	await expect(page.getByRole('link', { name: otherArea })).toHaveCount(0);
	await expect(
		page.getByRole('progressbar', { name: `${projectName}: 0 of 1 tasks closed` })
	).toBeVisible();
	await expect(page.getByText('1 open · 0 closed of 1 across 1 project')).toBeVisible();
});

test('a tag is made, put on an area, and listed with what carries it', async ({ page }) => {
	await signIn(page);
	const tagName = unique('Cabin');
	const areaName = unique('Tagged area');

	await create(page, '/areas', 'New area', areaName);
	await page.goto('/areas/tags');
	await page.getByLabel('New tag').fill(tagName);
	await page.locator('form[action="?/create"]').getByRole('button', { name: 'Add' }).click();
	// The name alone appears twice on the row — as its title and inside the
	// archive control's accessible name — so the row is what is asserted.
	const fresh = page.getByRole('listitem').filter({ hasText: tagName });
	await expect(fresh.getByText('Not on anything yet')).toBeVisible();

	await page.goto('/areas');
	await page.getByRole('link', { name: areaName }).click();
	await page.getByLabel('Add a tag').selectOption({ label: tagName });
	await page.locator('form[action="?/attachTag"]').getByRole('button', { name: 'Add' }).click();
	await expect(page.getByRole('link', { name: tagName })).toBeVisible();

	// The tags page finds the carrier from the other end of the relation.
	await page.goto('/areas/tags');
	const row = page.getByRole('listitem').filter({ hasText: tagName });
	await expect(row.getByText('1 area')).toBeVisible();
	await expect(row.getByRole('link', { name: areaName })).toBeVisible();
});

test('the planning pages are usable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await signIn(page);
	const name = unique('Phone sized project');
	await openProject(page, name);

	const task = unique('Tap me');
	await addProjectTask(page, 'task', task);

	// The completion control is the one thing that has to be thumb-reachable.
	const tick = page.getByRole('button', { name: `Complete ${task}` });
	const box = await tick.boundingBox();
	expect(box, 'the tick should be rendered').not.toBeNull();
	expect(box!.height).toBeGreaterThanOrEqual(44);
	expect(box!.width).toBeGreaterThanOrEqual(44);

	// Nothing on the areas grid may push the page sideways on a phone.
	await page.goto('/areas');
	const tiles = page.locator('.tile');
	for (const tile of await tiles.all()) {
		const tileBox = await tile.boundingBox();
		expect(tileBox!.width).toBeLessThanOrEqual(PHONE.width);
	}
});
