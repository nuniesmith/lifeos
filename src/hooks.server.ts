import { randomUUID } from 'node:crypto';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { logger } from '$lib/server/logger';

/**
 * The single backend seam. Session resolution lands here in Phase 3; until
 * then `locals.user` is always null so route guards can already be written
 * against the real shape.
 */
export const handle: Handle = async ({ event, resolve }) => {
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
