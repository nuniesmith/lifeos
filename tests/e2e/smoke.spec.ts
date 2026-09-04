import { expect, test } from '@playwright/test';

test('home page renders', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'LifeOS', level: 1 })).toBeVisible();
});

test('liveness answers without a database', async ({ request }) => {
	// No database is running in the e2e environment. Liveness must still be
	// 200 — if this ever fails, the container would restart-loop whenever
	// PostgreSQL is briefly unavailable.
	const res = await request.get('/api/health/live');
	expect(res.status()).toBe(200);
	expect(await res.json()).toEqual({ status: 'ok' });
});

test('readiness reports failure when the database is unreachable', async ({ request }) => {
	const res = await request.get('/api/health/ready');
	expect(res.status()).toBe(503);
	expect((await res.json()).status).toBe('fail');
});
