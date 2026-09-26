import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Planning a week of meals and shopping for it, on a phone.
 *
 * The planning sheet is a <dialog>, its recipe picker is filtered in the
 * browser and the shopping report is a live region — none of which a
 * server-side test sees. This drives the whole loop the way it is used:
 * one thumb, a 375px screen, plan a meal, shop for the week, check the list.
 *
 * The week is a fixed one in 2031, reached with `?from=`, so the result does
 * not depend on today. Every name is invented.
 */

const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-food-cook', displayName: 'Food Cook', role: 'member' };
const PASSWORD = 'food-planning-spec-password-2031';
const PHONE = { width: 375, height: 812 };

const WEEK = '2031-03-10';
const WEEK_END = '2031-03-16';
const RECIPES = ['Leek and barley stew', 'Rye porridge'];
const INGREDIENTS = [
	{ name: 'Winter leeks', status: 'not_needed', aisle: 'Produce' },
	{ name: 'Pearl barley', status: 'not_needed', aisle: 'Grains' },
	{ name: 'Cultured butter', status: 'in_stock', aisle: 'Dairy' }
];

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

/*
 * Before each test rather than once: a retry must start from the same week,
 * not from the one the failed attempt left half-planned. Everything this spec
 * creates is removed and made again by name, which no other spec uses.
 */
