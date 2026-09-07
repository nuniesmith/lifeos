import { sql } from '$lib/server/db';
import { householdToday, listBills, monthlyCommitment } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * Financial Hub.
 *
 * Only what the export actually carries: the recurring commitments. The Income
 * database in the source has no populated columns of its own — it is a pair of
 * rollup formulas — so there is nothing here to show yet rather than an empty
 * table pretending otherwise.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const [bills, commitment] = await Promise.all([
		listBills(sql, viewer, { status: ['active', 'free_trial'], limit: 200 }),
		monthlyCommitment(sql, viewer)
	]);

	return { today, bills, commitment };
};
