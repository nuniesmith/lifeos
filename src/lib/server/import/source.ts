import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { notionIdFromFilename } from './csv.ts';

/**
 * Reading the Notion export safely (IMP-001).
 *
 * Works against an extracted directory, which is the form the export actually
 * takes here. Every path is resolved and checked to stay inside the root, so a
 * symlink cannot walk the importer out of the export.
 */

export type SourceKind = 'csv_all' | 'csv_view' | 'html' | 'markdown' | 'media' | 'other';

export interface SourceFile {
	/** Path relative to the export root, always using forward slashes. */
	relativePath: string;
	absolutePath: string;
	kind: SourceKind;
	byteSize: number;
	/** The 32-hex Notion id in the filename, when present. */
	notionId: string | null;
}

export interface HashedSourceFile extends SourceFile {
	sha256: Buffer;
}

/** Refuse a single file larger than this; nothing legitimate here approaches it. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Refuse an export larger than this in total. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const MEDIA_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.svg',
	'.pdf',
	'.mp4',
	'.mov',
	'.heic'
]);

export function classify(relativePath: string): SourceKind {
	const lower = relativePath.toLowerCase();
	if (lower.endsWith('_all.csv')) return 'csv_all';
	if (lower.endsWith('.csv')) return 'csv_view';
	if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
	if (lower.endsWith('.md')) return 'markdown';
	const dot = lower.lastIndexOf('.');
	if (dot !== -1 && MEDIA_EXTENSIONS.has(lower.slice(dot))) return 'media';
	return 'other';
}

/**
 * Rejects a path that escapes the root. Checked on the *resolved* path, so
 * `..` segments and symlinked directories are both covered.
 */
function assertInside(root: string, candidate: string): void {
	const rel = relative(root, candidate);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
		throw new Error(`path escapes the export root: ${candidate}`);
	}
}

export interface InventoryOptions {
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

export interface Inventory {
	root: string;
	files: SourceFile[];
	totalBytes: number;
	/** Relative paths seen more than once, case-insensitively. */
	duplicatePaths: string[];
	counts: Record<SourceKind, number>;
}

/** Walks the export and reports what is in it, reading no file contents. */
export async function inventory(
	rootPath: string,
	options: InventoryOptions = {}
): Promise<Inventory> {
	const maxFile = options.maxFileBytes ?? MAX_FILE_BYTES;
	const maxTotal = options.maxTotalBytes ?? MAX_TOTAL_BYTES;

	const root = resolve(rootPath);
	const rootStat = await stat(root);
	if (!rootStat.isDirectory()) throw new Error(`not a directory: ${rootPath}`);

	const files: SourceFile[] = [];
	let totalBytes = 0;
	const seen = new Map<string, number>();

	async function walk(dir: string): Promise<void> {
		// withFileTypes avoids a stat per entry and, importantly, reports
		// symlinks as symlinks rather than following them.
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const absolute = join(dir, entry.name);
			assertInside(root, absolute);

			if (entry.isSymbolicLink()) continue; // never followed
			if (entry.isDirectory()) {
				await walk(absolute);
				continue;
			}
			if (!entry.isFile()) continue;

			const info = await stat(absolute);
			if (info.size > maxFile) {
				throw new Error(`file exceeds the size limit (${info.size} bytes): ${absolute}`);
			}
			totalBytes += info.size;
			if (totalBytes > maxTotal) throw new Error('export exceeds the total size limit');

			const relativePath = relative(root, absolute).split(sep).join('/');
			const key = relativePath.toLowerCase();
			seen.set(key, (seen.get(key) ?? 0) + 1);

			files.push({
				relativePath,
				absolutePath: absolute,
				kind: classify(relativePath),
				byteSize: info.size,
				notionId: notionIdFromFilename(entry.name)
			});
		}
	}

	await walk(root);

	files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

	const counts: Record<SourceKind, number> = {
		csv_all: 0,
		csv_view: 0,
		html: 0,
		markdown: 0,
		media: 0,
		other: 0
	};
	for (const f of files) counts[f.kind]++;

	return {
		root,
		files,
		totalBytes,
		duplicatePaths: [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p),
		counts
	};
}

/** Reads and hashes a file. Content-addressing is how media deduplicates. */
export async function hashFile(file: SourceFile): Promise<HashedSourceFile> {
	const bytes = await readFile(file.absolutePath);
	return { ...file, sha256: createHash('sha256').update(bytes).digest() };
}

/** Reads a text file, stripping any BOM at the parse layer, not here. */
export function readText(file: SourceFile): Promise<string> {
	return readFile(file.absolutePath, 'utf8');
}
