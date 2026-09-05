import { expect, test } from '@playwright/test';

// The bootstrap password is fixed by playwright.config.ts so the suite can
// sign in. In production it is generated and printed once.
const PASSWORD = 'e2e-bootstrap-password';

test.describe.configure({ mode: 'serial' });

test('an anonymous visitor is sent to sign in, not to the app', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login/);
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a protected page cannot be reached by URL', async ({ page }) => {
	// Route grouping is not access control; the server must refuse this.
	await page.goto('/account/credentials');
	await expect(page).toHaveURL(/\/login/);
});

test('a wrong password is refused with a non-committal message', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Username').fill('admin');
	await page.getByLabel('Password').fill('definitely-not-the-password');
	await page.getByRole('button', { name: 'Sign in' }).click();

	const alert = page.getByRole('alert');
	await expect(alert).toBeVisible();
	// Must not reveal whether the username exists.
	await expect(alert).toHaveText('Incorrect username or password.');
});

test('an unknown username gets the identical message', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Username').fill('no-such-person');
	await page.getByLabel('Password').fill('whatever');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toHaveText('Incorrect username or password.');
});

test('the bootstrap admin signs in and is forced to change credentials', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Username').fill('admin');
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();

	await expect(page).toHaveURL(/\/account\/credentials/);
	await expect(page.getByRole('heading', { name: 'Set your credentials' })).toBeVisible();
});

test('the forced change cannot be skipped by navigating elsewhere', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Username').fill('admin');
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/account\/credentials/);

	// An unrotated bootstrap account must not reach the application.
	await page.goto('/');
	await expect(page).toHaveURL(/\/account\/credentials/);
});

test('the session cookie is HttpOnly and SameSite=Lax', async ({ page, context }) => {
	await page.goto('/login');
	await page.getByLabel('Username').fill('admin');
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/account\/credentials/);

	const cookie = (await context.cookies()).find((c) => c.name === 'lifeos_session');
	expect(cookie, 'session cookie should be set').toBeTruthy();
	expect(cookie!.httpOnly).toBe(true);
	expect(cookie!.sameSite).toBe('Lax');
	// The stored value is a hash; the cookie must not be a guessable id.
	expect(cookie!.value.length).toBeGreaterThan(30);
});

test('rotating credentials unlocks the app and the admin surface', async ({ page }) => {
	// Runs last: it changes the bootstrap password, so earlier tests must have
	// already used it.
	await page.goto('/login');
	await page.getByLabel('Username').fill('admin');
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/account\/credentials/);

	await page.getByLabel('Username').fill('jordan');
	await page.getByLabel('Current password').fill(PASSWORD);
	await page.getByLabel('New password', { exact: true }).fill('a-much-longer-password');
	await page.getByLabel('Confirm new password').fill('a-much-longer-password');
	await page.getByRole('button', { name: 'Save and continue' }).click();

	// The forced-rotation redirect no longer applies.
	await expect(page).toHaveURL('/');

	// An admin can now reach the account and audit surfaces.
	await page.goto('/admin/people');
	await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'jordan' })).toBeVisible();

	await page.goto('/admin/audit');
	await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
	// The rotation was recorded.
	await expect(page.getByText('credentials.changed').first()).toBeVisible();
});
