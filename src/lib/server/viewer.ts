import { error } from '@sveltejs/kit';
import { requireUser, viewerOf, type Viewer } from './auth/authz';
import { sql } from './db';
import type { AuthUser } from './auth/service';

/**
 * Resolves the signed-in user to a {@link Viewer} — the household-scoped
 * identity every repository call takes.
 *
 * Every route needs this, and every route getting it slightly differently is
 * how one of them ends up querying without a household scope. It lives here so
 * there is one way to do it.
 *
 * A household is not optional: the repositories scope every read and write by
 * `household_id`, so a user without one would silently see nothing rather than
 * fail. That is treated as a broken account, not an empty result.
 */
export async function requireViewer(user: AuthUser | null): Promise<Viewer> {
	const authenticated = requireUser(user);

	const rows = await sql<{ household_id: string }[]>`
		select household_id from household_members
		where user_id = ${authenticated.id}
		order by joined_at
		limit 1
	`;

	const householdId = rows[0]?.household_id;
	if (!householdId) {
		error(500, 'This account is not attached to a household.');
	}

	return viewerOf(authenticated, householdId);
}
