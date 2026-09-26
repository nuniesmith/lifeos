import { sql } from '$lib/server/db';
import {
	addDays,
	healthFrequencies,
	healthOverview,
	householdToday,
	recentVitals
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/** Same window the symptoms & mood page itself uses for "how often". */
const PATTERN_WINDOW_DAYS = 90;

/**
 * The Health hub: one card per section (UI follow-up to MODEL-002).
 *
 * Four sections — medications, measurements, labs, visits — and the original
 * health vocabulary each got their own page as its own change; nothing linked
 * them together and none of the four was reachable except by typing its URL.
 * This page is the fix: `healthOverview` does the cross-cutting reads, this
 * loader adds nothing of its own beyond `today`, and every action a card
 * needs (the medication toggle) posts straight to the page that already owns
 * it — see the medications card's form, which posts to
 * `/health/medications?/toggleDose` rather than a copy of `toggleDose` kept
 * here.
 *
 * The daily vitals table from the old `/health` page (blood pressure, heart
 * rate, sleep, water — the last two still living on `daily_logs`, never
 * migrated) stays here rather than moving to `/health/measurements` or
 * `/health/symptoms`: it already merges two tables into one view, which is
 * closer to "the whole picture" than to either single-purpose page.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const [health, vitals, topSymptoms] = await Promise.all([
		healthOverview(sql, viewer, today),
		recentVitals(sql, viewer, 14),
		// A light teaser for the "Symptoms & mood" card, which otherwise moved
		// wholesale to its own page; the full filterable list and the "add a
		// word" form stay there rather than being duplicated here.
		healthFrequencies(sql, viewer, {
			from: addDays(today, -PATTERN_WINDOW_DAYS),
			to: today,
			limit: 3
		})
	]);

	return { today, health, vitals, topSymptoms };
};
