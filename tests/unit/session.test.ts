import { describe, expect, it } from 'vitest';
import {
	ABSOLUTE_TTL_MS,
	IDLE_TTL_MS,
	createSessionToken,
	hashSessionToken,
	isActive,
	sessionState
} from '$lib/server/auth/session';

const at = (ms: number) => new Date(ms);

describe('session tokens', () => {
	it('derives a stable hash and never reuses a token', () => {
		const a = createSessionToken();
		const b = createSessionToken();
		expect(a.token).not.toBe(b.token);
		expect(hashSessionToken(a.token).equals(a.tokenHash)).toBe(true);
	});

	it('does not store the token itself', () => {
		const { token, tokenHash } = createSessionToken();
		expect(tokenHash.toString('base64url')).not.toBe(token);
		expect(tokenHash).toHaveLength(32);
	});

	it('sets both expiries from the same instant', () => {
		const now = at(1_000_000);
		const s = createSessionToken(now);
		expect(s.idleExpiresAt.getTime()).toBe(1_000_000 + IDLE_TTL_MS);
		expect(s.absoluteExpiresAt.getTime()).toBe(1_000_000 + ABSOLUTE_TTL_MS);
	});
});

describe('session state', () => {
	const base = {
		idleExpiresAt: at(2000),
		absoluteExpiresAt: at(5000),
		revokedAt: null as Date | null
	};

	it('is active before either expiry', () => {
		expect(sessionState(base, at(1000))).toBe('active');
		expect(isActive(base, at(1000))).toBe(true);
	});

	it('expires on idle first', () => {
		expect(sessionState(base, at(2000))).toBe('idle_expired');
	});

	it('reports absolute expiry even when idle would also have passed', () => {
		expect(sessionState(base, at(5000))).toBe('absolute_expired');
	});

	it('treats revocation as final, ahead of any expiry', () => {
		const revoked = { ...base, revokedAt: at(500) };
		expect(sessionState(revoked, at(1000))).toBe('revoked');
		expect(sessionState(revoked, at(9999))).toBe('revoked');
	});

	it('is inactive exactly at the expiry boundary, not after it', () => {
		// A session must not survive its own expiry instant.
		expect(isActive(base, at(1999))).toBe(true);
		expect(isActive(base, at(2000))).toBe(false);
	});
});
