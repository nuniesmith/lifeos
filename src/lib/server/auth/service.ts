import type { Sql } from 'postgres';
import { toDate, toDateOrNull } from '../db/coerce';
import { one } from '../db/scalar';
import { logger } from '../logger';
import { hashPassword, needsRehash, verifyPassword } from './password';
import {
	TOUCH_INTERVAL_MS,
	createSessionToken,
	hashSessionToken,
	sessionState,
	type SessionState
} from './session';

/**
 * Authentication service (AUTH-003).
 *
 * Every function here fails closed: a database error results in a denied
 * request, never an allowed one. Callers receive a discriminated result rather
 * than exceptions, so a forgotten catch cannot become an open door.
 *
 * Timestamps are passed as ISO strings with an explicit ::timestamptz cast,
 * and `now()` is used where the value is simply "current time". Passing a JS
 * Date works in a plain Node process but reached the driver's string
 * serializer unconverted in the bundled server build, failing every login at
 * runtime while all tests passed. The same happened with the driver's json()
 * helper during bootstrap. Nothing here relies on driver-side serialization of
 * a JS object.
 */

export interface AuthUser {
	id: string;
	username: string | null;
	displayName: string;
	role: 'admin' | 'member';
	mustChangeCredentials: boolean;
	isBootstrap: boolean;
}

export type LoginResult =
	| { ok: true; token: string; expires: Date; user: AuthUser }
	| { ok: false; reason: 'invalid' | 'locked' | 'disabled' | 'unavailable'; retryAfter?: Date };

/** Failed attempts before an account is locked. */
const MAX_FAILED = 8;

/** How long an account stays locked once the threshold is reached. */
const LOCKOUT_MS = 15 * 60 * 1000;

interface UserRow {
	id: string;
	username: string | null;
	display_name: string;
	role: 'admin' | 'member';
	password_hash: string;
	must_change_credentials: boolean;
	is_bootstrap: boolean;
	// Timestamps are typed as unknown deliberately: the driver may hand back
	// a Date or a string depending on the build, so every read goes through
	// toDate/toDateOrNull rather than assuming one.
	disabled_at: unknown;
	failed_login_count: number;
	locked_until: unknown;
}

const toAuthUser = (r: UserRow): AuthUser => ({
	id: r.id,
	username: r.username,
	displayName: r.display_name,
	role: r.role,
	mustChangeCredentials: r.must_change_credentials,
	isBootstrap: r.is_bootstrap
});

async function audit(
	sql: Sql,
	event: string,
	fields: {
		userId?: string | null;
		actorId?: string | null;
		clientIp?: string | null;
		userAgent?: string | null;
		detail?: Record<string, unknown>;
	} = {}
): Promise<void> {
	try {
		const detail = JSON.stringify(fields.detail ?? {});
		await sql`
			insert into auth_audit (event, user_id, actor_id, client_ip, user_agent, detail)
			values (
				${event}, ${fields.userId ?? null}, ${fields.actorId ?? null},
				${fields.clientIp ?? null}, ${fields.userAgent ?? null}, ${detail}::text::jsonb
			)
		`;
	} catch (err) {
		// An audit failure must not take down the operation being audited, but
		// it is itself notable.
		logger.error({ err, event }, 'failed to write auth audit');
	}
}

