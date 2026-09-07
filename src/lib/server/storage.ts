import { mkdir } from 'node:fs/promises';
import { env } from './env';
import { logger } from './logger';

/**
 * Creates the directories the application owns, once per process at startup.
 *
 * Readiness `statfs`s the upload directory for both the storage and the disk
 * check, so an install where it does not exist reports 503 and never becomes
 * ready — which is what happened in CI: nothing was wrong except that a
 * directory nobody had created was missing, and a fresh clone could not pass
 * its own health check.
 *
 * Making it the application's job rather than the operator's is the fix,
 * because it is the application's directory: it writes attachments there and
 * cannot work without it.
 *
 * Deliberately not fatal, matching the first-run bootstrap. A read-only mount
 * is a real deployment problem, but the process must still come up and answer
 * liveness so the operator can reach the logs; readiness then reports the
 * genuine state rather than the container restarting in a loop.
 */
export async function ensureStorage(): Promise<void> {
	// The import directory is included so an operator dropping an export in does
	// not have to create it first; `scripts/import.mjs` reads it as the default
	// root.
	//
	// The backup directory is NOT where backups land, despite what this comment
	// used to claim. `scripts/backup.sh` runs on the host and writes to
	// $LIFEOS_STATE_DIR/backups, and the readiness check reads the `backup_runs`
	// table rather than any directory — so nothing consumes this path. It is
	// created because the variable is declared and an operator who sets it
	// expects the directory to exist; if it is ever wired to something, the
	// wiring is the change, not this line.
	const directories = [env.LIFEOS_UPLOAD_DIR, env.LIFEOS_IMPORT_DIR, env.LIFEOS_BACKUP_DIR];

	await Promise.all(
		directories.map(async (dir) => {
			try {
				await mkdir(dir, { recursive: true });
			} catch (err) {
				logger.warn({ err, dir }, 'could not create a storage directory');
			}
		})
	);
}
