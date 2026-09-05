import type { Sql } from 'postgres';
import { toDateOrNull } from '../db/coerce';
import { one } from '../db/scalar';
import { generateBootstrapPassword, hashPassword } from './password';

/**
 * Account administration (AUTH-004).
 *
 * Every mutation here is audited and every one is reversible except account
 * creation. Deleting a person is deliberately not offered: disabling keeps
 * their authored records attributable, which is what a shared household needs.
 */

export interface MemberSummary {
	id: string;
	username: string | null;
	displayName: string;
	role: 'admin' | 'member';
	disabledAt: Date | null;
	lockedUntil: Date | null;
	lastLoginAt: Date | null;
	mustChangeCredentials: boolean;
}

async function audit(
	sql: Sql,
	event: string,
	actorId: string,
	userId: string | null,
	detail: Record<string, unknown> = {}
): Promise<void> {
	await sql`
		insert into auth_audit (event, user_id, actor_id, detail)
		values (${event}, ${userId}, ${actorId}, ${JSON.stringify(detail)}::jsonb)
	`;
}

export async function listMembers(sql: Sql, householdId: string): Promise<MemberSummary[]> {
	const rows = await sql<Record<string, unknown>[]>`
		select u.id, u.username, u.display_name, u.role, u.disabled_at,
		       u.locked_until, u.last_login_at, u.must_change_credentials
		from users u
		join household_members hm on hm.user_id = u.id
		where hm.household_id = ${householdId}
		order by u.role, u.display_name
	`;
	return rows.map((r) => ({
		id: r.id as string,
		username: (r.username as string | null) ?? null,
		displayName: r.display_name as string,
		role: r.role as 'admin' | 'member',
		disabledAt: toDateOrNull(r.disabled_at),
		lockedUntil: toDateOrNull(r.locked_until),
		lastLoginAt: toDateOrNull(r.last_login_at),
		mustChangeCredentials: r.must_change_credentials as boolean
	}));
}

export type CreateMemberResult =
	| { ok: true; userId: string; username: string; password: string }
	| { ok: false; reason: 'username_taken' | 'invalid' };

/**
 * Creates an account with a one-time password, shown to the admin once so it
 * can be handed over directly. There is no mail path in this release, which is
 * a deliberate simplification for a two-person household.
 */
export async function createMember(
	sql: Sql,
	actorId: string,
	householdId: string,
	input: { username: string; displayName: string; role: 'admin' | 'member' }
): Promise<CreateMemberResult> {
	const username = input.username.trim();
	const displayName = input.displayName.trim();
	if (!username || !displayName) return { ok: false, reason: 'invalid' };

	const password = generateBootstrapPassword();
	const hash = await hashPassword(password);

	try {
		const userId = await sql.begin(async (tx) => {
			const user = one(
				await tx<{ id: string }[]>`
					insert into users (username, display_name, role, password_hash,
					                   must_change_credentials)
					values (${username}, ${displayName}, ${input.role}, ${hash}, true)
					returning id
				`,
				'user'
			);
			await tx`
				insert into household_members (household_id, user_id)
				values (${householdId}, ${user.id})
			`;
			await tx`
				insert into auth_audit (event, user_id, actor_id, detail)
				values ('account.created', ${user.id}, ${actorId},
				        ${JSON.stringify({ username, role: input.role })}::jsonb)
			`;
			return user.id;
		});
		return { ok: true, userId, username, password };
	} catch (err) {
		if (String(err).includes('users_username_key')) {
			return { ok: false, reason: 'username_taken' };
		}
		throw err;
	}
}

/** Issues a fresh one-time credential and revokes the account's sessions. */
export async function resetCredential(
	sql: Sql,
	actorId: string,
	userId: string
): Promise<{ password: string }> {
	const password = generateBootstrapPassword();
	const hash = await hashPassword(password);

	await sql.begin(async (tx) => {
		await tx`
			update users set
				password_hash = ${hash},
				password_updated_at = now(),
				must_change_credentials = true,
				failed_login_count = 0,
				locked_until = null
			where id = ${userId}
		`;
		await tx`
			update sessions set revoked_at = now(), revoked_reason = 'credential_reset'
			where user_id = ${userId} and revoked_at is null
		`;
		await tx`
			insert into auth_audit (event, user_id, actor_id, detail)
			values ('account.credential_reset', ${userId}, ${actorId}, '{}'::jsonb)
		`;
	});

	return { password };
}

export type AdminActionResult = { ok: true } | { ok: false; reason: 'last_admin' | 'self' };

/**
 * Disabling revokes sessions immediately. Refuses to disable the last enabled
 * admin, and refuses self-disable — either would lock the household out of its
 * own administration with only the CLI as a way back.
 */
export async function setDisabled(
	sql: Sql,
	actorId: string,
	userId: string,
	disabled: boolean
): Promise<AdminActionResult> {
	if (disabled && userId === actorId) return { ok: false, reason: 'self' };

	if (disabled && !(await hasAnotherActiveAdmin(sql, userId))) {
		return { ok: false, reason: 'last_admin' };
	}

	await sql.begin(async (tx) => {
		// Two statements rather than interpolating a nested sql`now()` fragment:
		// embedded driver objects are the same class of thing that reached the
		// wire unconverted in the bundled build. See db/coerce.ts.
		if (disabled) {
			await tx`update users set disabled_at = now() where id = ${userId}`;
		} else {
			await tx`update users set disabled_at = null where id = ${userId}`;
		}
		if (disabled) {
			await tx`
				update sessions set revoked_at = now(), revoked_reason = 'account_disabled'
				where user_id = ${userId} and revoked_at is null
			`;
		}
		await tx`
			insert into auth_audit (event, user_id, actor_id, detail)
			values (${disabled ? 'account.disabled' : 'account.enabled'}, ${userId}, ${actorId},
			        '{}'::jsonb)
		`;
	});
	return { ok: true };
}

/** Demotion is refused when it would leave no active admin. */
export async function setRole(
	sql: Sql,
	actorId: string,
	userId: string,
	role: 'admin' | 'member'
): Promise<AdminActionResult> {
	if (role === 'member' && !(await hasAnotherActiveAdmin(sql, userId))) {
		return { ok: false, reason: 'last_admin' };
	}
	await sql`update users set role = ${role} where id = ${userId}`;
	await audit(sql, 'account.role_changed', actorId, userId, { role });
	return { ok: true };
}

/** True when an enabled admin other than `excludingUserId` exists. */
async function hasAnotherActiveAdmin(sql: Sql, excludingUserId: string): Promise<boolean> {
	const rows = await sql<{ count: number }[]>`
		select count(*)::int as count from users
		where role = 'admin' and disabled_at is null and id <> ${excludingUserId}
	`;
	return (rows[0]?.count ?? 0) > 0;
}

export interface AuditEntry {
	id: string;
	at: Date;
	event: string;
	userId: string | null;
	actorId: string | null;
	detail: unknown;
}

/** Recent auth events, newest first. Detail never carries record content. */
export async function recentAudit(sql: Sql, limit = 100): Promise<AuditEntry[]> {
	const rows = await sql<Record<string, unknown>[]>`
		select id, at, event, user_id, actor_id, detail
		from auth_audit order by at desc limit ${Math.min(limit, 500)}
	`;
	return rows.map((r) => ({
		id: String(r.id),
		at: toDateOrNull(r.at) ?? new Date(0),
		event: r.event as string,
		userId: (r.user_id as string | null) ?? null,
		actorId: (r.actor_id as string | null) ?? null,
		detail: r.detail
	}));
}
