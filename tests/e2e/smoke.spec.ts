import { expect, test } from '@playwright/test';

test('liveness answers', async ({ request }) => {
	const res = await request.get('/api/health/live');
	expect(res.status()).toBe(200);
	expect(await res.json()).toEqual({ status: 'ok' });
});

test('readiness reports a healthy database', async ({ request }) => {
	const res = await request.get('/api/health/ready');
	const body = await res.json();
	const db = body.checks?.find((c: { name: string }) => c.name === 'database');
	const migrations = body.checks?.find((c: { name: string }) => c.name === 'migrations');
	expect(res.status()).toBe(200);
	expect(db?.status).toBe('ok');
	expect(migrations?.status).toBe('ok');
});
