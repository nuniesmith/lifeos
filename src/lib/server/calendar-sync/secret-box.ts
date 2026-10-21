import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for the one secret a person types into LifeOS: a CalDAV
 * password (for iCloud, an app-specific one). AES-256-GCM under the server's
 * LIFEOS_SECRET_KEY, so a database dump or backup alone never yields a
 * working credential; the key lives only in the server's environment.
 *
 * Layout: a version byte, the 12-byte IV, the 16-byte tag, the ciphertext.
 * The version byte is so a later key rotation can tell old boxes from new.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretKeyMissing extends Error {
	constructor() {
		super(
			'LIFEOS_SECRET_KEY is not set: generate one with `openssl rand -base64 32` and put it in the server .env'
		);
	}
}

/** The key from its base64 form, or null when the server has none. */
export function parseSecretKey(value: string | undefined): Buffer | null {
	if (!value) return null;
	const key = Buffer.from(value, 'base64');
	if (key.length !== 32) {
		throw new Error(
			'LIFEOS_SECRET_KEY must be 32 bytes, base64-encoded (`openssl rand -base64 32`)'
		);
	}
	return key;
}

export function seal(plaintext: string, key: Buffer | null): Buffer {
	if (!key) throw new SecretKeyMissing();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Opens a box; throws on a wrong key or any tampering (GCM's tag says so). */
export function open(box: Buffer, key: Buffer | null): string {
	if (!key) throw new SecretKeyMissing();
	if (box.length < 1 + IV_BYTES + TAG_BYTES || box[0] !== VERSION) {
		throw new Error('not a sealed secret');
	}
	const iv = box.subarray(1, 1 + IV_BYTES);
	const tag = box.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([
		decipher.update(box.subarray(1 + IV_BYTES + TAG_BYTES)),
		decipher.final()
	]).toString('utf8');
}
