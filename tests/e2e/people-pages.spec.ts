import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * A person's own page (PACK1-002): contact details, important dates, and a
 * gift reachable both from here and from /wishlist.
 *
 * Seeds an account of its own for the reason health-measurements.spec.ts and
 * journal-habits.spec.ts do: borrowing another file's credentials would make
 * this file's result depend on run order. Two accounts, in the *same*
 * household — the privacy claim this file proves is the narrow one, that a
 * private person is invisible to the other member of your own household, not
 * merely to an outsider household isolation would refuse anyway.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const OWNER = { username: 'e2e-people-owner', displayName: 'People Owner', role: 'member' };
const OTHER = { username: 'e2e-people-other', displayName: 'People Other', role: 'admin' };
const PASSWORD = 'people-spec-password-2026';

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
			const [user] = await sql<{ id: string }[]>`
				insert into users (username, display_name, role, password_hash, must_change_credentials)
				values (${person.username}, ${person.displayName}, ${person.role}, ${passwordHash}, false)
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
		}
	});
});

/** Every row either account might have left behind, so a retry meets nothing. */
test.beforeEach(async () => {
	await query(async (sql) => {
		const owners = await sql<{ id: string }[]>`
			select id from users where username in (${OWNER.username}, ${OTHER.username})
		`;
		const ids = owners.map((u) => u.id);
		await sql`delete from wishlist_items where created_by = any(${ids})`;
		await sql`delete from important_dates where created_by = any(${ids})`;
		await sql`delete from people where created_by = any(${ids})`;
	});
});

async function signIn(page: Page, username: string) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

const firstHousehold = async (sql: Sql) =>
	(await sql<{ id: string }[]>`select id from households order by created_at limit 1`)[0]!.id;

const idOf = async (sql: Sql, username: string) =>
	(await sql<{ id: string }[]>`select id from users where username = ${username}`)[0]!.id;

async function seedPerson(
	username: string,
	fields: { name: string; visibility?: 'household' | 'private' }
) {
	return query(async (sql) => {
		const householdId = await firstHousehold(sql);
		const userId = await idOf(sql, username);
		const [row] = await sql<{ id: string }[]>`
			insert into people (household_id, owner_user_id, visibility, name, created_by, updated_by)
			values (${householdId}, ${userId}, ${fields.visibility ?? 'household'}, ${fields.name}, ${userId}, ${userId})
			returning id
		`;
		return row!.id;
	});
}

async function seedGift(username: string, name: string, forPersonId: string) {
	return query(async (sql) => {
		const householdId = await firstHousehold(sql);
		const userId = await idOf(sql, username);
		const [row] = await sql<{ id: string }[]>`
			insert into wishlist_items (household_id, name, for_person_id, created_by, updated_by)
			values (${householdId}, ${name}, ${forPersonId}::uuid, ${userId}, ${userId})
			returning id
		`;
		return row!.id;
	});
}

/** How far the document scrolls sideways; a phone page must not at all. */
const sideways = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('a person’s own page', () => {
	test.use({ viewport: PHONE });

	test('is reachable from the list, edits its fields and contact details, and never shows them on the list', async ({
		page
	}) => {
		const personId = await seedPerson(OWNER.username, { name: 'Alex Fixtureton' });

		await signIn(page, OWNER.username);
		await page.goto('/people');
		await page.getByRole('link', { name: 'Alex Fixtureton' }).click();
		await expect(page).toHaveURL(new RegExp(`/people/${personId}$`));
		await expect(page.getByRole('heading', { name: 'Alex Fixtureton', level: 1 })).toBeVisible();

		await page.getByText('Edit person').click();
		const editor = page.locator('form[action="?/save"]');
		await editor.getByLabel('Name').fill('Alex Fixtureton, renamed');
		await editor.getByLabel('Kind').selectOption('pet');
		await editor.getByLabel('Groups').fill('Family, Friends');
		await editor.getByLabel('Birthday').fill('1990-05-04');
		await editor.getByLabel('Email').fill('alex.fixtureton@example.com');
		await editor.getByLabel('Phone').fill('+1-555-0182');
		await editor.getByLabel('Address').fill('42 Example Lane, Testville');
		await editor.getByRole('button', { name: 'Save changes' }).click();
		await expect(editor.getByRole('status')).toHaveText('Saved.');
		// Still on this page, no reload: the Select must show what was just
		// saved rather than reverting to the option the page first rendered
		// with ('person', the table's own default) — the native form reset a
		// bare `update()` would trigger puts a <Select> back on exactly that.
		await expect(editor.getByLabel('Kind')).toHaveValue('pet');

		// Reload: everything came back from storage, contacts included, and
		// the kind Select landed on what was actually saved rather than on
		// whatever option the page happened to render first.
		await page.reload();
		await expect(
			page.getByRole('heading', { name: 'Alex Fixtureton, renamed', level: 1 })
		).toBeVisible();
		await page.getByText('Edit pet').click();
		const reopened = page.locator('form[action="?/save"]');
		await expect(reopened.getByLabel('Kind')).toHaveValue('pet');
		await expect(reopened.getByLabel('Email')).toHaveValue('alex.fixtureton@example.com');
		await expect(reopened.getByLabel('Phone')).toHaveValue('+1-555-0182');

		// The contact details are on this page and nowhere else: not on the
		// list this person was just opened from.
		await page.goto('/people');
		await expect(page.getByText('alex.fixtureton@example.com')).toHaveCount(0);
		await expect(page.getByText('+1-555-0182')).toHaveCount(0);

		expect(await sideways(page)).toBeLessThanOrEqual(0);
	});

	test('adds an important date, then removes and restores it', async ({ page }) => {
		const personId = await seedPerson(OWNER.username, { name: 'Alex Fixtureton' });

		await signIn(page, OWNER.username);
		await page.goto(`/people/${personId}`);

		await page.getByLabel('Title').fill('Sample Birthday');
		await page.getByLabel('Date').fill('2026-03-04');
		await page.getByRole('button', { name: 'Add date' }).click();

		const dates = page.getByRole('list', { name: 'Important dates' });
		await expect(dates).toContainText('Sample Birthday');

		await dates.getByRole('button', { name: /^Remove Sample Birthday$/ }).click();
		await expect(dates.getByText('Removed')).toBeVisible();

		await dates.getByRole('button', { name: /^Restore Sample Birthday$/ }).click();
		await expect(dates.getByText('Removed')).toHaveCount(0);
	});

	test('shows a gift reachable from here and from the wishlist, and marks it bought from either', async ({
		page
	}) => {
		const personId = await seedPerson(OWNER.username, { name: 'Alex Fixtureton' });
		await seedGift(OWNER.username, 'Sample Gift Item', personId);

		await signIn(page, OWNER.username);
		await page.goto(`/people/${personId}`);
		const gifts = page.getByRole('list', { name: 'Gifts' });
		await expect(gifts).toContainText('Sample Gift Item');
		await expect(gifts).toContainText('Wanted');

		await gifts.getByRole('link', { name: 'Sample Gift Item' }).click();
		await expect(page.getByRole('heading', { name: 'Sample Gift Item', level: 1 })).toBeVisible();
		// Reachable the other way too: back to the person from the gift.
		await expect(page.getByRole('link', { name: /Alex Fixtureton/ })).toBeVisible();

		await page.getByRole('button', { name: 'Mark bought' }).click();
		await expect(page.getByText('Bought', { exact: true })).toBeVisible();

		// And from /wishlist, the same item shows as settled rather than wanted.
		await page.goto('/wishlist');
		await expect(page.getByRole('heading', { name: 'Bought or given' })).toBeVisible();
		const settled = page.getByRole('list', { name: 'Settled' });
		await expect(settled).toContainText('Sample Gift Item');
	});

	test('archives a person and restores them', async ({ page }) => {
		const personId = await seedPerson(OWNER.username, { name: 'Alex Fixtureton' });

		await signIn(page, OWNER.username);
		await page.goto(`/people/${personId}`);
		await page.getByRole('button', { name: 'Archive' }).click();
		await expect(page).toHaveURL('/people');
		await expect(page.getByText('Alex Fixtureton')).toHaveCount(0);

		await page.goto(`/people/${personId}`);
		// Exact: the badge. The sentence under the restore button also starts
		// with "Archived:", and a substring match would find both.
		await expect(page.getByText('Archived', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Restore' }).click();
		await expect(page.getByText('Restored. They are back on People')).toBeVisible();

		await page.goto('/people');
		await expect(page.getByText('Alex Fixtureton')).toBeVisible();
	});

	test('the other household member cannot reach a private person’s page or see them on the list', async ({
		page
	}) => {
		const personId = await seedPerson(OWNER.username, {
			name: 'Private Testperson',
			visibility: 'private'
		});

		await signIn(page, OTHER.username);
		const response = await page.goto(`/people/${personId}`);
		expect(response?.status()).toBe(404);

		await page.goto('/people');
		await expect(page.getByText('Private Testperson')).toHaveCount(0);
	});
});
