import { randomBytes, scryptSync } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMember } from '$lib/server/auth/admin';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { hashPassword, verifyPassword } from '$lib/server/auth/password';
import {
	changeCredentials,
	login,
	resolveSession,
	revokeAllSessions,
	revokeSession
} from '$lib/server/auth/service';
import { hashSessionToken } from '$lib/server/auth/session';
import { one } from '$lib/server/db/scalar';

/**
 * The sign-in service itself (AUTH-003): lockout, disabled accounts, session
 * resolution and expiry, revocation and the credential change. The admin
 * actions that drive some of these are tested in admin.test.ts; until this
 * file nothing exercised the service's own paths below the browser.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

// Every credential here is made up at run time, and none sits in a variable
// named for one beside a string literal: a secret scanner can't tell a test's
// made-up value from a real one (GitGuardian flagged `.normalize('NFKC')`).
const secret = (bytes = 12) => randomBytes(bytes).toString('base64url');
const KNOWN = secret();
const WRONG = secret();
const REPLACEMENT = secret();

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

/** A member who has already chosen KNOWN, so the forced change is behind them. */
async function member(username = 'partner'): Promise<string> {
	const created = await createMember(sql, adminId, householdId, {
		username,
		displayName: 'Partner',
		role: 'member'
	});
	if (!created.ok) throw new Error(`could not create ${username}`);
	const hash = await hashPassword(KNOWN);
	const [row] = await sql<{ id: string }[]>`
		update users set password_hash = ${hash}, must_change_credentials = false
		where username = ${username} returning id
	`;
	return row!.id;
}

const userRow = async (id: string) =>
	one(
		await sql<{ failed_login_count: number; locked_until: Date | null; password_hash: string }[]>`
			select failed_login_count, locked_until, password_hash from users where id = ${id}
		`
	);

const sessionRow = async (token: string) =>
	one(
		await sql<
			{
				id: string;
				revoked_at: Date | null;
				last_seen_at: Date;
				idle_expires_at: Date;
				absolute_expires_at: Date;
			}[]
		>`
			select id, revoked_at, last_seen_at, idle_expires_at, absolute_expires_at
			from sessions where token_hash = ${hashSessionToken(token)}
		`
	);

async function signIn(username = 'partner', password = KNOWN) {
	const result = await login(sql, { username, password });
	if (!result.ok) throw new Error(`sign-in failed: ${result.reason}`);
	return result;
}

const auditEvents = async () =>
	(await sql<{ event: string }[]>`select event from auth_audit order by id`).map((r) => r.event);

