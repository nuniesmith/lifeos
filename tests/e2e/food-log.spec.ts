import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * The food log (migration 0032): quick-adding a food, a recipe and a custom
 * entry, meal and day totals, editing, deleting, and the household-visibility
 * toggle on another member's shared entry.
 *
 * Seeds an account of its own for the reason health-tags.spec.ts and
 * health-measurements.spec.ts give for theirs: borrowing another file's
 * credentials would make this one depend on the order the suite runs in.
 * Its entries and library rows are cleared before each test, so a retry
 * meets an empty log rather than its first attempt's rows.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const PERSON = { username: 'e2e-foodlog-owner', displayName: 'Foodlog Owner', role: 'member' };
const PASSWORD = 'foodlog-spec-password-2026';
const PARTNER = { username: 'e2e-foodlog-partner', displayName: 'Foodlog Partner', role: 'member' };

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

let householdId = '';
let ownerId = '';
let foodId = '';
let recipeId = '';

test.beforeAll(async () => {
	await query(async (sql) => {
		const passwordHash = await hashPassword(PASSWORD);
		const households = await sql<{ id: string }[]>`
			select id from households order by created_at limit 1
		`;
		householdId =
			households[0]?.id ??
			(
				await sql<{ id: string }[]>`
					insert into households (name) values ('Household') returning id
				`
			)[0]!.id;

		const [owner] = await sql<{ id: string }[]>`
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
		ownerId = owner!.id;
		await sql`
			insert into household_members (household_id, user_id)
			values (${householdId}, ${ownerId})
			on conflict do nothing
		`;

		const [partner] = await sql<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash, must_change_credentials)
			values (${PARTNER.username}, ${PARTNER.displayName}, ${PARTNER.role}, ${passwordHash}, false)
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
			values (${householdId}, ${partner!.id})
			on conflict do nothing
		`;

		// A food and a recipe for the picker — fixed fictional names, reinserted
		// fresh each run rather than upserted: nothing else here depends on
		// their id staying stable across separate manual runs of this file.
		await sql`delete from foods where household_id = ${householdId} and name = 'Fictional Oat Bowl'`;
		const [food] = await sql<{ id: string }[]>`
			insert into foods (household_id, name, serving, kcal_per_serving, protein_g)
			values (${householdId}, 'Fictional Oat Bowl', '1 bowl', 200, 20)
			returning id
		`;
		foodId = food!.id;

		await sql`delete from recipes where household_id = ${householdId} and name = 'Fictional Lentil Soup'`;
		const [recipe] = await sql<{ id: string }[]>`
			insert into recipes (household_id, name, kcal_per_serving, protein_g)
			values (${householdId}, 'Fictional Lentil Soup', 300, 25)
			returning id
		`;
		recipeId = recipe!.id;
	});
});

