import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * The authenticated shell (UI-001), on a phone and on a desktop.
 *
 * ── Why this file seeds its own accounts ──────────────────────────────────
 * Every spec file shares one server and one database, and Playwright runs
 * files in parallel. auth.spec.ts owns the bootstrap administrator: its cases
 * depend on that account still being unrotated, and its last case renames it.
 * Borrowing those credentials would make this file's result depend on which
 * worker happened to finish first, and would fail outright on a second run
 * against a database that is no longer fresh.
 *
 * So this file creates two accounts of its own — one admin, one member —
 * writing them the way bootstrap does, with the project's own password
 * hashing rather than a fixture hash that would silently rot if the
 * parameters were ever raised. The seed is an upsert, so it is idempotent
 * across runs and safe against itself, and it touches no row any other spec
 * relies on.
 *
 * A member account is not optional here: "admin links are hidden for a
 * non-admin" cannot be tested by an administrator.
 * ─────────────────────────────────────────────────────────────────────────
 */

// Mirrors the resolution order in playwright.config.ts, so both point at the
// same database whichever way it was configured.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const ADMIN = { username: 'e2e-shell-admin', displayName: 'Shell Admin', role: 'admin' };
const MEMBER = { username: 'e2e-shell-member', displayName: 'Shell Member', role: 'member' };
const PASSWORD = 'shell-spec-password-2026';

/** The phone this project is being built for: a small, ordinary screen. */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