test.beforeEach(async () => {
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

		await sql`delete from meal_plans
		          where household_id = ${householdId} and on_date between ${WEEK} and ${WEEK_END}`;
		await sql`delete from recipes where household_id = ${householdId} and name in ${sql(RECIPES)}`;
		await sql`delete from ingredients
		          where household_id = ${householdId} and name in ${sql(INGREDIENTS.map((i) => i.name))}`;

		const [stew] = await sql<{ id: string }[]>`
			insert into recipes (household_id, name, courses, cook_minutes)
			values (${householdId}, ${RECIPES[0]!}, '{Dinner,Lunch}', 45),
			       (${householdId}, ${RECIPES[1]!}, '{Breakfast}', 10)
			returning id
		`;
		for (const item of INGREDIENTS) {
			const [row] = await sql<{ id: string }[]>`
				insert into ingredients (household_id, name, status, aisle)
				values (${householdId}, ${item.name}, ${item.status}, ${item.aisle})
				returning id
			`;
			await sql`insert into recipe_ingredients (recipe_id, ingredient_id)
			          values (${stew!.id}, ${row!.id})`;
		}
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

test.use({ viewport: PHONE });

test('plan a meal, shop for the week, and see it on the list', async ({ page }) => {
	await signIn(page);
	await page.goto(`/food?from=${WEEK}`);

	const wednesday = page.getByRole('article', { name: /Wed/ });
	await expect(wednesday.getByText('Nothing planned')).toBeVisible();

	// Plan: the day's own "+" opens the sheet for that day.
	await wednesday.getByRole('button', { name: /Plan a meal for Wednesday/ }).click();
	const sheet = page.getByRole('dialog', { name: /Plan Wednesday/ });
	await expect(sheet).toBeVisible();

	await sheet.getByRole('radio', { name: 'Lunch' }).check();
	await sheet.getByRole('searchbox', { name: 'Find a recipe' }).fill('barley');
	// The search narrows the list in the browser.
	await expect(sheet.getByRole('button', { name: /Rye porridge/ })).toHaveCount(0);
	await sheet.getByRole('button', { name: /Leek and barley stew/ }).click();

	await expect(sheet).toBeHidden();
	await expect(wednesday.getByText('Leek and barley stew', { exact: true })).toBeVisible();
	await expect(wednesday.getByText('Lunch', { exact: true })).toBeVisible();

	// Shop for the week, and be told what that did.
	await page.getByRole('button', { name: /ingredients .* to the shopping list/ }).click();
	await expect(page.getByRole('status')).toHaveText(
		'Added 2 ingredients to the shopping list; 1 already in stock.'
	);

	const list = page.getByRole('region', { name: 'Shopping list' });
	await expect(list.getByText('Winter leeks', { exact: true })).toBeVisible();
	await expect(list.getByText('Pearl barley', { exact: true })).toBeVisible();
	// In the house already, so not on the list.
	await expect(list.getByText('Cultured butter', { exact: true })).toHaveCount(0);

	// Nothing on the way pushed the page sideways.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);

	// Running it again is harmless and says so.
	await page.getByRole('button', { name: /ingredients .* to the shopping list/ }).click();
	await expect(page.getByRole('status')).toHaveText(
		'Nothing new to add to the shopping list; 2 already on it, 1 already in stock.'
	);
});

test('undo takes the week back off the list, and a meal can be removed', async ({ page }) => {
	await signIn(page);
	await page.goto(`/food?from=${WEEK}`);

	const monday = page.getByRole('article', { name: /Mon/ });
	await monday.getByRole('button', { name: /Plan a meal for Monday/ }).click();
	const sheet = page.getByRole('dialog', { name: /Plan Monday/ });
	// Dinner is the default meal.
	await expect(sheet.getByRole('radio', { name: 'Dinner' })).toBeChecked();
	await sheet.getByRole('button', { name: /Leek and barley stew/ }).click();
	await expect(monday.getByText('Leek and barley stew', { exact: true })).toBeVisible();

	await page.getByRole('button', { name: /ingredients .* to the shopping list/ }).click();
	const list = page.getByRole('region', { name: 'Shopping list' });
	await expect(list.getByText('Winter leeks', { exact: true })).toBeVisible();

	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByRole('status')).toHaveText(
		'Took 2 ingredients back off the shopping list.'
	);
	await expect(list.getByText('Winter leeks', { exact: true })).toHaveCount(0);

	await monday.getByRole('button', { name: /Remove Leek and barley stew from dinner/ }).click();
	await expect(monday.getByText('Nothing planned')).toBeVisible();
	// Focus lands on the day's own control rather than falling out of the page.
	await expect(monday.getByRole('button', { name: /Plan a meal for Monday/ })).toBeFocused();
});

test('the planning sheet works from the keyboard, with thumb-sized targets', async ({ page }) => {
	await signIn(page);
	await page.goto(`/food?from=${WEEK}`);

	const friday = page.getByRole('article', { name: /Fri/ });
	const plus = friday.getByRole('button', { name: /Plan a meal for Friday/ });
	const box = await plus.boundingBox();
	expect(box!.width).toBeGreaterThanOrEqual(44);
	expect(box!.height).toBeGreaterThanOrEqual(44);

	await plus.focus();
	await page.keyboard.press('Enter');
	const sheet = page.getByRole('dialog', { name: /Plan Friday/ });
	await expect(sheet).toBeVisible();
	// Measured once the sheet has finished rising: mid-animation its boxes sit
	// on fractional pixels and a 44px target reads as 43.99997.
	await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

	for (const target of [
		sheet.getByRole('button', { name: /Rye porridge/ }),
		sheet.locator('label').filter({ hasText: 'Breakfast' })
	]) {
		const size = await target.boundingBox();
		expect(size!.height).toBeGreaterThanOrEqual(44);
	}

	// Escape closes it, as a native dialog should.
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();

	// And the search box plans the only match on Enter, without a pointer.
	await plus.focus();
	await page.keyboard.press('Enter');
	await sheet.getByRole('radio', { name: 'Breakfast' }).check();
	await sheet.getByRole('searchbox', { name: 'Find a recipe' }).fill('porridge');
	await page.keyboard.press('Enter');
	await expect(sheet).toBeHidden();
	await expect(friday.getByText('Rye porridge', { exact: true })).toBeVisible();
	const remove = friday.getByRole('button', { name: /Remove Rye porridge/ });
	expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('a sheet closed with Escape opens again at once', async ({ page }) => {
	await signIn(page);
	await page.goto(`/food?from=${WEEK}`);

	const friday = page.getByRole('article', { name: /Fri/ });
	const plus = friday.getByRole('button', { name: /Plan a meal for Friday/ });
	const sheet = page.getByRole('dialog', { name: /Plan Friday/ });

	await plus.click();
	await expect(sheet).toBeVisible();

	// Escape closes a <dialog> at once but only queues its `close` event, and a
	// browser may run the next input before that task. So a quick Escape, "+"
	// used to reach "+" while the sheet still believed it was open — the tap
	// did nothing, and the late `close` then shut it for good. This is that
	// order, made deterministic: close as Escape does, press "+" in the same
	// task, and only then let the queued event run.
	await page.evaluate(() => {
		const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
		const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
			/Plan a meal for Friday/.test(b.getAttribute('aria-label') ?? b.textContent ?? '')
		);
		if (!dialog || !button) throw new Error('sheet or button missing');
		dialog.requestClose();
		button.click();
	});

	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('radio', { name: 'Breakfast' })).toBeVisible();
});
