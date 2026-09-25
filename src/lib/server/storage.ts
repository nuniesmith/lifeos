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
	// The upload directory always, because the application writes to it. The
	// import and backup directories only when an operator has configured them:
	// an operator dropping an export in should not have to create the import
	// directory first, and one who sets the backup directory expects it to
	// exist.
	//
	// Neither is consumed by the running application. `scripts/import.mjs` is a
	// CLI with its own default root, and `scripts/backup.sh` runs on the host and
	// writes to $LIFEOS_STATE_DIR/backups; readiness reads the `backup_runs`
	// table, not a directory. They used to default to `./var/...`, which the
	// production image can never create (/app is root-owned and the process runs
	// as node), so every production start logged two EACCES warnings about
	// directories nothing would ever read.
	const directories = [env.LIFEOS_UPLOAD_DIR, env.LIFEOS_IMPORT_DIR, env.LIFEOS_BACKUP_DIR].filter(
		(dir): dir is string => Boolean(dir)
	);

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