export async function login(
	sql: Sql,
	credentials: { username: string; password: string },
	context: { clientIp?: string | null; userAgent?: string | null } = {}
): Promise<LoginResult> {
	const username = credentials.username.trim();

	try {
		const rows = await sql<UserRow[]>`
			select id, username, display_name, role, password_hash,
			       must_change_credentials, is_bootstrap, disabled_at,
			       failed_login_count, locked_until
			from users where username = ${username}
		`;
		const user = rows[0];

		// Verify against a dummy hash when the account does not exist, so the
		// response time does not reveal which usernames are real.
		if (!user) {
			await verifyPassword(credentials.password, DUMMY_HASH);
			await audit(sql, 'login.failed', {
				clientIp: context.clientIp,
				userAgent: context.userAgent,
				detail: { reason: 'no_such_user' }
			});
			return { ok: false, reason: 'invalid' };
		}

		const now = new Date();
		const lockedUntil = toDateOrNull(user.locked_until);

		if (lockedUntil && lockedUntil > now) {
			await audit(sql, 'login.locked', {
				userId: user.id,
				clientIp: context.clientIp,
				detail: { until: lockedUntil.toISOString() }
			});
			return { ok: false, reason: 'locked', retryAfter: lockedUntil };
		}

		if (user.disabled_at) {
			await audit(sql, 'login.disabled', { userId: user.id, clientIp: context.clientIp });
			return { ok: false, reason: 'disabled' };
		}

		const valid = await verifyPassword(credentials.password, user.password_hash);

		if (!valid) {
			const failed = user.failed_login_count + 1;
			const lockUntil = failed >= MAX_FAILED ? new Date(now.getTime() + LOCKOUT_MS) : null;
			await sql`
				update users
				set failed_login_count = ${failed},
				    locked_until = ${lockUntil?.toISOString() ?? null}::timestamptz
				where id = ${user.id}
			`;
			await audit(sql, 'login.failed', {
				userId: user.id,
				clientIp: context.clientIp,
				userAgent: context.userAgent,
				detail: { attempt: failed, locked: Boolean(lockUntil) }
			});
			return lockUntil
				? { ok: false, reason: 'locked', retryAfter: lockUntil }
				: { ok: false, reason: 'invalid' };
		}

		// Opportunistically upgrade a hash made with weaker parameters, now that
		// the plaintext is in hand and known correct.
		if (needsRehash(user.password_hash)) {
			const upgraded = await hashPassword(credentials.password);
			await sql`update users set password_hash = ${upgraded} where id = ${user.id}`;
		}

		const session = createSessionToken(now);
		await sql`
			update users
			set failed_login_count = 0, locked_until = null, last_login_at = now()
			where id = ${user.id}
		`;
		await sql`
			insert into sessions (
				user_id, token_hash, idle_expires_at, absolute_expires_at, user_agent, client_ip
			)
			values (
				${user.id}, ${session.tokenHash},
				${session.idleExpiresAt.toISOString()}::timestamptz,
				${session.absoluteExpiresAt.toISOString()}::timestamptz,
				${context.userAgent ?? null}, ${context.clientIp ?? null}
			)
		`;
		await audit(sql, 'login.succeeded', {
			userId: user.id,
			clientIp: context.clientIp,
			userAgent: context.userAgent
		});

		return {
			ok: true,
			token: session.token,
			expires: session.absoluteExpiresAt,
			user: toAuthUser(user)
		};
	} catch (err) {
		// Fail closed. An unreachable database denies access; it never grants it.
		logger.error({ err }, 'login failed with a database error');
		return { ok: false, reason: 'unavailable' };
	}
}

/**
 * A syntactically valid hash that no password matches, used to keep the
 * timing of a missing account close to that of a real one.
 */
const DUMMY_HASH =
	'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export interface ResolvedSession {
	user: AuthUser;
	sessionId: string;
}

