import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// promisify() resolves to the three-argument overload and drops the options
// parameter, so the wrapper is written out rather than inferred.
function scrypt(
	password: string,
	salt: Buffer,
	keylen: number,
	options: ScryptOptions
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCb(password, salt, keylen, options, (err, derived) =>
			err ? reject(err) : resolve(derived)
		);
	});
}

/**
 * Password hashing with `node:crypto` scrypt.
 *
 * Chosen over Argon2id deliberately (plan §9 offers both): scrypt here needs
 * no native dependency, which keeps the runtime image free of a compiled
 * module and of that module's own CVE stream.
 *
 * Parameters are stored in the hash string, so they can be raised later and
 * old credentials keep verifying until their owner next signs in.
 */

// N=2^15 costs ~32 MB per hash. That is a deliberate ceiling: the application
// container is capped at 448 MB on a 1 GB host, so a larger N risks the OOM
// killer on concurrent logins for a two-user household.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

// scrypt needs 128 * N * r bytes; Node's default maxmem (32 MB) is exactly at
// that boundary and throws, so it is raised explicitly.
const MAXMEM = 64 * 1024 * 1024;

const PREFIX = 'scrypt';

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, {
		N,
		r: R,
		p: P,
		maxmem: MAXMEM
	});
	return [PREFIX, N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Verifies a password. Returns false for malformed stored hashes rather than
 * throwing, so a corrupted row cannot be distinguished from a wrong password
 * by an attacker watching for error responses.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 6 || parts[0] !== PREFIX) return false;

	const n = Number(parts[1]);
	const r = Number(parts[2]);
	const p = Number(parts[3]);
	if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
	// Refuse absurd parameters from a tampered row rather than allocating on them.
	if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(parts[4] as string, 'base64');
		expected = Buffer.from(parts[5] as string, 'base64');
	} catch {
		return false;
	}
	if (salt.length === 0 || expected.length === 0) return false;

	let actual: Buffer;
	try {
		actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
			N: n,
			r,
			p,
			maxmem: MAXMEM
		});
	} catch {
		return false;
	}

	// Lengths are equal by construction above; timingSafeEqual still requires it.
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a stored hash uses weaker parameters than the current policy. */
export function needsRehash(stored: string): boolean {
	const parts = stored.split('$');
	if (parts.length !== 6 || parts[0] !== PREFIX) return true;
	return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}

/**
 * A one-time bootstrap password. Uses an unambiguous alphabet — no I/l/1/O/0 —
 * because this gets read off a terminal and typed by hand.
 */
export function generateBootstrapPassword(length = 24): string {
	const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
	const out: string[] = [];
	// Rejection sampling keeps the distribution uniform; a plain modulo would
	// bias toward the start of the alphabet.
	const limit = 256 - (256 % alphabet.length);
	while (out.length < length) {
		for (const byte of randomBytes(length)) {
			if (byte >= limit) continue;
			out.push(alphabet[byte % alphabet.length] as string);
			if (out.length === length) break;
		}
	}
	return out.join('');
}
