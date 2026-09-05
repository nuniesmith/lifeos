import { randomUUID } from 'node:crypto';
import { building } from '$app/environment';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { runBootstrap } from '$lib/server/auth/bootstrap';
import { sql } from '$lib/server/db';
import { logger } from '$lib/server/logger';

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
	: runBootstrap(sql).catch((err) => {
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
	event.locals.user = null;

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
