import { error } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { addMonths, financeByMonth, householdToday, isMonth } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * Money by month (PACK4-002): a year of months at a time, newest first.
 *
 * `?to=YYYY-MM` picks the newest month shown; without it the year ends with
 * this month. A month after this one is a 404 rather than a page of zeros, so
 * a mistyped year cannot look like a quiet one.
 */

/** How many months one page shows. */
const SPAN = 12;

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const thisMonth = (await householdToday(sql, viewer.householdId)).slice(0, 7);

	const requested = url.searchParams.get('to');
	if (requested !== null && (!isMonth(requested) || requested > thisMonth)) {
		error(404, 'Not a month');
	}
	const to = requested ?? thisMonth;
	const from = addMonths(to, -(SPAN - 1));

	const report = await financeByMonth(sql, viewer, from, to);
	return {
		thisMonth,
		currency: report.currency,
		months: report.months,
		earlier: addMonths(from, -1),
		// Never past this month: a year on from an old page stops at today.
		later: to < thisMonth ? [addMonths(to, SPAN), thisMonth].sort()[0]! : null
	};
};
