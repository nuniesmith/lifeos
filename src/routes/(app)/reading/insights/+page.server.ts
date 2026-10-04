import { sql } from '$lib/server/db';
import { householdToday, insightYears, readingInsights } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * Reading Insights (Reading Tracker R3): the viewer's own year of reading,
 * computed fresh from `book_reads` every time (reading-challenges.ts's own
 * header) rather than a stored summary, with a year picker over every year
 * that has at least one finished read.
 *
 * The requested year is read from the query string so a shared or reloaded
 * link reproduces the same view, the same reason `/reading/tbr`'s filters
 * travel the same way (that page's own comment). It is not validated against
 * `years` -- an arbitrary year the viewer typed in still resolves to a
 * (probably all-zero) year of insights rather than a 404, because there is
 * nothing unsafe about asking "how did 1850 go".
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);

	const [years, today] = await Promise.all([
		insightYears(sql, viewer),
		householdToday(sql, viewer.householdId)
	]);
	const currentYear = Number(today.slice(0, 4));

	const requested = Number(url.searchParams.get('year'));
	const year =
		Number.isInteger(requested) && requested >= 1900 && requested <= 2200
			? requested
			: (years[0] ?? currentYear);

	const insights = await readingInsights(sql, viewer, year);

	return { insights, years, year, currentYear };
};
