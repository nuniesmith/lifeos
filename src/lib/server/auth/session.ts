import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque session tokens.
 *
 * The token is random and carries no claims — there is nothing to forge or
 * decode. Only its SHA-256 hash is stored, so a database disclosure does not
 * hand over usable sessions. SHA-256 is correct here rather than a password
 * KDF: the input is already 256 bits of entropy, so there is nothing to
 * brute-force and no reason to pay a KDF's cost on every request.
 */

const TOKEN_BYTES = 32;

export const SESSION_COOKIE = 'lifeos_session';

/** Idle timeout: a session unused for this long is dead. */
export const IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Absolute lifetime: a session is re-authenticated after this regardless. */
export const ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** How stale last_seen_at may get before a write. Avoids a write per request. */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface NewSessionToken {
	/** Sent to the client. Never stored. */
	token: string;
	/** Stored. Never sent. */
	tokenHash: Buffer;
	idleExpiresAt: Date;
	absoluteExpiresAt: Date;
}

export function hashSessionToken(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}

export function createSessionToken(now = new Date()): NewSessionToken {
	const token = randomBytes(TOKEN_BYTES).toString('base64url');
	return {
		token,
		tokenHash: hashSessionToken(token),
		idleExpiresAt: new Date(now.getTime() + IDLE_TTL_MS),
		absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_TTL_MS)
	};
}

/** Constant-time comparison for stored hashes. */
export function sessionHashEquals(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

export interface SessionRow {
	idleExpiresAt: Date;
	absoluteExpiresAt: Date;
	revokedAt: Date | null;
}

export type SessionState = 'active' | 'revoked' | 'idle_expired' | 'absolute_expired';

/**
 * Classifies a session. Split from the query so the rules are testable without
 * a database, and so every caller applies the same ones.
 */
export function sessionState(row: SessionRow, now = new Date()): SessionState {
	if (row.revokedAt) return 'revoked';
	if (now >= row.absoluteExpiresAt) return 'absolute_expired';
	if (now >= row.idleExpiresAt) return 'idle_expired';
	return 'active';
}

export function isActive(row: SessionRow, now = new Date()): boolean {
	return sessionState(row, now) === 'active';
}

/**
 * Whether the session cookie should carry `Secure`.
 *
 * Derived from the configured external ORIGIN, not from the incoming request:
 * in production Tailscale terminates TLS and forwards plain HTTP to Nginx, so
 * the request protocol is http even though the user is on https. Deriving it
 * from the request would drop `Secure` in production; deriving it from `dev`
 * would set `Secure` on a plain-HTTP loopback deployment, where the browser
 * then declines to send the cookie back and every sign-in silently bounces to
 * the login page.
 */
export function shouldUseSecureCookie(origin: string | undefined): boolean {
	return origin?.startsWith('https://') ?? true;
}

/** Cookie attributes. */
export function sessionCookieOptions(secure: boolean, expires: Date) {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure,
		expires
	};
}
