import { randomUUID } from 'node:crypto';
import { building } from '$app/environment';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { runBootstrap } from '$lib/server/auth/bootstrap';
import { sql } from '$lib/server/db';
import { resolveSession } from '$lib/server/auth/service';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { logger } from '$lib/server/logger';
import { ensureStorage } from '$lib/server/storage';

/**
 * First-run bootstrap, attempted once per process at startup.
 *
 * Deliberately not fatal. If the database is unreachable at boot, the process
 * must still come up and answer liveness — otherwise a database blip becomes a
 * container restart loop, which is the failure /api/health/live exists to
 * avoid. Readiness reports the real state, and the next start retries.
 */
const bootstrapped = building
	? Promise.resolve()
	: ensureStorage()
			// Storage first: readiness statfs's the upload directory, so an
			// install where it does not exist never becomes ready even though
			// nothing is actually wrong.
			.then(() => runBootstrap(sql))
			.catch((err) => {
				logger.error({ err }, 'first-run bootstrap did not complete; will retry on next start');
			});

/**
 * The single backend seam. Session resolution lands here in Phase 3; until
 * then `locals.user` is always null so route guards can already be written
 * against the real shape.
 */
export const handle: Handle = async ({ event, resolve }) => {
	// Ensures the first request never races the bootstrap transaction. After
	// the first await this is an already-settled promise.
	await bootstrapped;

	const requestId = randomUUID();
	event.locals.requestId = requestId;

	// Resolution never throws: an unreachable database yields an anonymous
	// request, which route guards then refuse. Failing closed.
	const resolved = await resolveSession(sql, event.cookies.get(SESSION_COOKIE));
	event.locals.user = resolved?.user ?? null;
	event.locals.sessionId = resolved?.sessionId ?? null;

	const started = performance.now();
	const response = await resolve(event);

	// Health checks are polled constantly; logging them buries real traffic.
	if (!event.url.pathname.startsWith('/api/health')) {
		logger.info(
			{
				requestId,
				method: event.request.method,
				path: event.url.pathname,
				status: response.status,
				ms: Math.round(performance.now() - started)
			},
			'request'
		);
	}

	response.headers.set('x-request-id', requestId);
	return response;
};

export const handleError: HandleServerError = ({ error, event }) => {
	const requestId = event.locals.requestId ?? 'unknown';
	logger.error({ err: error, requestId, path: event.url.pathname }, 'unhandled error');
	// The message is intentionally generic: internal errors can quote SQL and
	// file paths. The request id is the thread back to the log.
	return { message: 'Something went wrong.', requestId };
};