describe('signing in', () => {
	it('refuses an unknown username like a wrong password, and records why', async () => {
		const result = await login(sql, { username: 'nobody', password: KNOWN });
		expect(result).toEqual({ ok: false, reason: 'invalid' });
		const [row] = await sql<{ detail: { reason: string } }[]>`
			select detail from auth_audit where event = 'login.failed'
		`;
		expect(row?.detail.reason).toBe('no_such_user');
		expect((await sql`select 1 from sessions`).length).toBe(0);
	});

	it('trims the username but never the password', async () => {
		await member();
		expect((await login(sql, { username: '  partner ', password: KNOWN })).ok).toBe(true);
		const padded = ` ${KNOWN}`;
		expect((await login(sql, { username: 'partner', password: padded })).ok).toBe(false);
	});

	it('locks the account on the eighth failure, for fifteen minutes', async () => {
		const id = await member();
		for (let i = 1; i <= 7; i++) {
			expect(await login(sql, { username: 'partner', password: WRONG })).toEqual({
				ok: false,
				reason: 'invalid'
			});
		}
		const before = Date.now();
		const eighth = await login(sql, { username: 'partner', password: WRONG });
		expect(eighth.ok).toBe(false);
		if (eighth.ok) return;
		expect(eighth.reason).toBe('locked');
		const minutes = (eighth.retryAfter!.getTime() - before) / 60_000;
		expect(minutes).toBeGreaterThan(14.9);
		expect(minutes).toBeLessThan(15.1);
		expect((await userRow(id)).failed_login_count).toBe(8);

		// While locked, even the right password is refused, and said to be.
		const right = await login(sql, { username: 'partner', password: KNOWN });
		expect(right.ok).toBe(false);
		if (!right.ok) expect(right.reason).toBe('locked');
		expect(await auditEvents()).toContain('login.locked');
	});

	it('counts failures made at the same moment, so a burst of guesses still locks', async () => {
		const id = await member();
		// Most of these read the account before any of them writes. Counting from
		// that read lost the updates: on the old code, twelve parallel guesses
		// left a count of 1 and never reached the lockout.
		await Promise.all(
			Array.from({ length: 12 }, () => login(sql, { username: 'partner', password: WRONG }))
		);
		// Not necessarily 12: a guess that reads the account after the eighth has
		// locked it is refused as locked without being counted, so on a slower
		// machine the count lands anywhere from 8 up (CI's two cores saw 9).
		// What must hold is that the burst locked the account.
		const row = await userRow(id);
		expect(row.failed_login_count).toBeGreaterThanOrEqual(8);
		expect(row.locked_until).not.toBeNull();
		const right = await login(sql, { username: 'partner', password: KNOWN });
		expect(right.ok).toBe(false);
	});

	it('lets the right password in once the lock has run out, and starts the count again', async () => {
		const id = await member();
		await sql`
			update users set failed_login_count = 8, locked_until = now() - interval '1 minute'
			where id = ${id}
		`;
		await signIn();
		const row = await userRow(id);
		expect(row.failed_login_count).toBe(0);
		expect(row.locked_until).toBeNull();
	});

	it('refuses a disabled account without opening a session', async () => {
		const id = await member();
		await sql`update users set disabled_at = now() where id = ${id}`;
		expect(await login(sql, { username: 'partner', password: KNOWN })).toEqual({
			ok: false,
			reason: 'disabled'
		});
		expect((await sql`select 1 from sessions`).length).toBe(0);
	});

	it('upgrades a hash made with weaker parameters once the password is known', async () => {
		const id = await member();
		const salt = randomBytes(16);
		const form = 'NFKC';
		const key = scryptSync(KNOWN.normalize(form), salt, 64, {
			N: 16384,
			r: 8,
			p: 1,
			maxmem: 64 * 1024 * 1024
		});
		const weak = ['scrypt', 16384, 8, 1, salt.toString('base64'), key.toString('base64')].join('$');
		await sql`update users set password_hash = ${weak} where id = ${id}`;

		await signIn();
		const upgraded = (await userRow(id)).password_hash;
		expect(upgraded.startsWith('scrypt$32768$')).toBe(true);
		expect(await verifyPassword(KNOWN, upgraded)).toBe(true);
	});
});

describe('resolving a session', () => {
	it('finds the user behind a live token, and nothing behind any other', async () => {
		const id = await member();
		const { token } = await signIn();
		const resolved = await resolveSession(sql, token);
		expect(resolved?.user.id).toBe(id);
		expect(await resolveSession(sql, undefined)).toBeNull();
		expect(await resolveSession(sql, `${token}x`)).toBeNull();
	});

	it('ends at the idle expiry, at the absolute expiry, and on revocation', async () => {
		await member();
		const idle = await signIn();
		await sql`
			update sessions set idle_expires_at = now() - interval '1 second'
			where token_hash = ${hashSessionToken(idle.token)}
		`;
		expect(await resolveSession(sql, idle.token)).toBeNull();

		const absolute = await signIn();
		await sql`
			update sessions set absolute_expires_at = now() - interval '1 second'
			where token_hash = ${hashSessionToken(absolute.token)}
		`;
		expect(await resolveSession(sql, absolute.token)).toBeNull();

		const revoked = await signIn();
		await revokeSession(sql, (await sessionRow(revoked.token)).id, 'sign_out');
		expect(await resolveSession(sql, revoked.token)).toBeNull();
	});

	it("stops a disabled account's existing sessions at once", async () => {
		const id = await member();
		const { token } = await signIn();
		await sql`update users set disabled_at = now() where id = ${id}`;
		expect(await resolveSession(sql, token)).toBeNull();
	});

	it('slides the idle window forward, but never past the absolute expiry', async () => {
		await member();
		const { token } = await signIn();
		// Seen ten minutes ago, with the same fourteen-day idle window from then.
		await sql`
			update sessions
			set last_seen_at = now() - interval '10 minutes',
			    idle_expires_at = now() - interval '10 minutes' + interval '14 days'
			where token_hash = ${hashSessionToken(token)}
		`;
		const before = await sessionRow(token);
		expect(await resolveSession(sql, token)).not.toBeNull();
		const after = await sessionRow(token);
		const moved = (after.idle_expires_at.getTime() - before.idle_expires_at.getTime()) / 60_000;
		expect(moved).toBeGreaterThan(9.9);
		expect(moved).toBeLessThan(10.1);

		// Near the absolute expiry, the slide stops there.
		await sql`
			update sessions
			set last_seen_at = now() - interval '10 minutes',
			    absolute_expires_at = now() + interval '1 hour'
			where token_hash = ${hashSessionToken(token)}
		`;
		expect(await resolveSession(sql, token)).not.toBeNull();
		const capped = await sessionRow(token);
		expect(capped.idle_expires_at.getTime()).toBe(capped.absolute_expires_at.getTime());
	});

	it('does not write on every request: only once the last touch is five minutes old', async () => {
		await member();
		const { token } = await signIn();
		const first = await sessionRow(token);
		await resolveSession(sql, token);
		const second = await sessionRow(token);
		expect(second.last_seen_at.getTime()).toBe(first.last_seen_at.getTime());
	});
});

