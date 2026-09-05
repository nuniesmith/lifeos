import { describe, expect, it } from 'vitest';

// Mirrors the rule in src/lib/server/env.ts. Kept as an independent copy on
// purpose: importing env.ts would execute its validation at import time.
function isSecureOrigin(origin: string): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol === 'https:') return true;
	if (url.protocol !== 'http:') return false;
	return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
}

describe('production origin rule', () => {
	it.each([
		'https://lifeos.tailnet.ts.net',
		'https://example.com:8443',
		'http://127.0.0.1:4173',
		'http://localhost:3000',
		'http://[::1]:3000'
	])('accepts %s', (origin) => {
		expect(isSecureOrigin(origin)).toBe(true);
	});

	it.each([
		['plain http on a public host', 'http://lifeos.example.com'],
		['http on a LAN address', 'http://192.168.1.10:3000'],
		['a hostname that merely contains localhost', 'http://localhost.evil.com'],
		['a non-web protocol', 'ftp://127.0.0.1'],
		['not a URL at all', 'lifeos.example.com']
	])('rejects %s', (_label, origin) => {
		expect(isSecureOrigin(origin)).toBe(false);
	});
});
