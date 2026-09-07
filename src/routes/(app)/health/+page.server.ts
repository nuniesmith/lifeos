import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	HEALTH_KINDS,
	createHealthTerm,
	healthFrequencies,
	healthTermCounts,
	householdToday,
	listHealthTerms,
	recentVitals,
	setHealthTermArchived,
	type HealthKind
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Health & Fitness.
 *
 * Two halves, matching what the source workspace actually keeps: the words
 * used to describe days, and how often each has come up. The frequency is the
 * reason a list beats free text — "# of Days" is a rollup on every symptom
 * there, and a count across months is what turns "I feel rough a lot" into
 * something a person can take to an appointment.
 *
 * The counts are the viewer's own by construction; see `health.ts`.
 */

/** A window long enough to show a pattern, short enough to still be current. */
const WINDOW_DAYS = 90;

const isKind = (value: unknown): value is HealthKind =>
	HEALTH_KINDS.includes(String(value) as HealthKind);

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);
	const from = addDays(today, -WINDOW_DAYS);

	const kindParam = url.searchParams.get('kind');
	const kind = isKind(kindParam) ? kindParam : null;

	const [terms, counts, frequencies, vitals] = await Promise.all([
		listHealthTerms(sql, viewer, { ...(kind ? { kind } : {}), limit: 300 }),
		healthTermCounts(sql, viewer),
		healthFrequencies(sql, viewer, {
			...(kind ? { kind } : {}),
			from,
			to: today,
			limit: 40
		}),
		recentVitals(sql, viewer, 14)
	]);

	return {
		today,
		windowDays: WINDOW_DAYS,
		kind,
		kinds: HEALTH_KINDS,
		terms,
		counts,
		frequencies,
		vitals
	};
};

/** Plain calendar arithmetic on a YYYY-MM-DD string, no timezone involved. */
function addDays(day: string, delta: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + delta);
	return d.toISOString().slice(0, 10);
}

export const actions: Actions = {
	addTerm: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createHealthTerm(sql, viewer, {
			kind: form.get('kind'),
			name: form.get('name')
		});

		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { added: result.record.id };
	},

	archiveTerm: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await setHealthTermArchived(
			sql,
			viewer,
			String(form.get('id') ?? ''),
			form.get('archived') === 'true'
		);
		if (!result.ok) return fail(400, { error: 'Could not archive that.' });
		return { archived: true };
	}
};
