/**
 * How a project or goal status is spoken and coloured (UI-005, UI-006).
 *
 * All three planning surfaces list each other — a goal shows its projects, an
 * area shows both — so the labels live in one module rather than being written
 * out per page and drifting into "On hold" here and "on_hold" there.
 *
 * Nothing server-side may be imported here: `.svelte` files use these maps, and
 * a value imported from `$lib/server` in client code fails the build. The
 * status *types* are imported as types only, which erase before bundling and
 * still make the maps exhaustive — add a status to the repository and
 * `npm run check` fails here until it has been given a label and a tone.
 */
import type { GoalStatus, ProjectStatus } from '$lib/server/repositories';
import type { AreaReview } from './planning';

/** The Badge tones, which are semantic names rather than colours. */
export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'crit';

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
	planned: 'Planned',
	active: 'Active',
	on_hold: 'On hold',
	done: 'Done',
	dropped: 'Dropped'
};

export const PROJECT_STATUS_TONES: Record<ProjectStatus, Tone> = {
	planned: 'neutral',
	active: 'accent',
	on_hold: 'warn',
	done: 'ok',
	dropped: 'neutral'
};

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
	// Declared in the order a goal moves through them, because `optionsOf`
	// turns this object straight into the select.
	someday: 'Someday',
	planned: 'Planned',
	active: 'Active',
	paused: 'Paused',
	achieved: 'Achieved',
	dropped: 'Dropped'
};

export const GOAL_STATUS_TONES: Record<GoalStatus, Tone> = {
	// Neither of the not-yet-started states is a warning: choosing to do
	// something later is a decision, not a problem.
	someday: 'neutral',
	planned: 'neutral',
	active: 'accent',
	paused: 'warn',
	achieved: 'ok',
	dropped: 'neutral'
};

/** `{ value, label }` pairs for a `<Select>`, in the order declared above. */
export const optionsOf = (labels: Record<string, string>): { value: string; label: string }[] =>
	Object.entries(labels).map(([value, label]) => ({ value, label }));

/**
 * An area's review cadence, said the way it would be said out loud.
 *
 * Derived on the server from `review_every_days` and `last_reviewed_on`; these
 * two only phrase it, so the list and the detail page cannot describe the same
 * area differently.
 */
export function reviewLabel(review: AreaReview): string {
	switch (review.state) {
		case 'unscheduled':
			return 'No review cadence';
		case 'never':
			return `Never reviewed · every ${review.everyDays} days`;
		case 'due':
			if (review.dueInDays === 0) return 'Review due today';
			return `Review overdue by ${Math.abs(review.dueInDays ?? 0)} days`;
		case 'scheduled':
		default:
			return review.dueInDays === 1 ? 'Review due tomorrow' : `Review in ${review.dueInDays} days`;
	}
}

export function reviewTone(review: AreaReview): Tone {
	if (review.state === 'due' || review.state === 'never') return 'warn';
	if (review.state === 'unscheduled') return 'neutral';
	return 'ok';
}

/** A date as a person reads it, or an empty string when there is none. */
export function readableDay(day: string | null, today: string): string {
	if (!day) return '';
	if (day === today) return 'today';
	const delta = Math.round(
		(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
	);
	if (delta === 1) return 'tomorrow';
	if (delta === -1) return 'yesterday';
	if (delta < 0) return `${Math.abs(delta)} days ago`;
	if (delta < 14) return `in ${delta} days`;
	return day;
}