/** Resolves a cookie token to a user, or null. Never throws. */
export async function resolveSession(
	sql: Sql,
	token: string | undefined
): Promise<ResolvedSession | null> {
	if (!token) return null;

	try {
		const rows = await sql<
			(UserRow & {
				session_id: string;
				idle_expires_at: unknown;
				absolute_expires_at: unknown;
				revoked_at: unknown;
				last_seen_at: unknown;
			})[]
		>`
			select s.id as session_id, s.idle_expires_at, s.absolute_expires_at,
			       s.revoked_at, s.last_seen_at,
			       u.id, u.username, u.display_name, u.role, u.password_hash,
			       u.must_change_credentials, u.is_bootstrap, u.disabled_at,
			       u.failed_login_count, u.locked_until
			from sessions s join users u on u.id = s.user_id
			where s.token_hash = ${hashSessionToken(token)}
		`;
		const row = rows[0];
		if (!row) return null;

		const now = new Date();
		const idleExpiresAt = toDate(row.idle_expires_at);
		const absoluteExpiresAt = toDate(row.absolute_expires_at);
		const lastSeenAt = toDate(row.last_seen_at);

		const state: SessionState = sessionState(
			{
				idleExpiresAt,
				absoluteExpiresAt,
				revokedAt: toDateOrNull(row.revoked_at)
			},
			now
		);
		if (state !== 'active') return null;

		// A disabled account's existing sessions stop working immediately.
		if (row.disabled_at) return null;

		// Sliding idle window, written at most once per TOUCH_INTERVAL_MS so a
		// busy session does not cause a write per request.
		if (now.getTime() - lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
			const idleExpires = new Date(
				now.getTime() + (idleExpiresAt.getTime() - lastSeenAt.getTime())
			);
			await sql`
				update sessions
				set last_seen_at = now(),
				    idle_expires_at = least(
				        ${idleExpires.toISOString()}::timestamptz, absolute_expires_at
				    )
				where id = ${row.session_id}
			`;
		}

		return { user: toAuthUser(row), sessionId: row.session_id };
	} catch (err) {
		logger.error({ err }, 'session resolution failed; treating request as anonymous');
		return null;
	}
}

export async function revokeSession(sql: Sql, sessionId: string, reason: string): Promise<void> {
	await sql`
		update sessions set revoked_at = now(), revoked_reason = ${reason}
		where id = ${sessionId} and revoked_at is null
	`;
}

/** Revokes every session for a user, optionally sparing the current one. */
export async function revokeAllSessions(
	sql: Sql,
	userId: string,
	reason: string,
	exceptSessionId?: string
): Promise<number> {
	const rows = await sql<{ id: string }[]>`
		update sessions set revoked_at = now(), revoked_reason = ${reason}
		where user_id = ${userId}
		  and revoked_at is null
		  and (${exceptSessionId ?? null}::uuid is null or id <> ${exceptSessionId ?? null}::uuid)
		returning id
	`;
	return rows.length;
}

export type ChangeCredentialsResult =
	| { ok: true; revoked: number }
	| { ok: false; reason: 'invalid_current' | 'username_taken' | 'weak_password' };

/**
 * Credential change. Completing this retires the bootstrap flag and revokes
 * every other session, as the first-run flow requires.
 */
export async function changeCredentials(
	sql: Sql,
	userId: string,
	input: { currentPassword: string; newUsername?: string; newPassword: string },
	context: { sessionId?: string; clientIp?: string | null } = {}
): Promise<ChangeCredentialsResult> {
	if (input.newPassword.length < 12) return { ok: false, reason: 'weak_password' };

	const current = one(
		await sql<{ password_hash: string }[]>`select password_hash from users where id = ${userId}`,
		'user'
	);
	if (!(await verifyPassword(input.currentPassword, current.password_hash))) {
		await audit(sql, 'credentials.change_rejected', {
			userId,
			clientIp: context.clientIp,
			detail: { reason: 'invalid_current' }
		});
		return { ok: false, reason: 'invalid_current' };
	}

	const hash = await hashPassword(input.newPassword);

	try {
		await sql`
			update users set
				password_hash = ${hash},
				password_updated_at = now(),
				username = coalesce(${input.newUsername ?? null}, username),
				must_change_credentials = false,
				is_bootstrap = false
			where id = ${userId}
		`;
	} catch (err) {
		// The partial unique index on username surfaces here.
		if (String(err).includes('users_username_key')) {
			return { ok: false, reason: 'username_taken' };
		}
		throw err;
	}

	const revoked = await revokeAllSessions(sql, userId, 'credential_change', context.sessionId);
	await audit(sql, 'credentials.changed', {
		userId,
		clientIp: context.clientIp,
		detail: { revokedSessions: revoked, usernameChanged: Boolean(input.newUsername) }
	});

	return { ok: true, revoked };
}
