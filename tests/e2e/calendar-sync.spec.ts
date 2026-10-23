import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';
import { householdToday } from './household-day';

/**
 * Calendar sync's pages: connecting a calendar, and its events on the
 * calendar. No Google or iCloud here: connecting is shown refusing a server
 * that isn't there, and the events are seeded as a sync would have stored
 * them (tests/integration/calendar-*.test.ts run the sync itself).
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-calendars', displayName: 'Calendars', role: 'member' };
// made up per run: a secret scanner can't tell a test's password from a real one
const SIGN_IN = randomBytes(12).toString('base64url');

async function query<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

let userId = '';
let householdId = '';

test.beforeEach(async () => {
	await query(async (sql) => {
		const hash = await hashPassword(SIGN_IN);
		const existing = await sql<
			{ id: string }[]
		>`select id from households order by created_at limit 1`;
		householdId =
			existing[0]?.id ??
			(
				await sql<{ id: string }[]>`insert into households (name) values ('Household') returning id`
			)[0]!.id;
		const [user] = await sql<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash, must_change_credentials)
			values (${USER.username}, ${USER.displayName}, ${USER.role}, ${hash}, false)
			on conflict (username) where username is not null do update set
				password_hash = excluded.password_hash, must_change_credentials = false,
				disabled_at = null, failed_login_count = 0, locked_until = null
			returning id
		`;
		userId = user!.id;
		await sql`insert into household_members (household_id, user_id) values (${householdId}, ${userId}) on conflict do nothing`;
		await sql`delete from calendar_connections where owner_user_id = ${userId}`;
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(SIGN_IN);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

test('the calendars page says plainly what can and cannot be connected yet', async ({ page }) => {
	await signIn(page);
	await page.goto('/account/calendars');
	await expect(page.getByRole('heading', { name: 'Calendars', level: 1 })).toBeVisible();
	// the suite's server names a Google key file that isn't there (playwright.config.ts)
	await expect(
		page.getByText(
			"Google can't be used: there is no file at /nonexistent/lifeos-e2e/google-calendar.json."
		)
	).toBeVisible();

	// a CalDAV server that isn't there is refused, and nothing is stored
	await page.getByLabel('Apple ID').fill('kayla@example.com');
	await page.getByLabel('App-specific password').fill(randomBytes(8).toString('hex'));
	await page.getByText('Another CalDAV server').click();
	await page.getByLabel('Server address').fill('http://127.0.0.1:9');
	await page.getByRole('button', { name: 'Connect' }).click();
	await expect(page.getByRole('alert').first()).toContainText("Couldn't sign in");
	const stored = await query(
		(sql) => sql`select 1 from calendar_connections where owner_user_id = ${userId}`
	);
	expect(stored).toHaveLength(0);
});

test("a connected calendar's events show on the calendar, all-day and timed", async ({ page }) => {
	const today = await householdToday(DATABASE_URL);
	const tomorrow = await query(
		async (sql) => (await sql<{ d: string }[]>`select (${today}::date + 1)::text as d`)[0]!.d
	);
	await query(async (sql) => {
		const [connection] = await sql<{ id: string }[]>`
			insert into calendar_connections (household_id, owner_user_id, provider, account)
			values (${householdId}, ${userId}, 'google', 'lifeos@e2e.iam.gserviceaccount.com') returning id`;
		const [source] = await sql<{ id: string }[]>`
			insert into calendar_sources (connection_id, external_id, name, color)
			values (${connection!.id}, 'e2e@example.com', 'Fictional calendar', '#3366ff') returning id`;
		await sql`
			insert into calendar_events (source_id, external_id, uid, summary, all_day, start_local, end_local, time_zone)
			values
				(${source!.id}, 'picnic', 'picnic', 'Fictional picnic', true, ${today}, ${tomorrow}, null),
				(${source!.id}, 'dentist', 'dentist', 'Fictional dentist', false, ${`${today}T14:30:00`}, ${`${today}T15:30:00`}, 'America/Toronto'),
				(${source!.id}, 'pushed', 'pushed', 'LifeOS own item', true, ${today}, ${tomorrow}, null)`;
		await sql`update calendar_events set lifeos_key = 'task:x:do' where external_id = 'pushed'`;
	});

	await signIn(page);
	await page.goto('/calendar');
	const day = page.locator('td.current-day');
	await expect(day).toContainText('Fictional picnic');
	await expect(day).toContainText('14:30Fictional dentist');
	// LifeOS's own pushed copy is not shown twice
	await expect(day).not.toContainText('LifeOS own item');
	await expect(page.getByText('Your calendars')).toBeVisible();

	await page.getByRole('link', { name: 'Connect Google or iCloud' }).click();
	await expect(page).toHaveURL('/account/calendars');
	await expect(page.getByText('Fictional calendar')).toBeVisible();
});
