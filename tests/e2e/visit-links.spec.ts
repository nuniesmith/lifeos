import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * A medical visit's provider, location and pet links (migration 0028,
 * PACK3-002).
 *
 * Seeds an account of its own for the reason health-measurements.spec.ts and
 * people-pages.spec.ts do: borrowing another file's credentials would make
 * this file's result depend on run order. All names below are invented; see
 * the privacy rule in the project brief.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const OWNER = { username: 'e2e-visits-owner', displayName: 'Visits Owner', role: 'member' };
const PASSWORD = 'visit-links-spec-password-2026';

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
			values (${OWNER.username}, ${OWNER.displayName}, ${OWNER.role}, ${passwordHash}, false)
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

/** Every row this account might have left behind, so a retry meets nothing. */
test.beforeEach(async () => {
	await query(async (sql) => {
		const [owner] = await sql<{ id: string }[]>`
			select id from users where username = ${OWNER.username}
		`;
		await sql`delete from medical_visits where created_by = ${owner!.id}`;
		await sql`delete from people where created_by = ${owner!.id}`;
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(OWNER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

const firstHousehold = async (sql: Sql) =>
	(await sql<{ id: string }[]>`select id from households order by created_at limit 1`)[0]!.id;

const ownerId = async (sql: Sql) =>
	(await sql<{ id: string }[]>`select id from users where username = ${OWNER.username}`)[0]!.id;

/** A person/place/pet row (`people.kind`), owned by this spec's account. */
async function seedPerson(name: string, kind: 'person' | 'place' | 'pet') {
	return query(async (sql) => {
		const householdId = await firstHousehold(sql);
		const userId = await ownerId(sql);
		const [row] = await sql<{ id: string }[]>`
			insert into people (household_id, kind, name, created_by, updated_by)
			values (${householdId}, ${kind}, ${name}, ${userId}, ${userId})
			returning id
		`;
		return row!.id;
	});
}

/** A medical visit, with the imported free-text provider/location the source would carry. */
async function seedVisit(reason: string, provider: string, location: string) {
	return query(async (sql) => {
		const householdId = await firstHousehold(sql);
		const userId = await ownerId(sql);
		const [row] = await sql<{ id: string }[]>`
			insert into medical_visits (household_id, reason, visit_at, provider, location, created_by, updated_by)
			values (${householdId}, ${reason}, now() + interval '1 day', ${provider}, ${location}, ${userId}, ${userId})
			returning id
		`;
		return row!.id;
	});
}

test.describe('a visit’s provider, location and pet links', () => {
	test.use({ viewport: PHONE });

	test('links a provider, place and pet, shows their names, and keeps the imported text', async ({
		page
	}) => {
		const providerId = await seedPerson('Doctor Fixtureton', 'person');
		const placeId = await seedPerson('Fixture Clinic', 'place');
		const petId = await seedPerson('Zorbo', 'pet');
		const visitId = await seedVisit('Check-up', 'Imported Provider Text', 'Imported Location Text');

		await signIn(page);
		await page.goto(`/health/visits/${visitId}`);

		// The imported words are still there, untouched by anything below.
		// Exact: a label matches as a substring by default, and "Linked provider"
		// and "New provider" both contain "Provider".
		await expect(page.getByLabel('Provider', { exact: true })).toHaveValue('Imported Provider Text');
		await expect(page.getByLabel('Location', { exact: true })).toHaveValue('Imported Location Text');

		await page.getByLabel('Linked provider').selectOption({ label: 'Doctor Fixtureton' });
		await page.getByLabel('Linked place').selectOption({ label: 'Fixture Clinic' });
		await page.getByLabel('Linked pet').selectOption({ label: 'Zorbo' });
		await page.getByRole('button', { name: 'Save', exact: true }).click();

		await expect(page.getByRole('status')).toContainText('Saved.');

		// The pickers show what was just saved rather than snapping back to
		// their first-served option -- the <Select>-plus-`update()` reset this
		// page's own `detailsFormKey` exists to avoid.
		await expect(page.getByLabel('Linked provider')).toHaveValue(providerId);
		await expect(page.getByLabel('Linked place')).toHaveValue(placeId);
		await expect(page.getByLabel('Linked pet')).toHaveValue(petId);

		// The free text is exactly as it was: linking never rewrites it.
		await expect(page.getByLabel('Provider', { exact: true })).toHaveValue('Imported Provider Text');
		await expect(page.getByLabel('Location', { exact: true })).toHaveValue('Imported Location Text');

		// The header shows the linked names, each a link into /people/[id].
		await expect(page.getByRole('link', { name: 'Doctor Fixtureton' })).toHaveAttribute(
			'href',
			`/people/${providerId}`
		);
		await expect(page.getByRole('link', { name: 'Fixture Clinic' })).toHaveAttribute(
			'href',
			`/people/${placeId}`
		);
		await expect(page.getByRole('link', { name: 'Zorbo' })).toHaveAttribute(
			'href',
			`/people/${petId}`
		);

		// Reloading reads the same thing back from the server, not a client
		// guess.
		await page.reload();
		await expect(page.getByLabel('Linked provider')).toHaveValue(providerId);
		await expect(page.getByLabel('Provider', { exact: true })).toHaveValue('Imported Provider Text');
	});

	test('adds a new person inline from the picker’s own "add" form', async ({ page }) => {
		const visitId = await seedVisit('Follow up', '', '');

		await signIn(page);
		await page.goto(`/health/visits/${visitId}`);

		await expect(page.getByLabel('Linked provider')).toHaveValue('');

		const addForm = page.locator('form[action="?/addProvider"]');
		await addForm.getByLabel('New provider').fill('Nurse Fixturella');
		await addForm.getByRole('button', { name: 'Add provider', exact: true }).click();

		await expect(page.getByText('Added.')).toBeVisible();

		// The new person now appears in the picker, ready to be linked and
		// saved -- adding one does not, on its own, link it to this visit.
		await page.getByLabel('Linked provider').selectOption({ label: 'Nurse Fixturella' });
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByRole('status')).toContainText('Saved.');
		await expect(page.getByRole('link', { name: 'Nurse Fixturella' })).toBeVisible();
	});
});
