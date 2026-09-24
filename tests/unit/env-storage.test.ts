import { describe, expect, it, vi } from 'vitest';

// The real env module, parsed the way production parses it: nothing sets the
// import or backup directory. It validates on first import, so the one value
// it insists on is supplied before the (hoisted) import runs.
vi.hoisted(() => {
	process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
	delete process.env.LIFEOS_IMPORT_DIR;
	delete process.env.LIFEOS_BACKUP_DIR;
});

import { env } from '$lib/server/env';

describe('storage directory configuration', () => {
	// A default here is what made every production start log EACCES: the
	// storage bootstrap tried to create ./var/imports and ./var/backups inside
	// an image whose /app is root-owned. Unset must stay unset.
	it('gives the import and backup directories no default', () => {
		expect(env.LIFEOS_IMPORT_DIR).toBeUndefined();
		expect(env.LIFEOS_BACKUP_DIR).toBeUndefined();
	});

	it('still defaults the upload directory, which the application writes to', () => {
		expect(env.LIFEOS_UPLOAD_DIR).toBeTruthy();
	});
});
