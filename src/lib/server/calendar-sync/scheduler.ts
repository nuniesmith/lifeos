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

let deps: Promise<SyncDeps> | null = null;

/** The server's sync configuration, read once. */
export function syncDeps(): Promise<SyncDeps> {
	deps ??= (async () => {
		const account = env.LIFEOS_GOOGLE_SA_FILE
			? await readServiceAccount(env.LIFEOS_GOOGLE_SA_FILE)
			: null;
		return {
			google: account ? new GoogleClient({ account }) : null,
			secretKey: parseSecretKey(env.LIFEOS_SECRET_KEY),
			zone: env.LIFEOS_TIMEZONE,
			origin: env.ORIGIN ?? null,
			currency: env.LIFEOS_CURRENCY
		};
	})();
	return deps;
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
