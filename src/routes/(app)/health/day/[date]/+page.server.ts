import { error } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	addDays,
	healthDay,
	householdToday,
	isDay,
	rangeStatus,
	type HealthKind
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import { summaryOf } from '../../measurements/format';
import type { PageServerLoad } from './$types';

/**
 * One day of health as a timeline (PACK3-001).
 *
 * Everything with a time runs in clock order; what has only a date — a lab
 * result, a dose the import brought in — is under "All day". The journal's
 * health words, mood and energy follow, as the viewer's own day.
 */

export interface TimelineEntry {
	key: string;
	/** HH:MM, or null for the "All day" group. */
	time: string | null;
	kind: 'reading' | 'dose' | 'visit' | 'lab';
	title: string;
	detail: string;
	/** Off the reference range, for a lab result. */
	flag: 'high' | 'low' | null;
	href: string | null;
}

const SLOT_LABELS = { am: 'Morning', pm: 'Evening', adhoc: 'As needed' } as const;

const KIND_LABELS: Partial<Record<HealthKind, string>> = {
	symptom: 'Symptoms',
	activity: 'Activity',
	exercise: 'Exercise'
};

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);
	if (!isDay(params.date)) error(404, 'Not a date');
	const date = params.date;
	const today = await householdToday(sql, viewer.householdId);
	const day = await healthDay(sql, viewer, date);

	const entries: TimelineEntry[] = [
		...day.measurements.map((m) => ({
			key: `reading-${m.id}`,
			time: m.time,
			kind: 'reading' as const,
			title: summaryOf(m),
			detail: m.notes ?? '',
			flag: null,
			href: '/health/measurements'
		})),
		...day.doses.map((d) => ({
			key: `dose-${d.medicationId}-${d.slot}`,
			time: d.time,
			kind: 'dose' as const,
			title: d.medicationName,
			detail: [d.dose, SLOT_LABELS[d.slot], d.note].filter(Boolean).join(' · '),
			flag: null,
			href: '/health/medications'
		})),
		...day.visits.map((v) => ({
			key: `visit-${v.id}`,
			time: v.time,
			kind: 'visit' as const,
			title: v.reason,
			detail: [v.visitType, v.provider].filter(Boolean).join(' · '),
			flag: null,
			href: `/health/visits/${v.id}`
		})),
		...day.labResults.map((r) => {
			const status = rangeStatus(r.value, r.referenceLow, r.referenceHigh);
			return {
				key: `lab-${r.id}`,
				time: null,
				kind: 'lab' as const,
				title: r.markerName,
				detail: [r.value, r.units].filter((p) => p !== null).join(' '),
				flag: status === 'high' || status === 'low' ? status : null,
				href: `/health/labs/${r.markerId}`
			};
		})
	];

	// Timed entries by the clock; the rest keep the order they came in.
	const timed = entries
		.filter((e) => e.time !== null)
		.sort((a, b) => a.time!.localeCompare(b.time!));
	const allDay = entries.filter((e) => e.time === null);

	const words = Object.entries(KIND_LABELS)
		.map(([kind, label]) => ({
			label,
			names: day.words
				.filter((w) => w.kind === kind)
				.map((w) => (w.detail ? `${w.name} (${w.detail})` : w.name))
		}))
		.filter((group) => group.names.length > 0);

	return {
		date,
		today,
		timed,
		allDay,
		journal: { mood: day.mood, energyLevel: day.energyLevel, words },
		previous: addDays(date, -1),
		next: date < today ? addDays(date, 1) : null
	};
};
