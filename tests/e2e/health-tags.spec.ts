import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Tagging a journal day with what you noticed, and finding it on /health/symptoms
 * (PACK3-001), on the phone the journal is used on.
 *
 * Seeds an account of its own for the reason journal-habits.spec.ts does:
 * borrowing another file's credentials would make this one depend on the
 * order the suite runs in.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const PERSON = { username: 'e2e-tags-owner', displayName: 'Tags Owner', role: 'member' };
const PASSWORD = 'tags-spec-password-2026';

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

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(PERSON.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

/** A word unique to this attempt, so a retry does not meet its first run's. */
const attempt = (name: string) => {
	const retry = test.info().retry;
	return retry === 0 ? name : `${name} ${retry}`;
};

/** The Symptoms list on the journal, opened if it starts closed. */
async function symptoms(page: Page) {
	const group = page
		.locator('details')
		.filter({ has: page.locator('summary', { hasText: 'Symptoms' }) });
	if ((await group.getAttribute('open')) === null) await group.locator('summary').click();
	return group;
}

test.describe('tagging a journal day', () => {
	test.use({ viewport: PHONE });

	test('tags today with a new symptom, and the Patterns on /health/symptoms count it', async ({
		page
	}) => {
		const word = attempt('Tingling toes');
		await signIn(page);
		await page.goto('/journal');

		const group = await symptoms(page);
		await group.getByLabel('New symptom').fill(word);
		await group.getByRole('button', { name: 'Add symptom and tag it' }).click();

		// On the day: pressed, and said in words in the list's summary.
		const chip = group.getByRole('button', { name: word, exact: true });
		await expect(chip).toHaveAttribute('aria-pressed', 'true');
		await expect(group.locator('summary')).toContainText(word);
		// And said to a screen reader, from the card's live region.
		await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'tagged' })).toHaveText(
			`${word} added to the list and tagged.`
		);

		// A fresh request, not the state the page was left in.
		await page.reload();
		await expect(
			(await symptoms(page)).getByRole('button', { name: word, exact: true })
		).toHaveAttribute('aria-pressed', 'true');

		await page.goto('/health/symptoms');
		const patterns = page.getByRole('list', { name: 'How often each has come up' });
		const row = patterns.getByRole('listitem').filter({ hasText: word });
		await expect(row).toHaveCount(1);
		await expect(row).toContainText('1 day');
		await expect(row).toContainText('Symptoms');
	});

	test('untags and re-tags from the keyboard', async ({ page }) => {
		const word = attempt('Stiff neck');
		await signIn(page);
		await page.goto('/journal');

		const group = await symptoms(page);
		await group.getByLabel('New symptom').fill(word);
		await group.getByLabel('New symptom').press('Enter');
		const chip = group.getByRole('button', { name: word, exact: true });
		await expect(chip).toHaveAttribute('aria-pressed', 'true');

		await chip.focus();
		await page.keyboard.press('Space');
		await expect(chip).toHaveAttribute('aria-pressed', 'false');
		await expect(chip).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(chip).toHaveAttribute('aria-pressed', 'true');
	});

	test('every word is a 44px target, and the page never scrolls sideways', async ({ page }) => {
		await signIn(page);
		await page.goto('/journal');
		const group = await symptoms(page);
		// A name long enough to have to wrap on a phone.
		await group.getByLabel('New symptom').fill(attempt('A very long symptom name that wraps'));
		await group.getByRole('button', { name: 'Add symptom and tag it' }).click();
		await expect(group.getByRole('button', { pressed: true }).first()).toBeVisible();

		const words = page.locator('details[open] button[aria-pressed]');
		expect(await words.count()).toBeGreaterThan(0);
		for (const target of await words.all()) {
			const box = await target.boundingBox();
			expect(box).not.toBeNull();
			expect(box!.height).toBeGreaterThanOrEqual(44);
			expect(box!.width).toBeGreaterThanOrEqual(44);
			// Inside the viewport, not merely clipped by the body's overflow.
			expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
		}
		for (const summary of await page.locator('summary').all()) {
			expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		}

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});

	test('the Mood filter says where its words come from, instead of pointing at the journal', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/health/symptoms?kind=mood');

		// The journal records mood in its own field and cannot tag a mood word,
		// so "tag a day in your journal" would send someone looking for a
		// control that does not exist.
		const patterns = page.locator('section', {
			has: page.getByRole('heading', { name: 'Patterns' })
		});
		await expect(patterns).toContainText('Mood words come only from days imported from Notion.');
		await expect(patterns).not.toContainText('Tag a day in your journal');
	});
});

test.describe('without JavaScript', () => {
	test.use({ viewport: PHONE, javaScriptEnabled: false });

	test('a tap is a plain form post that comes back tagged', async ({ page }) => {
		const word = attempt('Hiccups');
		await signIn(page);
		await page.goto('/journal/2026-04-12');

		const group = await symptoms(page);
		await group.getByLabel('New symptom').fill(word);
		await group.getByRole('button', { name: 'Add symptom and tag it' }).click();

		// The whole page came back, with the list the post was about open.
		const chip = (await symptoms(page)).getByRole('button', { name: word, exact: true });
		await expect(chip).toHaveAttribute('aria-pressed', 'true');
		await chip.click();
		await expect(
			(await symptoms(page)).getByRole('button', { name: word, exact: true })
		).toHaveAttribute('aria-pressed', 'false');
	});
});
