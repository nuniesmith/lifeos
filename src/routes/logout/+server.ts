import { redirect } from '@sveltejs/kit';
import { revokeSession } from '$lib/server/auth/service';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { sql } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * POST-only. A GET logout would let any page or prefetch sign the user out.
 */
export const POST: RequestHandler = async ({ cookies, locals }) => {
	if (locals.sessionId) {
		await revokeSession(sql, locals.sessionId, 'user_logout');
	}
	// Cleared regardless, so a stale or already-revoked cookie cannot linger.
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/login');
};
