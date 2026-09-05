import { recentAudit } from '$lib/server/auth/admin';
import { requireAdmin } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals.user);
	return { entries: await recentAudit(sql, 200) };
};
