import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
	createMember,
	listMembers,
	resetCredential,
	setDisabled,
	setRole
} from '$lib/server/auth/admin';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { verifyPassword } from '$lib/server/auth/password';
import { login, resolveSession } from '$lib/server/auth/service';
import { count as countOf, one } from '$lib/server/db/scalar';

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let adminId: string;
let householdId: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	adminId = one(await sql<{ id: string }[]>`select id from users limit 1`, 'admin').id;
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`, 'household').id;
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const makeMember = (over: Partial<{ username: string; role: 'admin' | 'member' }> = {}) =>
	createMember(sql, adminId, householdId, {
		username: over.username ?? 'partner',
		displayName: 'Partner',
		role: over.role ?? 'member'
	});

describe('creating accounts', () => {
	it('creates a member who can sign in with the one-time password', async () => {
		const created = await makeMember();
		if (!created.ok) throw new Error('expected creation to succeed');

		const result = await login(sql, { username: 'partner', password: created.password });
		expect(result.ok).toBe(true);
		if (result.ok) {
			// A new account must rotate before it can use the application.
			expect(result.user.mustChangeCredentials).toBe(true);
			expect(result.user.role).toBe('member');
		}
	});

	it('stores a hash, never the password', async () => {
		const created = await makeMember();
		if (!created.ok) throw new Error('expected creation to succeed');
		const u = one(
			await sql<{ password_hash: string }[]>`
				select password_hash from users where username = 'partner'
			`
		);
		expect(u.password_hash).not.toContain(created.password);
		expect(await verifyPassword(created.password, u.password_hash)).toBe(true);
	});

	it('refuses a duplicate username without leaving a partial account', async () => {
		await makeMember();
		const before = countOf(await sql<{ count: number }[]>`select count(*)::int from users`);
		const second = await makeMember();
		expect(second.ok).toBe(false);
		const after = countOf(await sql<{ count: number }[]>`select count(*)::int from users`);
		expect(after).toBe(before);
	});

	it('places the new account in the same household', async () => {
		await makeMember();
		const members = await listMembers(sql, householdId);
		expect(members.map((m) => m.username).sort()).toEqual(['admin', 'partner']);
	});
});

describe('the last administrator cannot be removed', () => {
	it('refuses to disable the only admin', async () => {
		await makeMember({ role: 'member' });
		const other = one(await sql<{ id: string }[]>`select id from users where username = 'partner'`);
		// Acting as the member so the self-disable rule is not what refuses it.
		const result = await setDisabled(sql, other.id, adminId, true);
		expect(result).toEqual({ ok: false, reason: 'last_admin' });
	});

	it('refuses to demote the only admin', async () => {
		const result = await setRole(sql, adminId, adminId, 'member');
		expect(result).toEqual({ ok: false, reason: 'last_admin' });
	});

	it('refuses self-disable even when another admin exists', async () => {
		await makeMember({ username: 'second-admin', role: 'admin' });
		const result = await setDisabled(sql, adminId, adminId, true);
		expect(result).toEqual({ ok: false, reason: 'self' });
	});

	it('allows disabling an admin once a second one exists', async () => {
		await makeMember({ username: 'second-admin', role: 'admin' });
		const second = one(
			await sql<{ id: string }[]>`select id from users where username = 'second-admin'`
		);
		expect(await setDisabled(sql, second.id, adminId, true)).toEqual({ ok: true });
	});
});

describe('disabling an account', () => {
	it('revokes live sessions immediately and refuses new sign-ins', async () => {
		const created = await makeMember();
		if (!created.ok) throw new Error('expected creation to succeed');

		const session = await login(sql, { username: 'partner', password: created.password });
		if (!session.ok) throw new Error('expected sign-in to succeed');
		expect(await resolveSession(sql, session.token)).not.toBeNull();

		await setDisabled(sql, adminId, created.userId, true);

		// The existing session stops working without waiting for expiry.
		expect(await resolveSession(sql, session.token)).toBeNull();
		const again = await login(sql, { username: 'partner', password: created.password });
		expect(again).toMatchObject({ ok: false, reason: 'disabled' });
	});

	it('can be reversed', async () => {
		const created = await makeMember();
		if (!created.ok) throw new Error('expected creation to succeed');
		await setDisabled(sql, adminId, created.userId, true);
		expect(await setDisabled(sql, adminId, created.userId, false)).toEqual({ ok: true });

		const result = await login(sql, { username: 'partner', password: created.password });
		expect(result.ok).toBe(true);
	});
});

describe('credential reset', () => {
	it('issues a working password, invalidates the old one, and kills sessions', async () => {
		const created = await makeMember();
		if (!created.ok) throw new Error('expected creation to succeed');

		const session = await login(sql, { username: 'partner', password: created.password });
		if (!session.ok) throw new Error('expected sign-in to succeed');

		const { password } = await resetCredential(sql, adminId, created.userId);

		expect(await resolveSession(sql, session.token)).toBeNull();
		expect(await login(sql, { username: 'partner', password: created.password })).toMatchObject({
			ok: false
		});
		expect(await login(sql, { username: 'partner', password })).toMatchObject({ ok: true });
	});

	it('clears an existing lockout so recovery is actually possible', async () => {
		const created = await makeMember();
		if (!created.ok) throw new Error('expected creation to succeed');
		await sql`
			update users set failed_login_count = 8,
			                 locked_until = now() + interval '1 hour'
			where id = ${created.userId}
		`;
		const { password } = await resetCredential(sql, adminId, created.userId);
		expect(await login(sql, { username: 'partner', password })).toMatchObject({ ok: true });
	});
});

describe('audit', () => {
	it('records who did what, without recording credentials', async () => {
		const created = await makeMember();
		if (!created.ok) throw new Error('expected creation to succeed');

		const rows = await sql<{ event: string; actor_id: string | null; detail: unknown }[]>`
			select event, actor_id, detail from auth_audit where event = 'account.created'
		`;
		expect(rows).toHaveLength(1);
		expect(rows[0]!.actor_id).toBe(adminId);
		expect(JSON.stringify(rows[0]!.detail)).not.toContain(created.password);
	});
});
