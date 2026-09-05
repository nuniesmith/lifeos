import { describe, expect, it } from 'vitest';
import {
	generateBootstrapPassword,
	hashPassword,
	needsRehash,
	verifyPassword
} from '$lib/server/auth/password';

describe('password hashing', () => {
	it('verifies a correct password', async () => {
		const h = await hashPassword('correct horse battery staple');
		expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
	});

	it('rejects a wrong password', async () => {
		const h = await hashPassword('correct horse battery staple');
		expect(await verifyPassword('Correct horse battery staple', h)).toBe(false);
	});

	it('produces a different hash each time (random salt)', async () => {
		const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
		expect(a).not.toBe(b);
		expect(await verifyPassword('same', a)).toBe(true);
		expect(await verifyPassword('same', b)).toBe(true);
	});

	it('normalises unicode so the same typed password verifies', async () => {
		// U+00E9 vs e + U+0301 look identical and can differ by keyboard.
		const h = await hashPassword('café');
		expect(await verifyPassword('café', h)).toBe(true);
	});

	it.each([
		['empty', ''],
		['not scrypt', 'argon2$x$y'],
		['too few fields', 'scrypt$32768$8$1$abc'],
		['non-numeric cost', 'scrypt$N$8$1$YWJj$YWJj'],
		['absurd cost', 'scrypt$99999999$8$1$YWJj$YWJj'],
		['empty salt', 'scrypt$32768$8$1$$YWJj']
	])('returns false rather than throwing for a malformed hash: %s', async (_label, stored) => {
		await expect(verifyPassword('anything', stored)).resolves.toBe(false);
	});

	it('flags weaker stored parameters for rehash', async () => {
		expect(needsRehash('scrypt$16384$8$1$YWJj$YWJj')).toBe(true);
		expect(needsRehash(await hashPassword('x'))).toBe(false);
	});
});

describe('bootstrap password', () => {
	it('has the requested length and avoids ambiguous characters', () => {
		const p = generateBootstrapPassword(32);
		expect(p).toHaveLength(32);
		expect(p).not.toMatch(/[Il1O0]/);
	});

	it('does not repeat across calls', () => {
		const seen = new Set(Array.from({ length: 50 }, () => generateBootstrapPassword(16)));
		expect(seen.size).toBe(50);
	});
});
