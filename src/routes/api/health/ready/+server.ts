import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readiness } from '$lib/server/health';

/**
 * Readiness — the hard gate the deploy uses (OPS-011).
 *
 * Detail is withheld from unauthenticated callers because check messages can
 * carry host paths and driver errors. The deploy reaches this over loopback,
 * so it sees the full body; anything arriving via Nginx/Tailscale gets the
 * status only, unless it belongs to a signed-in user.
 */
export const GET: RequestHandler = async ({ getClientAddress, locals }) => {
	const result = await readiness();
	const status = result.status === 'fail' ? 503 : 200;

	const addr = getClientAddress();
	const isLoopback = addr === '127.0.0.1' || addr === '::1';
	const privileged = isLoopback || Boolean(locals.user);

	return json(privileged ? result : { status: result.status }, { status });
};
