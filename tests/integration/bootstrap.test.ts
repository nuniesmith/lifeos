import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { verifyPassword } from '$lib/server/auth/password';
import { count as countOf, one } from '$lib/server/db/scalar';

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { max: 4, onnotice: () => {} });

async function reset() {
	// household_members and auth_audit clear by cascade / set null.
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(reset);
afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

describe('first-run bootstrap', () => {
	it('creates exactly one admin, one household, and a membership', async () => {
		const result = await bootstrapIfEmpty(sql);
		expect(result.status).toBe('created');

		const users = countOf(await sql<{ count: number }[]>`select count(*)::int from users`);
		const households = countOf(
			await sql<{ count: number }[]>`select count(*)::int from households`
		);
		const members = countOf(
			await sql<{ count: number }[]>`select count(*)::int from household_members`
		);
		expect([users, households, members]).toEqual([1, 1, 1]);
	});

	it('forces a credential change and marks the account as bootstrap', async () => {
		await bootstrapIfEmpty(sql);
		const u = one(
			await sql<{ must_change_credentials: boolean; is_bootstrap: boolean }[]>`
				select must_change_credentials, is_bootstrap from users
			`
		);
		expect(u.must_change_credentials).toBe(true);
		expect(u.is_bootstrap).toBe(true);
	});

	it('stores a verifiable hash, not the password', async () => {
		const result = await bootstrapIfEmpty(sql);
		if (result.status !== 'created' || !result.password) throw new Error('expected a password');

		const u = one(await sql<{ password_hash: string }[]>`select password_hash from users`);
		expect(u.password_hash).not.toContain(result.password);
		expect(await verifyPassword(result.password, u.password_hash)).toBe(true);
	});

	it('is a no-op once a user exists', async () => {
		await bootstrapIfEmpty(sql);
		const second = await bootstrapIfEmpty(sql);
		expect(second.status).toBe('already_initialised');

		expect(countOf(await sql<{ count: number }[]>`select count(*)::int from users`)).toBe(1);
	});

	it('records the event without recording the password', async () => {
		const result = await bootstrapIfEmpty(sql);
		if (result.status !== 'created' || !result.password) throw new Error('expected a password');

		const rows = await sql<{ event: string; detail: unknown }[]>`
			select event, detail from auth_audit
		`;
		expect(rows).toHaveLength(1);
		const row = one(rows);
		expect(row.event).toBe('bootstrap.created');
		expect(JSON.stringify(row.detail)).not.toContain(result.password);
	});

	// The reason the advisory lock exists. Without it, concurrent workers can
	// both observe an empty users table and both attempt to create an admin.
	it('creates one admin when several workers start simultaneously', async () => {
		const results = await Promise.all(
			Array.from({ length: 4 }, () => bootstrapIfEmpty(sql).catch((e) => ({ error: e })))
		);

		expect(countOf(await sql<{ count: number }[]>`select count(*)::int from users`)).toBe(1);

		const created = results.filter((r) => 'status' in r && r.status === 'created');
		const already = results.filter((r) => 'status' in r && r.status === 'already_initialised');
		expect(created).toHaveLength(1);
		// Every other worker must observe the initialised state, not an error.
		expect(already).toHaveLength(3);
	});
});
