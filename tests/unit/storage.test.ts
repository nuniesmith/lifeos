import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// env.ts validates process.env when it is first imported, so the storage
// module is given a stand-in it can read instead. The logger is replaced so a
// warning is an observable call rather than a line in the test output.
const { env, warn } = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	warn: vi.fn()
}));
vi.mock('$lib/server/env', () => ({ env }));
vi.mock('$lib/server/logger', () => ({ logger: { warn } }));

import { ensureStorage } from '$lib/server/storage';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'lifeos-storage-'));
	for (const key of Object.keys(env)) delete env[key];
	warn.mockClear();
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const isDirectory = async (path: string) => (await stat(path)).isDirectory();

describe('ensureStorage', () => {
	// Production sets only the upload directory. The import and backup
	// directories used to default to ./var/..., which the production image
	// cannot create, and every start logged EACCES for both.
	it('touches only the upload directory when import and backup are not configured', async () => {
		env.LIFEOS_UPLOAD_DIR = join(root, 'uploads');

		await ensureStorage();

		expect(await isDirectory(join(root, 'uploads'))).toBe(true);
		expect(await readdir(root)).toEqual(['uploads']);
		expect(warn).not.toHaveBeenCalled();
	});

	it('creates every directory an operator configures', async () => {
		env.LIFEOS_UPLOAD_DIR = join(root, 'uploads');
		env.LIFEOS_IMPORT_DIR = join(root, 'imports');
		env.LIFEOS_BACKUP_DIR = join(root, 'backups');

		await ensureStorage();

		expect((await readdir(root)).sort()).toEqual(['backups', 'imports', 'uploads']);
		expect(warn).not.toHaveBeenCalled();
	});

	it('reports a directory it cannot create instead of throwing', async () => {
		// A path beneath a regular file can never become a directory.
		await writeFile(join(root, 'not-a-dir'), '');
		env.LIFEOS_UPLOAD_DIR = join(root, 'uploads');
		env.LIFEOS_IMPORT_DIR = join(root, 'not-a-dir', 'imports');

		await expect(ensureStorage()).resolves.toBeUndefined();

		expect(await isDirectory(join(root, 'uploads'))).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ dir: join(root, 'not-a-dir', 'imports') }),
			expect.any(String)
		);
	});
});
