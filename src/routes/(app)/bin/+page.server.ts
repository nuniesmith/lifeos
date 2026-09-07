import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Tasks Bin.
 *
 * There is only one recoverable-deletion mechanism here — `archived_at` — so a
 * separate bin would be a second name for the same rows and a second place to
 * look for them. The workspace's "Tasks Bin" is the archive filtered to tasks,
 * and that is what this is.
 */
export const load: PageServerLoad = () => {
	redirect(307, '/archive?kind=task');
};
