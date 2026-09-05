import { describe, expect, it } from 'vitest';
import {
	imageDimensions,
	isPlausibleImage,
	sniffContentType,
	storageKeyFor
} from '$lib/server/import/media';

const png = (w: number, h: number) => {
	const b = Buffer.alloc(24);
	Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
	b.writeUInt32BE(w, 16);
	b.writeUInt32BE(h, 20);
	return b;
};

describe('content type detection', () => {
	it('identifies a PNG from its signature', () => {
		expect(sniffContentType(png(1, 1)).contentType).toBe('image/png');
	});

	it('identifies a JPEG, GIF, and PDF', () => {
		expect(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).contentType).toBe('image/jpeg');
		expect(sniffContentType(Buffer.from('GIF89a...')).contentType).toBe('image/gif');
		expect(sniffContentType(Buffer.from('%PDF-1.7')).contentType).toBe('application/pdf');
	});

	it('ignores the filename entirely', () => {
		// A file called photo.png containing a PDF is a PDF. The extension is
		// not evidence, and the content type decides how a browser treats it.
		expect(sniffContentType(Buffer.from('%PDF-1.7')).contentType).toBe('application/pdf');
	});

	it('falls back to a non-rendering type for anything unrecognised', () => {
		// Notably SVG: it is XML that can carry script and there is no
		// sanitiser here, so it must not be served as an image.
		const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
		expect(sniffContentType(svg).contentType).toBe('application/octet-stream');
	});

	it('does not crash on an empty or tiny buffer', () => {
		expect(sniffContentType(Buffer.alloc(0)).contentType).toBe('application/octet-stream');
		expect(sniffContentType(Buffer.from([0xff])).contentType).toBe('application/octet-stream');
	});
});

describe('storage keys', () => {
	it('shards by the first four hex characters', () => {
		const hash = Buffer.from('ab'.repeat(32), 'hex');
		expect(storageKeyFor(hash, 'png')).toBe(`ab/ab/${'ab'.repeat(32)}.png`);
	});

	it('gives identical content the identical key, which is the deduplication', () => {
		const a = Buffer.from('cd'.repeat(32), 'hex');
		const b = Buffer.from('cd'.repeat(32), 'hex');
		expect(storageKeyFor(a, 'png')).toBe(storageKeyFor(b, 'png'));
	});
});

describe('image dimensions', () => {
	it('reads PNG dimensions from the header', () => {
		expect(imageDimensions(png(1920, 1080), 'image/png')).toEqual({ width: 1920, height: 1080 });
	});

	it('reads GIF dimensions', () => {
		const b = Buffer.alloc(10);
		Buffer.from('GIF89a').copy(b, 0);
		b.writeUInt16LE(320, 6);
		b.writeUInt16LE(240, 8);
		expect(imageDimensions(b, 'image/gif')).toEqual({ width: 320, height: 240 });
	});

	it('returns null rather than throwing on a truncated file', () => {
		expect(imageDimensions(Buffer.from([0x89, 0x50]), 'image/png')).toBeNull();
		expect(imageDimensions(Buffer.alloc(0), 'image/jpeg')).toBeNull();
	});

	it('returns null for a type it cannot parse', () => {
		expect(imageDimensions(Buffer.from('%PDF-1.7'), 'application/pdf')).toBeNull();
	});
});

describe('dimension sanity', () => {
	it('accepts ordinary images and unknown dimensions', () => {
		expect(isPlausibleImage({ width: 4000, height: 3000 })).toBe(true);
		// Unknown is not the same as invalid; a PDF has no dimensions.
		expect(isPlausibleImage(null)).toBe(true);
	});

	it('rejects a decompression-bomb shape', () => {
		expect(isPlausibleImage({ width: 60000, height: 60000 })).toBe(false);
		expect(isPlausibleImage({ width: 0, height: 100 })).toBe(false);
	});
});
