import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Editing, archiving and restoring significant events (/yearly-review) and
 * life assessments (/perspectives) (PACK5-002).
 *
 * Seeds an account of its own for the reason health-tags.spec.ts does:
 * borrowing another file's credentials would make this one depend on the
 * order the suite runs in. Its events and ratings are cleared before each
 * test, so a retry meets an empty page rather than its first attempt's rows.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const PERSON = { username: 'e2e-reflect-owner', displayName: 'Reflect Owner', role: 'member' };
const PASSWORD = 'reflect-spec-password-2026';

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
	// Owner-user filtering (as health-measurements.spec.ts uses) does not reach
	// an event: `createEvent` defaults a new one to no owner at all, since it is
	// household-shared, not personal. `created_by` is populated either way, so
	// it is what both cleanups key on.
	await query(
		(sql) => sql`
			delete from significant_events
			where created_by = (select id from users where username = ${PERSON.username})
		`
	);
	await query(
		(sql) => sql`
			delete from life_assessments
			where created_by = (select id from users where username = ${PERSON.username})
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

/** Today, in the plain `YYYY-MM-DD` both `onDate` and a date input use. */
const today = () => new Date().toISOString().slice(0, 10);

test.describe('editing a significant event', () => {
	test.use({ viewport: PHONE });

	test('edits, archives and restores an event from /yearly-review', async ({ page }) => {
		await signIn(page);
		await page.goto('/yearly-review');

		await page.getByLabel('Something worth remembering').fill('Finished a 5k race');
		await page.getByLabel('When').fill(today());
		// The sidebar's own "Quick add" would also match a substring "Add".
		await page.getByRole('button', { name: 'Add', exact: true }).click();

		const events = page.getByRole('list', { name: 'Significant events' });
		await expect(events).toContainText('Finished a 5k race');

		// Edit: change the title, mark it a favourite, and add a note.
		await events
			.getByRole('listitem')
			.filter({ hasText: 'Finished a 5k race' })
			.getByRole('button', { name: 'Edit', exact: true })
			.click();
		const editSheet = page.getByRole('dialog', { name: 'Edit event' });
		await editSheet.getByLabel('Something worth remembering').fill('Finished a 10k race');
		await editSheet.getByLabel('Favourite').check();
		await editSheet.getByLabel('Notes').fill('Personal best.');
		await editSheet.getByRole('button', { name: 'Save changes' }).click();

		await expect(editSheet).toBeHidden();
		await expect(events).toContainText('Finished a 10k race');
		await expect(events).not.toContainText('Finished a 5k race');
		await expect(
			events.getByRole('listitem').filter({ hasText: 'Finished a 10k race' })
		).toContainText('Favourite');

		// Archive: leaves the live list and shows up as restorable.
		await events
			.getByRole('listitem')
			.filter({ hasText: 'Finished a 10k race' })
			.getByRole('button', { name: 'Edit', exact: true })
			.click();
		await editSheet.getByRole('button', { name: 'Archive this event' }).click();
		await expect(editSheet).toBeHidden();
		await expect(events).not.toContainText('Finished a 10k race');

		const archived = page.getByRole('list', { name: 'Archived events' });
		await expect(archived).toContainText('Finished a 10k race');

		// Restore: back on the live list, gone from the archived one.
		await archived
			.getByRole('listitem')
			.filter({ hasText: 'Finished a 10k race' })
			.getByRole('button', { name: 'Restore' })
			.click();
		await expect(events).toContainText('Finished a 10k race');
		await expect(page.getByRole('list', { name: 'Archived events' })).toHaveCount(0);
	});
});

test.describe('editing a life assessment', () => {
	test.use({ viewport: PHONE });

	test('edits, archives and restores a rating from /perspectives', async ({ page }) => {
		await signIn(page);
		await page.goto('/perspectives');

		await page.getByLabel('Focus').fill('Deep work hours');
		await page.getByLabel('Out of 10').fill('4');
		await page.getByRole('button', { name: 'Add', exact: true }).click();

		const wheel = page.locator('.wheel');
		await expect(wheel).toContainText('Deep work hours');
		await expect(wheel).toContainText('4/10');

		// Edit: raise the rating and mark it a priority.
		await wheel
			.getByRole('listitem')
			.filter({ hasText: 'Deep work hours' })
			.getByRole('button', { name: 'Edit', exact: true })
			.click();
		const editSheet = page.getByRole('dialog', { name: 'Edit rating' });
		await editSheet.getByLabel('Out of 10').fill('8');
		await editSheet.getByLabel('This is a priority area').check();
		await editSheet.getByRole('button', { name: 'Save changes' }).click();

		await expect(editSheet).toBeHidden();
		await expect(wheel).toContainText('8/10');
		await expect(wheel).not.toContainText('4/10');

		// Archive: leaves the wheel and shows up as restorable.
		await wheel
			.getByRole('listitem')
			.filter({ hasText: 'Deep work hours' })
			.getByRole('button', { name: 'Edit', exact: true })
			.click();
		await editSheet.getByRole('button', { name: 'Archive this rating' }).click();
		await expect(editSheet).toBeHidden();
		await expect(page.locator('.wheel')).toHaveCount(0);

		const archived = page.getByRole('list', { name: 'Archived ratings' });
		await expect(archived).toContainText('Deep work hours');

		// Restore: back on the wheel, gone from the archived list.
		await archived
			.getByRole('listitem')
			.filter({ hasText: 'Deep work hours' })
			.getByRole('button', { name: 'Restore' })
			.click();
		await expect(page.locator('.wheel')).toContainText('Deep work hours');
		await expect(page.getByRole('list', { name: 'Archived ratings' })).toHaveCount(0);
	});
});