test.beforeEach(async () => {
	await query(
		(sql) => sql`
			delete from food_log_entries
			where owner_user_id in (
				select id from users where username in (${PERSON.username}, ${PARTNER.username})
			)
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

const dayTotal = (page: Page) => page.getByRole('region', { name: /’s total$/ });
const meal = (page: Page, name: string) => page.getByRole('region', { name });

test.describe('the food log', () => {
	test.use({ viewport: PHONE });

	test('logs a food, a recipe, and a custom entry, with meal and day totals', async ({ page }) => {
		await signIn(page);
		await page.goto('/food/log');

		// A food, for breakfast.
		await page.getByLabel('Food or recipe').selectOption(`food:${foodId}`);
		await page.getByRole('spinbutton', { name: 'Servings' }).fill('1');
		await page.getByLabel('Meal').selectOption('breakfast');
		await page.getByRole('button', { name: 'Add to log' }).click();

		// A recipe, for lunch.
		await page.getByLabel('Food or recipe').selectOption(`recipe:${recipeId}`);
		await page.getByRole('spinbutton', { name: 'Servings' }).fill('1');
		await page.getByLabel('Meal').selectOption('lunch');
		await page.getByRole('button', { name: 'Add to log' }).click();

		// A one-off, for a snack — its own typed name and nutrients.
		await page
			.getByRole('textbox', { name: 'Name', exact: true })
			.fill('Fictional gas-station snack');
		await page.getByRole('spinbutton', { name: 'Calories' }).fill('150');
		await page.getByRole('spinbutton', { name: 'Protein' }).fill('10');
		await page.getByLabel('Meal').selectOption('snack');
		await page.getByRole('button', { name: 'Add to log' }).click();

		await expect(meal(page, 'Breakfast')).toContainText('Fictional Oat Bowl');
		await expect(meal(page, 'Breakfast')).toContainText('200 kcal');
		await expect(meal(page, 'Lunch')).toContainText('Fictional Lentil Soup');
		await expect(meal(page, 'Lunch')).toContainText('300 kcal');
		await expect(meal(page, 'Snacks')).toContainText('Fictional gas-station snack');
		await expect(meal(page, 'Snacks')).toContainText('150 kcal');

		// 200 + 300 + 150 kcal; 20 + 25 + 10 g protein.
		await expect(dayTotal(page)).toContainText('650');
		await expect(dayTotal(page)).toContainText('55');
	});

	test('edits an entry’s servings, moving the day total', async ({ page }) => {
		await signIn(page);
		await page.goto('/food/log');

		await page.getByLabel('Food or recipe').selectOption(`food:${foodId}`);
		await page.getByRole('spinbutton', { name: 'Servings' }).fill('1');
		await page.getByLabel('Meal').selectOption('breakfast');
		await page.getByRole('button', { name: 'Add to log' }).click();

		await expect(dayTotal(page)).toContainText('200');

		const row = page.getByRole('listitem').filter({ hasText: 'Fictional Oat Bowl' });
		await row.getByRole('button', { name: 'Edit' }).click();
		const sheet = page.getByRole('dialog', { name: 'Edit entry' });
		await sheet.getByRole('spinbutton', { name: 'Servings' }).fill('2');
		await sheet.getByRole('button', { name: 'Save changes' }).click();

		// 2 servings of 200 kcal / 20 g protein each.
		await expect(dayTotal(page)).toContainText('400');
		await expect(row).toContainText('2 servings');
	});

	test('deletes an entry outright', async ({ page }) => {
		await signIn(page);
		await page.goto('/food/log');

		await page.getByLabel('Food or recipe').selectOption(`food:${foodId}`);
		await page.getByLabel('Meal').selectOption('breakfast');
		await page.getByRole('button', { name: 'Add to log' }).click();
		await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Fictional toast');
		await page.getByLabel('Meal').selectOption('breakfast');
		await page.getByRole('button', { name: 'Add to log' }).click();

		const breakfast = meal(page, 'Breakfast');
		await expect(breakfast.getByRole('listitem')).toHaveCount(2);

		await breakfast
			.getByRole('listitem')
			.filter({ hasText: 'Fictional toast' })
			.getByRole('button', { name: 'Delete' })
			.click();

		// An empty state may replace the list once the other entry is deleted
		// too, so this counts what remains rather than asserting on absent text.
		await expect(breakfast.getByRole('listitem')).toHaveCount(1);
		await expect(breakfast).not.toContainText('Fictional toast');
	});

	test('shows a household member’s shared entry only when asked for', async ({ page }) => {
		await query(
			(sql) => sql`
				insert into food_log_entries (
					household_id, owner_user_id, eaten_on, meal, name, visibility, kcal_override
				)
				select ${householdId}, u.id, current_date, 'dinner', 'Fictional partner’s dinner',
				       'household', 400
				from users u where u.username = ${PARTNER.username}
			`
		);

		await signIn(page);
		await page.goto('/food/log');
		await expect(page.getByText('Fictional partner’s dinner')).toHaveCount(0);

		await page.getByRole('link', { name: /shared entries/ }).click();
		await expect(meal(page, 'Dinner')).toContainText('Fictional partner’s dinner');
		await expect(meal(page, 'Dinner')).toContainText('shared');

		// The partner's entry must never move the owner's own totals, however
		// it is displayed.
		await expect(dayTotal(page)).not.toContainText('400');
	});
});
