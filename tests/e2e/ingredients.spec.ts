import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Adding and editing an ingredient fully, and attaching one to a recipe with
 * a structured amount (migration 0026, PACK2-002), on the phone the pantry
 * and the recipe page are both used from.
 *
 * Seeds an account of its own for the reason health-measurements.spec.ts and
 * recipes.spec.ts do: borrowing another file's credentials would make this
 * one depend on the order the suite runs in. Everything this file creates
 * (the recipe, the ingredients) is named so it cannot collide with another
 * spec's fixtures and is removed before each test, so a retry meets a clean
 * pantry rather than its first attempt's half-made edits.
 */

const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-food-owner', displayName: 'Food Owner', role: 'member' };
const PASSWORD = 'ingredients-spec-password-2026';
const PHONE = { width: 375, height: 812 };

const INGREDIENT_NAME = 'Tinned tomatoes';
const RECIPE_NAME = 'Weeknight chili';
const EXISTING_NAME = 'Dried oregano';
const NEW_INLINE_NAME = 'Smoked paprika';

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

/*
 * Before each test rather than once: a retry must start clean, not from
 * whatever the failed attempt left half-edited. Every name below is unique to
 * this file, so the delete cannot touch another spec's fixtures.
 */
test.beforeEach(async () => {
	await withDb(async (sql) => {
		const passwordHash = await hashPassword(PASSWORD);
		const existing = await sql<{ id: string }[]>`
			select id from households order by created_at limit 1
		`;
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

		await sql`delete from recipes where household_id = ${householdId} and name = ${RECIPE_NAME}`;
		await sql`
			delete from ingredients
			where household_id = ${householdId}
			  and name in (${INGREDIENT_NAME}, ${EXISTING_NAME}, ${NEW_INLINE_NAME})
		`;

		const [recipe] = await sql<{ id: string }[]>`
			insert into recipes (household_id, name) values (${householdId}, ${RECIPE_NAME})
			returning id
		`;
		await sql`
			insert into ingredients (household_id, name, status, aisle)
			values (${householdId}, ${EXISTING_NAME}, 'in_stock', 'Spices')
		`;
		return recipe!.id;
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

async function recipeId(): Promise<string> {
	return withDb(async (sql) => {
		const [row] = await sql<{ id: string }[]>`select id from recipes where name = ${RECIPE_NAME}`;
		return row!.id;
	});
}

test.use({ viewport: PHONE });

test.describe('adding and editing an ingredient', () => {
	test('adds an ingredient with every field, edits it, then archives and restores it', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/food/ingredients');

		await page.getByRole('button', { name: 'Add ingredient' }).click();
		const addSheet = page.getByRole('dialog', { name: 'Add an ingredient' });
		await expect(addSheet).toBeVisible();

		await addSheet.getByLabel('Name').fill(INGREDIENT_NAME);
		await addSheet.getByLabel('Status').selectOption('use_up');
		await addSheet.getByLabel('Aisle').fill('Tins');
		await addSheet.getByLabel('Category').fill('Tinned vegetables');
		await addSheet.getByLabel('Store').fill('Corner shop');
		await addSheet.getByLabel('Staple — re-bought without thinking about it').check();
		await addSheet.getByLabel('Quantity').fill('2 tins');
		await addSheet.getByLabel('Structured amount').fill('800');
		await addSheet.getByLabel('Unit').selectOption('g');
		await addSheet.getByLabel('Preferred brand').fill('Housebrand');
		await addSheet.getByRole('button', { name: 'Add ingredient' }).click();

		await expect(addSheet).toBeHidden();
		const row = page.getByRole('listitem').filter({ hasText: INGREDIENT_NAME });
		// The structured amount (800 g) is shown in preference to the free text
		// ("2 tins") once both are set.
		await expect(row).toContainText('800 g');
		await expect(row.getByText('Staple', { exact: true })).toBeVisible();

		await row.getByRole('button', { name: 'Edit' }).click();
		const editSheet = page.getByRole('dialog', { name: `Edit ${INGREDIENT_NAME}` });
		await expect(editSheet.getByLabel('Aisle')).toHaveValue('Tins');
		await expect(editSheet.getByLabel('Structured amount')).toHaveValue('800');
		await editSheet.getByLabel('Status').selectOption('in_stock');
		await editSheet.getByLabel('Structured amount').fill('1.6');
		await editSheet.getByLabel('Unit').selectOption('kg');
		await editSheet.getByRole('button', { name: 'Save ingredient' }).click();
		await expect(editSheet).toBeHidden();

		await expect(row).toContainText('In stock');
		await expect(row).toContainText('1.6 kg');

		// Archive, then find it again from the archived view and restore it.
		await row.getByRole('button', { name: 'Edit' }).click();
		await page
			.getByRole('dialog', { name: `Edit ${INGREDIENT_NAME}` })
			.getByRole('button', { name: 'Archive ingredient' })
			.click();
		await expect(page.getByRole('listitem').filter({ hasText: INGREDIENT_NAME })).toHaveCount(0);

		await page.getByRole('link', { name: 'View archived' }).click();
		await expect(page).toHaveURL(/archived=1/);
		const archivedRow = page.getByRole('listitem').filter({ hasText: INGREDIENT_NAME });
		await expect(archivedRow).toBeVisible();
		await archivedRow.getByRole('button', { name: 'Edit' }).click();
		await page
			.getByRole('dialog', { name: `Edit ${INGREDIENT_NAME}` })
			.getByRole('button', { name: 'Restore ingredient' })
			.click();
		await expect(page.getByRole('listitem').filter({ hasText: INGREDIENT_NAME })).toHaveCount(0);

		await page.getByRole('link', { name: 'Back to ingredients' }).click();
		await expect(page.getByRole('listitem').filter({ hasText: INGREDIENT_NAME })).toBeVisible();
	});
});

test.describe('a recipe’s ingredients', () => {
	test('attaches an existing ingredient, sets its amount, adds a new one, and detaches', async ({
		page
	}) => {
		await signIn(page);
		const id = await recipeId();
		await page.goto(`/food/recipes/${id}`);

		await page.getByText('Manage ingredients').click();
		await page.getByRole('button', { name: 'Add ingredient' }).click();
		const sheet = page.getByRole('dialog', { name: 'Add an ingredient' });
		await expect(sheet).toBeVisible();

		await sheet.getByRole('searchbox', { name: 'Find an ingredient' }).fill('oregano');
		await sheet.getByRole('button', { name: EXISTING_NAME }).click();
		await expect(sheet).toBeHidden();

		// The read-only card, which is what proves the attach reached the
		// recipe's own display, not only the editable panel that did the work.
		const ingredients = page.getByRole('list', { name: 'Ingredients', exact: true });
		await expect(ingredients.getByText(EXISTING_NAME, { exact: true })).toBeVisible();

		// Set a structured amount on the row just attached, from the manage panel.
		await page.getByLabel(`Structured amount for ${EXISTING_NAME}`).fill('2');
		await page.getByLabel(`Unit for ${EXISTING_NAME}`).selectOption('tsp');
		await page.locator('form[action="?/setAmount"]').getByRole('button', { name: 'Save' }).click();
		await expect(ingredients.getByText(EXISTING_NAME, { exact: true })).toBeVisible();
		await expect(ingredients).toContainText('2 tsp');

		// Add a brand new ingredient inline, from the same sheet's other tab.
		await page.getByRole('button', { name: 'Add ingredient' }).click();
		await expect(sheet).toBeVisible();
		await sheet.getByRole('tab', { name: 'Add new' }).click();
		await sheet.getByLabel('Name').fill(NEW_INLINE_NAME);
		await sheet.getByRole('button', { name: 'Add and attach' }).click();
		await expect(sheet).toBeHidden();
		await expect(ingredients.getByText(NEW_INLINE_NAME, { exact: true })).toBeVisible();

		// Detach the first ingredient; the newly added one stays.
		await page.getByRole('button', { name: `Detach ${EXISTING_NAME}` }).click();
		await expect(ingredients.getByText(EXISTING_NAME, { exact: true })).toHaveCount(0);
		await expect(ingredients.getByText(NEW_INLINE_NAME, { exact: true })).toBeVisible();
	});
});
