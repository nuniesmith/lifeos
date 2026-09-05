/**
 * Media handling for the import (IMP-006).
 *
 * Content-addressed and immutable: a file's storage key is its SHA-256, so the
 * 525 image files in this export collapse to the 298 distinct ones without any
 * comparison beyond the hash. Re-importing writes nothing new.
 *
 * Content type is detected from the bytes, never from the filename. An
 * extension is attacker- and mistake-controlled, and the type decides how a
 * browser will treat the response.
 */

export interface SniffResult {
	contentType: string;
	extension: string;
}

const SIGNATURES: { type: string; ext: string; test: (b: Buffer) => boolean }[] = [
	{
		type: 'image/png',
		ext: 'png',
		test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
	},
	{
		type: 'image/jpeg',
		ext: 'jpg',
		test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
	},
	{
		type: 'image/gif',
		ext: 'gif',
		test: (b) => b.length > 6 && b.subarray(0, 6).toString('ascii').startsWith('GIF8')
	},
	{
		type: 'image/webp',
		ext: 'webp',
		test: (b) =>
			b.length > 12 &&
			b.subarray(0, 4).toString('ascii') === 'RIFF' &&
			b.subarray(8, 12).toString('ascii') === 'WEBP'
	},
	{
		type: 'application/pdf',
		ext: 'pdf',
		test: (b) => b.length > 5 && b.subarray(0, 5).toString('ascii') === '%PDF-'
	}
];

/**
 * Identifies a file from its leading bytes.
 *
 * SVG is deliberately absent. It is XML that can carry script, and this
 * importer has no sanitiser for it; an unrecognised file is stored as
 * `application/octet-stream` and served as a download rather than rendered.
 */
export function sniffContentType(bytes: Buffer): SniffResult {
	for (const signature of SIGNATURES) {
		if (signature.test(bytes)) return { contentType: signature.type, extension: signature.ext };
	}
	return { contentType: 'application/octet-stream', extension: 'bin' };
}

/**
 * Storage key for a hash: two levels of two hex characters, then the rest.
 *
 * The sharding matters on ext4 — a single directory holding every upload
 * degrades badly, and this export alone contributes 298 files before the
 * household adds any of its own.
 */
export function storageKeyFor(sha256: Buffer, extension: string): string {
	const hex = sha256.toString('hex');
	return `${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}.${extension}`;
}

/** Reads PNG dimensions from the IHDR chunk. */
function pngDimensions(b: Buffer): { width: number; height: number } | null {
	if (b.length < 24) return null;
	return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Reads JPEG dimensions by walking the segment markers. */
function jpegDimensions(b: Buffer): { width: number; height: number } | null {
	let offset = 2;
	while (offset + 9 < b.length) {
		if (b[offset] !== 0xff) return null;
		const marker = b[offset + 1]!;
		const length = b.readUInt16BE(offset + 2);
		// SOF0..SOF15, excluding the DHT/DAC/DNL markers that share the range.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
		}
		offset += 2 + length;
	}
	return null;
}

function gifDimensions(b: Buffer): { width: number; height: number } | null {
	if (b.length < 10) return null;
	return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

/**
 * Image dimensions, or null when they cannot be read.
 *
 * Parsed directly rather than through an image library: this runs over 525
 * files during an import on a 1 GB host, and decoding each one to learn its
 * size would cost far more than reading a header.
 */
export function imageDimensions(
	bytes: Buffer,
	contentType: string
): { width: number; height: number } | null {
	try {
		if (contentType === 'image/png') return pngDimensions(bytes);
		if (contentType === 'image/jpeg') return jpegDimensions(bytes);
		if (contentType === 'image/gif') return gifDimensions(bytes);
	} catch {
		// A truncated or malformed file must not abort the import.
		return null;
	}
	return null;
}

/** Largest image accepted, in pixels per side. */
export const MAX_IMAGE_DIMENSION = 20_000;

export function isPlausibleImage(dimensions: { width: number; height: number } | null): boolean {
	if (!dimensions) return true; // unknown is not the same as invalid
	const { width, height } = dimensions;
	return width > 0 && height > 0 && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION;
}
