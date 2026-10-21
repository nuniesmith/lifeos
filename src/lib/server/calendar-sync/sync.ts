import type { Viewer } from '../auth/authz';
import { logger } from '../logger';
import { householdToday, type Queryable } from '../repositories/base';
import {
	connectionsForSync,
	deleteEvents,
	forgetPush,
	pushesOf,
	recordConnectionResult,
	recordPush,
	recordSourceResult,
	replaceObject,
	upsertEvents,
	wipeSource,
	type CalendarSource,
	type ConnectionForSync
} from '../repositories/calendar-sync';
import { syncCalendar, type CaldavCredentials } from './caldav';
import { GoogleClient, GoogleError, SyncTokenExpired, fromGoogleEvent } from './google';
import { desiredEvents } from './outbound';
import { open } from './secret-box';

/**
 * One pass of calendar sync: read every enabled calendar, then write each
 * household's push target.
 *
 * Errors stay where they happen. A calendar that fails records its error and
 * the rest carry on; a connection whose sign-in fails records it once.
 * Nothing here throws to the caller, because the caller is a timer, and a
 * timer that stops on the first bad password stops syncing everyone.
 */

export interface SyncDeps {
	google: GoogleClient | null;
	secretKey: Buffer | null;
	zone: string;
	origin: string | null;
	currency: string;
}

export interface SyncReport {
	sources: number;
	failures: number;
	pushed: { created: number; updated: number; deleted: number };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function pullGoogle(
	sql: Queryable,
	google: GoogleClient,
	source: CalendarSource
): Promise<void> {
	let token = source.syncToken;
	let result;
	try {
		result = await google.listEvents(source.externalId, token);
	} catch (err) {
		if (!(err instanceof SyncTokenExpired)) throw err;
		// Too old to continue from: start over, as Google asks.
		await wipeSource(sql, source.id);
		token = null;
		result = await google.listEvents(source.externalId, null);
	}
	const upserts = [];
	const deletes: string[] = [];
	for (const item of result.events) {
		const row = fromGoogleEvent(item, source.timeZone);
		if (row) upserts.push(row);
		else deletes.push(item.id);
	}
	await deleteEvents(sql, source.id, deletes);
	await upsertEvents(sql, source.id, upserts);
	await recordSourceResult(sql, source.id, { syncToken: result.nextSyncToken, error: null });
}

async function pullCaldav(
	sql: Queryable,
	credentials: CaldavCredentials,
	source: CalendarSource
): Promise<void> {
	const changes = await syncCalendar(credentials, source.externalId, source.syncToken);
	if (changes.full) await wipeSource(sql, source.id);
	await deleteEvents(sql, source.id, changes.deleted);
	for (const object of changes.changed)
		await replaceObject(sql, source.id, object.url, object.events);
	await recordSourceResult(sql, source.id, { syncToken: changes.syncToken, error: null });
}

/** Writes the target calendar to match LifeOS: creates, updates and deletes only what changed. */
export async function pushToTarget(
	sql: Queryable,
	deps: SyncDeps,
	target: { source: CalendarSource; owner: Viewer }
): Promise<SyncReport['pushed']> {
	const counts = { created: 0, updated: 0, deleted: 0 };
	if (!deps.google) return counts;
	const calendarId = target.source.externalId;
	const today = await householdToday(sql, target.owner.householdId);
	const desired = await desiredEvents(sql, target.owner, {
		today,
		zone: deps.zone,
		origin: deps.origin,
		currency: deps.currency
	});
	const pushed = await pushesOf(sql, target.source.id);

	for (const [key, want] of desired) {
		const have = pushed.get(key);
		if (have && have.contentHash === want.hash) continue;
		let externalId: string | null = null;
		if (have) {
			try {
				externalId = (await deps.google.updateEvent(calendarId, have.externalId, want.body)).id;
				counts.updated++;
			} catch (err) {
				// Deleted by hand in Google: put it back.
				if (!(err instanceof GoogleError && (err.status === 404 || err.status === 410))) throw err;
			}
		}
		if (!externalId) {
			externalId = (await deps.google.insertEvent(calendarId, want.body)).id;
			counts.created++;
		}
		await recordPush(sql, target.source.id, { lifeosKey: key, externalId, contentHash: want.hash });
	}
	for (const [key, have] of pushed) {
		if (desired.has(key)) continue;
		await deps.google.deleteEvent(calendarId, have.externalId);
		await forgetPush(sql, target.source.id, key);
		counts.deleted++;
	}
	return counts;
}

function credentialsOf(connection: ConnectionForSync, key: Buffer | null): CaldavCredentials {
	if (!connection.secret || !connection.serverUrl) throw new Error('no stored password');
	return {
		serverUrl: connection.serverUrl,
		username: connection.account,
		password: open(connection.secret, key)
	};
}

export async function syncAll(sql: Queryable, deps: SyncDeps): Promise<SyncReport> {
	const report: SyncReport = {
		sources: 0,
		failures: 0,
		pushed: { created: 0, updated: 0, deleted: 0 }
	};
	const connections = await connectionsForSync(sql);

	for (const connection of connections) {
		let credentials: CaldavCredentials | null = null;
		if (connection.provider === 'caldav') {
			try {
				credentials = credentialsOf(connection, deps.secretKey);
			} catch (err) {
				report.failures++;
				await recordConnectionResult(
					sql,
					connection.id,
					`can't read the stored password: ${message(err)}`
				);
				continue;
			}
		} else if (!deps.google) {
			report.failures++;
			await recordConnectionResult(
				sql,
				connection.id,
				'Google is not configured on the server (LIFEOS_GOOGLE_SA_FILE)'
			);
			continue;
		}
		let failed = false;
		for (const source of connection.sources) {
			if (!source.importEnabled && !source.isPushTarget) continue;
			report.sources++;
			try {
				if (connection.provider === 'google') await pullGoogle(sql, deps.google!, source);
				else await pullCaldav(sql, credentials!, source);
			} catch (err) {
				failed = true;
				report.failures++;
				await recordSourceResult(sql, source.id, { error: message(err) });
				logger.warn({ err, sourceId: source.id }, 'calendar sync: a calendar failed');
			}
		}
		await recordConnectionResult(
			sql,
			connection.id,
			failed ? 'a calendar failed to sync; see it below' : null
		);
	}

	for (const connection of connections) {
		const target = connection.sources.find((s) => s.isPushTarget);
		if (!target || connection.provider !== 'google') continue;
		try {
			const counts = await pushToTarget(sql, deps, {
				source: target,
				owner: {
					userId: connection.ownerUserId,
					householdId: connection.householdId,
					role: 'member'
				}
			});
			report.pushed.created += counts.created;
			report.pushed.updated += counts.updated;
			report.pushed.deleted += counts.deleted;
		} catch (err) {
			report.failures++;
			await recordSourceResult(sql, target.id, {
				error: `pushing LifeOS items failed: ${message(err)}`
			});
			logger.warn({ err, sourceId: target.id }, 'calendar sync: pushing failed');
		}
	}
	return report;
}
