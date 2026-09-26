import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * A recipe's own page, on the phone it is cooked from.
 *
 * The recipe is seeded the way the importer leaves one — household-owned, its
 * Notion body in `notes` — with a method long enough to scroll, a table wider
 * than a phone, and markup that must not run. Everything after that is done
 * through the page: open it from Food HQ, read the method, mark a favourite,
 * change a field.
 */

const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-recipes-cook', displayName: 'Recipes Cook', role: 'member' };
const PASSWORD = 'recipes-spec-password-2026';
const PHONE = { width: 375, height: 812 };

/** A name unique to this attempt, so a retry never finds its first run's recipe. */
const attempt = (name: string) => {
	const retry = test.info().retry;
	return retry === 0 ? name : `${name} ${retry}`;
};

const METHOD = `## Ingredients

- 250 g rolled oats
- 125 g butter
- [x] Line the tin
- [ ] Buy golden syrup

## Method

1. Heat the oven to 180°C.
2. Melt the butter with the syrup over a low heat.
3. Stir in the oats until every one is coated.
4. Press into the tin and bake for 20 minutes.

| Tin | Size | Bake for | Cut into | Keeps for |
|:----|:-----|---------:|:---------|:----------|
| Square | 20 cm × 20 cm | 20 min | 16 squares | 5 days in a tin |
| Traybake | 30 cm × 20 cm | 25 min | 24 fingers | 5 days in a tin |

<img src=x onerror="window.__xss = 'img'">

[Do not follow](javascript:window.__xss='link')

<script>window.__xss = 'script'</script>`;

/** Runs one piece of seeding and closes the connection; there is no pool to leak. */
async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

const firstHousehold = async (sql: postgres.Sql) =>
	(await sql<{ id: string }[]>`select id from households order by created_at limit 1`)[0]!.id;

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
 * A recipe as the importer leaves one: household-owned, its body in `notes`.
 * No cover, because the page has to look finished without one.
 */
async function seedRecipe(name: string) {
	await withDb(async (sql) => {
		const householdId = await firstHousehold(sql);
		await sql`
			insert into recipes (household_id, name, notes, servings, prep_minutes, cook_minutes,
			                     courses, cuisine, kcal_per_serving, protein_g)
			values (${householdId}::uuid, ${name}, ${METHOD}, 16, 10, 20,
			        '{Snacks,Breakfast}', 'British', 210, 3.5)
		`;
	});
}

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

/** How far the document scrolls sideways; a phone page must not at all. */
const sideways = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('a recipe on a phone', () => {
	test.use({ viewport: PHONE });

	test('opens from Food HQ, shows its method, and can be favourited and edited', async ({
		page
	}) => {
		const recipeName = attempt('Apricot flapjacks');
		await seedRecipe(recipeName);

		const dialogs: string[] = [];
		page.on('dialog', (dialog) => {
			dialogs.push(dialog.message());
			void dialog.dismiss();
		});

		await signIn(page);
		await page.goto('/food');
		await page.getByRole('link', { name: recipeName }).click();

		await expect(page).toHaveURL(/\/food\/recipes\/[0-9a-f-]{36}$/);
		await expect(page.getByRole('heading', { name: recipeName, level: 1 })).toBeVisible();

		// The method, rendered: steps as a numbered list, headings under the
		// card's own, the checklist as ticks.
		const method = page.locator('.prose');
		await expect(method.getByRole('heading', { name: 'Method', level: 4 })).toBeVisible();
		await expect(method.locator('ol > li')).toHaveCount(4);
		await expect(method.locator('ol > li').first()).toHaveText('Heat the oven to 180°C.');
		await expect(method.getByRole('checkbox')).toHaveCount(2);
		await expect(method.getByRole('checkbox').first()).toBeChecked();
		await expect(method.getByRole('checkbox').first()).toBeDisabled();

		// None of the markup in the body ran, and none of it is a link.
		expect(
			await page.evaluate(() => (window as unknown as { __xss?: string }).__xss)
		).toBeUndefined();
		expect(dialogs).toEqual([]);
		await expect(method.getByRole('link')).toHaveCount(0);
		await expect(method.getByText('Do not follow')).toBeVisible();

		// The table is wider than the phone: it scrolls in its own box and the
		// page does not scroll sideways.
		const frame = method.locator('.md-table');
		await expect(frame.getByRole('columnheader', { name: 'Keeps for' })).toBeAttached();
		const overflow = await frame.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(overflow).toBeGreaterThan(0);
		expect(await sideways(page)).toBeLessThanOrEqual(0);

		// At a glance and per serving.
		const glance = page.locator('.facts').first();
		await expect(glance).toContainText('Serves');
		await expect(glance).toContainText('16');
		await expect(glance.getByText('30 min', { exact: true })).toBeVisible();
		await expect(page.getByText('210 kcal', { exact: true })).toBeVisible();

		// Favourite: state in aria-pressed and in words, never colour alone.
		const favourite = page.getByRole('button', { name: 'Favourite' });
		await expect(favourite).toHaveAttribute('aria-pressed', 'false');
		const box = await favourite.boundingBox();
		expect(box!.height).toBeGreaterThanOrEqual(44);
		await favourite.click();
		await expect(favourite).toHaveAttribute('aria-pressed', 'true');

		await page.getByRole('button', { name: 'Made it today' }).click();
		await expect(page.getByText('Made today')).toBeVisible();

		// Edit a field and read it back.
		await page.getByText('Edit recipe').click();
		const editor = page.locator('form[action="?/save"]');
		const version = await editor.locator('input[name="updatedAt"]').inputValue();
		await editor.getByLabel('Serves').fill('24');
		await editor.getByRole('button', { name: 'Save recipe' }).click();
		await expect(editor.getByRole('status')).toHaveText('Saved.');
		// The version moved, so a second save from this page is not a conflict.
		await expect(editor.locator('input[name="updatedAt"]')).not.toHaveValue(version);
		await expect(page.locator('.facts').first()).toContainText('24');

		await page.reload();
		await expect(page.getByRole('button', { name: 'Favourite' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(page.locator('.facts').first()).toContainText('24');
		expect(await sideways(page)).toBeLessThanOrEqual(0);
	});

	test('a new recipe starts from Food HQ with only a name', async ({ page }) => {
		await signIn(page);
		await page.goto('/food');
		await page.getByRole('link', { name: 'New recipe' }).click();
		await expect(page).toHaveURL('/food/recipes/new');

		const name = attempt('Banana bread');
		await page.getByLabel('Name').fill(name);
		await page.getByLabel('Instructions').fill('1. Mash the bananas.\n2. Bake for an hour.');
		await page.getByRole('button', { name: 'Save recipe' }).click();

		await expect(page).toHaveURL(/\/food\/recipes\/[0-9a-f-]{36}$/);
		await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
		await expect(page.locator('.prose ol > li')).toHaveText([
			'Mash the bananas.',
			'Bake for an hour.'
		]);
		expect(await sideways(page)).toBeLessThanOrEqual(0);
	});
});
