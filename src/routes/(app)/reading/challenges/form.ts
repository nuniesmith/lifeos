import type { Option } from '$lib/components';
import type { ChallengeKind } from '$lib/server/repositories';

/**
 * Shared between the challenges list (the quick-add form) and a challenge's
 * own detail page (the fuller edit form) — the same split `/reading/books`'s
 * `form.ts` makes between its catalogue-wide field set and its own labels.
 */

export const KIND_LABELS: Record<ChallengeKind, string> = {
	count: 'Count',
	prompts: 'Prompts'
};

export const KIND_OPTIONS: readonly Option[] = [
	{ value: 'count', label: 'Count — "read N books"' },
	{ value: 'prompts', label: 'Prompts — a sheet to fill' }
];

/** "12 of 30", "8 of 20 prompts" — the brief's own two examples, verbatim. */
export function progressLabel(
	kind: ChallengeKind,
	progress: { done: number; total: number }
): string {
	return kind === 'count'
		? `${progress.done} of ${progress.total}`
		: `${progress.done} of ${progress.total} prompts`;
}

export function progressPercent(progress: { done: number; total: number }): number {
	if (progress.total <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)));
}
