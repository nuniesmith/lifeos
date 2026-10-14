import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * One day of health as a timeline (PACK3-001), reached from the journal and
 * the health overview, on a phone.
 *
 * Seeds an account and a day of its own, a past day nothing else in the
 * suite writes to, and removes them again before each test so a retry starts
 * from the same day.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-health-day', displayName: 'Health Day', role: 'member' };
const PASSWORD = 'health-day-spec-password-2025';
const PHONE = { width: 375, height: 812 };
const DAY = '2025-05-14';
const MEDICATION = 'Fictional Magnesium';
const VISIT = 'Fictional physio';

async function query<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

test.beforeEach(async () => {
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
			values (${USER.username}, ${USER.displayName}, ${USER.role}, ${passwordHash}, false)
			on conflict (username) where username is not null do update set
				password_hash = excluded.password_hash,
				must_change_credentials = false,
				disabled_at = null,
				failed_login_count = 0,
				locked_until = null
			returning id
		`;
		const userId = user!.id;
		await sql`
			insert into household_members (household_id, user_id)
			values (${householdId}, ${userId}) on conflict do nothing
		`;

		// Everything private to this account, so no other spec's pages see it.
		await sql`delete from health_measurements where owner_user_id = ${userId}`;
		await sql`delete from medications where owner_user_id = ${userId}`;
		await sql`delete from medical_visits where owner_user_id = ${userId}`;
		await sql`delete from daily_logs where owner_user_id = ${userId}`;

		const zone = sql`(select timezone from households where id = ${householdId})`;
		// Local wall-clock times, placed in the household's own zone.
		await sql`
			insert into health_measurements
				(household_id, owner_user_id, visibility, measured_at, systolic, diastolic)
			values (${householdId}, ${userId}, 'private',
			        (${`${DAY} 07:05`}::timestamp at time zone ${zone}), 118, 76)
		`;
		const [med] = await sql<{ id: string }[]>`
			insert into medications (household_id, owner_user_id, visibility, name, type, dose, unit)
			values (${householdId}, ${userId}, 'private', ${MEDICATION}, 'supplement', '200', 'mg')
			returning id
		`;
		await sql`
			insert into medication_doses (medication_id, on_date, slot, taken_at)
			values (${med!.id}, ${DAY}, 'pm', (${`${DAY} 21:00`}::timestamp at time zone ${zone})),
			       (${med!.id}, ${DAY}, 'am', null)
		`;
		await sql`
			insert into medical_visits (household_id, owner_user_id, visibility, reason, visit_at)
			values (${householdId}, ${userId}, 'private', ${VISIT},
			        (${`${DAY} 14:30`}::timestamp at time zone ${zone}))
		`;
		await sql`
			insert into daily_logs (household_id, owner_user_id, on_date, mood, energy_level)
			values (${householdId}, ${userId}, ${DAY}, 'Calm', 4)
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

test.use({ viewport: PHONE });

test('opens a day’s health from the journal, in clock order', async ({ page }) => {
	await signIn(page);
	await page.goto(`/journal/${DAY}`);
	await page.getByRole('link', { name: 'Health on this day' }).click();
	await expect(page).toHaveURL(`/health/day/${DAY}`);

	const timed = page.getByRole('list', { name: 'Through the day' });
	await expect(timed.getByRole('listitem')).toHaveText([
		/07:05.*Reading.*118\/76 mmHg/,
		new RegExp(`14:30.*${VISIT}`),
		new RegExp(`21:00.*${MEDICATION}.*200 mg · Evening`)
	]);
	// The morning dose came with no time, so it is under "All day".
	await expect(page.getByRole('list', { name: 'All day' }).getByRole('listitem')).toHaveText([
		new RegExp(`${MEDICATION}.*Morning`)
	]);
	await expect(page.getByText('Calm')).toBeVisible();
	await expect(page.getByText('Good')).toBeVisible();

	await timed.getByRole('link', { name: VISIT }).click();
	await expect(page.getByRole('heading', { level: 1, name: VISIT })).toBeVisible();

	await page.goto(`/health/day/${DAY}`);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);

	await page.getByRole('link', { name: '← Previous day' }).click();
	await expect(page).toHaveURL('/health/day/2025-05-13');
	await expect(page.getByText('Nothing recorded on this day')).toBeVisible();
});

test('the health overview opens today', async ({ page }) => {
	await signIn(page);
	await page.goto('/health');
	await page.getByRole('link', { name: 'Today, hour by hour' }).click();
	await expect(page).toHaveURL(/\/health\/day\/\d{4}-\d{2}-\d{2}$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Health on this day' })).toBeVisible();
	// Today is the last day there is: no step forward from it.
	await expect(page.getByRole('link', { name: 'Previous day' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Next day' })).toHaveCount(0);
});
