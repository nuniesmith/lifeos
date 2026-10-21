import { env } from '../env';
import { logger } from '../logger';
import type { Sql } from 'postgres';
import { GoogleClient, readServiceAccount } from './google';
import { parseSecretKey } from './secret-box';
import { syncAll, type SyncDeps, type SyncReport } from './sync';

/**
 * The calendar sync timer, started once by hooks.server.ts.
 *
 * One pass at a time across every process: a Postgres advisory lock, held on
 * a reserved connection for the pass, so two app containers (or a pass that
 * overruns the interval) never sync the same calendars at once. A pass that
 * can't get the lock skips its turn.
 */

const LOCK_KEY = 4_197_031; // arbitrary, LifeOS's own: 'calendar sync'

/**
 * Server settings sync can't use, by variable, in words the Calendars page
 * shows after "Google can't be used:" or "iCloud can't be connected:".
 */
export interface ConfigProblems {
	LIFEOS_GOOGLE_SA_FILE?: string;
	LIFEOS_SECRET_KEY?: string;
}

export interface SyncConfig extends SyncDeps {
	problems: ConfigProblems;
}

let config: Promise<SyncConfig> | null = null;
let reported = '';

/**
 * The server's sync configuration. A setting it can't use, such as a key file
 * the app may not read or a key of the wrong length, is left off and reported,
 * never thrown: one bad file used to fail the Calendars page until a restart.
 * Only a usable configuration is kept, so a fixed file counts on the next call.
 */
export function syncDeps(): Promise<SyncConfig> {
	config ??= readConfig().then((read) => {
		const problems = Object.entries(read.problems)
			.map(([setting, problem]) => `${setting}: ${problem}`)
			.join('; ');
		if (problems && problems !== reported) {
			logger.warn({ problems: read.problems }, 'calendar sync settings unusable');
		}
		reported = problems;
		if (problems) config = null;
		return read;
	});
	return config;
}

async function readConfig(): Promise<SyncConfig> {
	const problems: ConfigProblems = {};
	let google: GoogleClient | null = null;
	const file = env.LIFEOS_GOOGLE_SA_FILE;
	if (file) {
		try {
			google = new GoogleClient({ account: await readServiceAccount(file) });
		} catch (err) {
			problems.LIFEOS_GOOGLE_SA_FILE = unusableFile(file, err);
		}
	}
	let secretKey: Buffer | null = null;
	try {
		secretKey = parseSecretKey(env.LIFEOS_SECRET_KEY);
	} catch (err) {
		problems.LIFEOS_SECRET_KEY = err instanceof Error ? err.message : String(err);
	}
	return {
		google,
		secretKey,
		zone: env.LIFEOS_TIMEZONE,
		origin: env.ORIGIN ?? null,
		currency: env.LIFEOS_CURRENCY,
		problems
	};
}

function unusableFile(file: string, err: unknown): string {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	if (code === 'ENOENT') return `there is no file at ${file}`;
	if (code === 'EACCES') return `the app (uid ${process.getuid?.()}) isn't allowed to read ${file}`;
	if (code === 'EISDIR') return `${file} is a directory, not the key file`;
	if (err instanceof SyntaxError) return `${file} isn't JSON`;
	return err instanceof Error ? err.message : String(err);
}

/** Runs one pass if no other is running; null when it skipped its turn. */
export async function syncOnce(sql: Sql): Promise<SyncReport | null> {
	// Advisory locks belong to a session, so lock and unlock on one connection.
	const reserved = await sql.reserve();
	try {
		const [lock] = await reserved<
			{ ok: boolean }[]
		>`select pg_try_advisory_lock(${LOCK_KEY}) as ok`;
		if (!lock?.ok) return null;
		try {
			return await syncAll(sql, await syncDeps());
		} finally {
			await reserved`select pg_advisory_unlock(${LOCK_KEY})`;
		}
	} finally {
		reserved.release();
	}
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startCalendarSync(sql: Sql): void {
	const minutes = env.LIFEOS_CALENDAR_SYNC_MINUTES;
	if (timer || minutes === 0) return;
	const tick = () =>
		syncOnce(sql)
			.then((report) => {
				if (
					report &&
					(report.failures ||
						report.pushed.created ||
						report.pushed.updated ||
						report.pushed.deleted)
				) {
					logger.info({ report }, 'calendar sync pass');
				}
			})
			.catch((err) => logger.error({ err }, 'calendar sync pass failed'));
	timer = setInterval(tick, minutes * 60_000);
	// Don't keep a stopping process alive for the next pass.
	timer.unref?.();
	setTimeout(tick, 30_000).unref?.();
}