test.beforeAll(async () => {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
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

		for (const person of [ADMIN, MEMBER]) {
			// An upsert, not delete-then-insert. Playwright distributes this
			// file's describe blocks across workers, so beforeAll runs more
			// than once concurrently; a delete would let one worker remove an
			// account another worker was mid-sign-in with. ON CONFLICT makes
			// the seed both idempotent and safe to race.
			const [user] = await sql<{ id: string }[]>`
				insert into users (username, display_name, role, password_hash, must_change_credentials)
				values (
					${person.username}, ${person.displayName}, ${person.role}, ${passwordHash}, false
				)
				on conflict (username) where username is not null do update set
					display_name = excluded.display_name,
					role = excluded.role,
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
	} finally {
		await sql.end();
	}
});

async function signIn(page: Page, username: string) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

test.describe('on a phone', () => {
	test.use({ viewport: PHONE });

	test('the shell renders after signing in', async ({ page }) => {
		await signIn(page, MEMBER.username);

		await expect(page.getByRole('heading', { name: 'Life OS', level: 1 })).toBeVisible();
		// The shell chrome, not just the page.
		await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Quick add' })).toBeVisible();
		// Home starts with its directory collapsed, leaving room for the cover.
		await expect(page.getByRole('navigation', { name: 'Sections' })).toBeHidden();
	});

	test('every destination is reachable', async ({ page }) => {
		await signIn(page, MEMBER.username);
		const bar = page.getByRole('navigation', { name: 'Main' });

		// Four on the bar itself.
		for (const label of ['Today', 'Tasks', 'Habits', 'Journal']) {
			await expect(bar.getByRole('link', { name: label })).toBeVisible();
		}

		// The rest behind More.
		await page.getByRole('button', { name: 'More' }).click();
		const sheet = page.getByRole('dialog', { name: 'More' });
		await expect(sheet).toBeVisible();
		for (const label of ['Projects', 'Areas', 'Goals']) {
			await expect(sheet.getByRole('link', { name: label })).toBeVisible();
		}

		// And a way back out that does not need a mouse.
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
	});

	test('every navigation target is at least 44px tall', async ({ page }) => {
		await signIn(page, MEMBER.username);
		const links = page.getByRole('navigation', { name: 'Main' }).getByRole('link');

		for (const link of await links.all()) {
			const box = await link.boundingBox();
			expect(box).not.toBeNull();
			expect(box!.height).toBeGreaterThanOrEqual(44);
		}
	});

	test('a member is not offered the admin surface', async ({ page }) => {
		await signIn(page, MEMBER.username);

		await page.getByRole('button', { name: 'More' }).click();
		const sheet = page.getByRole('dialog', { name: 'More' });
		await expect(sheet).toBeVisible();

		// Present enough of the sheet to prove we looked in the right place.
		await expect(sheet.getByRole('link', { name: 'Projects' })).toBeVisible();
		await expect(sheet.getByRole('link', { name: 'People' })).toHaveCount(0);
		await expect(sheet.getByRole('link', { name: 'Audit' })).toHaveCount(0);
		// Nowhere else on the page either.
		await expect(page.locator('a[href="/admin/people"]')).toHaveCount(0);
		await expect(page.locator('a[href="/admin/audit"]')).toHaveCount(0);
	});

	test('an admin is offered the admin surface', async ({ page }) => {
		await signIn(page, ADMIN.username);

		await page.getByRole('button', { name: 'More' }).click();
		const sheet = page.getByRole('dialog', { name: 'More' });
		await expect(sheet.getByRole('link', { name: 'People' })).toBeVisible();
		await expect(sheet.getByRole('link', { name: 'Audit' })).toBeVisible();
	});

	test('quick add opens with the keyboard already in the text box', async ({ page }) => {
		await signIn(page, MEMBER.username);

		await page.getByRole('button', { name: 'Quick add' }).click();
		const sheet = page.getByRole('dialog', { name: 'Quick add' });
		await expect(sheet).toBeVisible();

		// Focused on open, so the phone keyboard appears without a second tap.
		await expect(sheet.getByLabel('What?')).toBeFocused();

		await sheet.getByLabel('What?').fill('Book the vet');
		await expect(sheet.getByRole('button', { name: 'Save' })).toBeEnabled();

		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
	});

	test('the quick-add control is reachable by keyboard', async ({ page }) => {
		await signIn(page, MEMBER.username);

		const seen: string[] = [];
		for (let i = 0; i < 40; i++) {
			await page.keyboard.press('Tab');
			seen.push(
				await page.evaluate(() => {
					const el = document.activeElement;
					if (!el) return '';
					return el.getAttribute('aria-label') ?? (el.textContent ?? '').trim();
				})
			);
			if (seen.at(-1)?.includes('Quick add')) break;
		}
		expect(seen.some((name) => name.includes('Quick add'))).toBe(true);
	});

	test('the page never scrolls sideways', async ({ page }) => {
		await signIn(page, MEMBER.username);

		const overflow = await page.evaluate(() => {
			const doc = document.documentElement;
			return doc.scrollWidth - doc.clientWidth;
		});
		// Wide content lives in its own scroller; the document itself must not
		// move, or every swipe on a phone fights the layout.
		expect(overflow).toBeLessThanOrEqual(0);
	});

	test('the theme toggle switches and remembers light mode', async ({ page }) => {
		await signIn(page, MEMBER.username);

		const toggle = page.getByRole('button', { name: 'Switch to light theme' });
		await expect(toggle).toBeVisible();
		await toggle.click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();

		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.getByRole('button', { name: 'Switch to dark theme' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	});
});

test.describe('on a desktop', () => {
	test.use({ viewport: DESKTOP });

	test('home starts full width and its sidebar can be opened and closed', async ({ page }) => {
		await signIn(page, MEMBER.username);

		const side = page.getByRole('navigation', { name: 'Sections' });
		await expect(side).toBeHidden();
		await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
		await page.getByRole('button', { name: 'Open sidebar' }).click();
		await expect(side).toBeVisible();

		for (const label of ['Today', 'Tasks', 'Habits', 'Journal', 'Projects', 'Areas', 'Goals']) {
			await expect(side.getByRole('link', { name: label })).toBeVisible();
		}
		await expect(side.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Close sidebar' }).click();
		await expect(side).toBeHidden();
	});

	test('the sidebar hides admin links from a member', async ({ page }) => {
		await signIn(page, MEMBER.username);
		await page.getByRole('button', { name: 'Open sidebar' }).click();
		const side = page.getByRole('navigation', { name: 'Sections' });
		await expect(side.getByRole('link', { name: 'Tasks' })).toBeVisible();
		await expect(side.locator('a[href="/admin/people"]')).toHaveCount(0);
		await expect(side.locator('a[href="/admin/audit"]')).toHaveCount(0);
	});

	test('the sidebar shows admin links to an admin', async ({ page }) => {
		// A separate test rather than a sign-out and back in: logout is
		// POST-only by design, and each test already gets its own context.
		await signIn(page, ADMIN.username);
		await page.getByRole('button', { name: 'Open sidebar' }).click();
		const side = page.getByRole('navigation', { name: 'Sections' });
		await expect(side.locator('a[href="/admin/people"]')).toBeVisible();
		await expect(side.locator('a[href="/admin/audit"]')).toBeVisible();
	});

	test('the sidebar opens the same quick-add sheet', async ({ page }) => {
		await signIn(page, MEMBER.username);
		await page.getByRole('button', { name: 'Open sidebar' }).click();

		await page
			.getByRole('navigation', { name: 'Sections' })
			.getByRole('button', { name: 'Quick add' })
			.click();
		await expect(page.getByRole('dialog', { name: 'Quick add' })).toBeVisible();
	});

	test('the current section is marked, and only one of them', async ({ page }) => {
		await signIn(page, MEMBER.username);
		await page.getByRole('button', { name: 'Open sidebar' }).click();

		const current = page
			.getByRole('navigation', { name: 'Sections' })
			.locator('[aria-current="page"]');
		await expect(current).toHaveCount(1);
		await expect(current).toHaveText('Home Today');
	});

	test('workspace capture shortcuts select the requested kind', async ({ page }) => {
		await signIn(page, MEMBER.username);
		await page.locator('summary').filter({ hasText: 'Quick Capture' }).click();
		const dialog = page.getByRole('dialog', { name: 'Quick add' });
		for (const shortcut of [
			['New note', 'note'],
			['New journal entry', 'journal'],
			['New task', 'task']
		] as const) {
			await page.getByRole('button', { name: shortcut[0], exact: true }).click();
			await expect(dialog).toBeVisible();
			await expect(dialog.getByLabel('Add as')).toHaveValue(shortcut[1]);
			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
		}
	});
});