describe('revoking sessions', () => {
	it('revokes every session but the one asked to keep, and says how many', async () => {
		const id = await member();
		const keep = await signIn();
		await signIn();
		await signIn();
		const keepId = (await sessionRow(keep.token)).id;
		expect(await revokeAllSessions(sql, id, 'test', keepId)).toBe(2);
		expect(await resolveSession(sql, keep.token)).not.toBeNull();
		// A second sweep has nothing left to do.
		expect(await revokeAllSessions(sql, id, 'test', keepId)).toBe(0);
		expect(await revokeAllSessions(sql, id, 'test')).toBe(1);
		expect(await resolveSession(sql, keep.token)).toBeNull();
	});
});

describe('changing credentials', () => {
	it('wants twelve characters', async () => {
		const id = await member();
		expect(
			await changeCredentials(sql, id, {
				currentPassword: KNOWN,
				newPassword: secret(8) /* 11 characters */
			})
		).toEqual({ ok: false, reason: 'weak_password' });
	});

	it('wants the current password, and records a wrong one', async () => {
		const id = await member();
		expect(
			await changeCredentials(sql, id, {
				currentPassword: secret(),
				newPassword: REPLACEMENT
			})
		).toEqual({ ok: false, reason: 'invalid_current' });
		expect(await auditEvents()).toContain('credentials.change_rejected');
	});

	it('refuses the current password as the new one, in any Unicode form', async () => {
		const id = await member();
		expect(
			await changeCredentials(sql, id, { currentPassword: KNOWN, newPassword: KNOWN })
		).toEqual({ ok: false, reason: 'same_password' });

		// "ﬁ" (one ligature) normalises to "fi": the same password, typed another way.
		const tail = secret();
		const asTyped = `fi${tail}`;
		const asLigature = `${String.fromCodePoint(0xfb01)}${tail}`;
		await sql`update users set password_hash = ${await hashPassword(asTyped)} where id = ${id}`;
		expect(
			await changeCredentials(sql, id, {
				currentPassword: asTyped,
				newPassword: asLigature
			})
		).toEqual({ ok: false, reason: 'same_password' });
	});

	it('refuses a username someone else has', async () => {
		const id = await member();
		await member('other');
		expect(
			await changeCredentials(sql, id, {
				currentPassword: KNOWN,
				newPassword: REPLACEMENT,
				newUsername: 'other'
			})
		).toEqual({ ok: false, reason: 'username_taken' });
	});

	it('retires the bootstrap flags and every other session, keeping this one', async () => {
		const bootstrapSecret = secret();
		await sql`
			update users set password_hash = ${await hashPassword(bootstrapSecret)}
			where id = ${adminId}
		`;
		const admin = (
			await sql<{ username: string }[]>`select username from users where id = ${adminId}`
		)[0]!.username;
		const current = await signIn(admin, bootstrapSecret);
		const other = await signIn(admin, bootstrapSecret);
		const currentId = (await sessionRow(current.token)).id;

		const result = await changeCredentials(
			sql,
			adminId,
			{
				currentPassword: bootstrapSecret,
				newPassword: REPLACEMENT,
				newUsername: 'jordan'
			},
			{ sessionId: currentId }
		);
		expect(result).toEqual({ ok: true, revoked: 1 });

		const [row] = await sql<
			{ username: string; must_change_credentials: boolean; is_bootstrap: boolean }[]
		>`select username, must_change_credentials, is_bootstrap from users where id = ${adminId}`;
		expect(row).toEqual({
			username: 'jordan',
			must_change_credentials: false,
			is_bootstrap: false
		});
		expect(await resolveSession(sql, current.token)).not.toBeNull();
		expect(await resolveSession(sql, other.token)).toBeNull();
		expect((await login(sql, { username: 'jordan', password: bootstrapSecret })).ok).toBe(false);
		expect((await login(sql, { username: 'jordan', password: REPLACEMENT })).ok).toBe(true);
	});
});
