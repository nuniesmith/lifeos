import { error, fail, redirect } from '@sveltejs/kit';
import { renderMarkdown } from '$lib/server/markdown';
import {
	STEP_VERSIONS,
	addStep,
	completeStep,
	getRoutineWithSteps,
	householdToday,
	listHabits,
	moveStep,
	resolveStepVersion,
	setRoutineArchived,
	setStepArchived,
	stepCompletionsOn,
	uncompleteStep,
	updateRoutine,
	updateStep,
	type StepVersion,
	type WriteResult
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One routine: its "do it now" view and its edit mode.
 *
 * The energy in the URL decides which version of every step is shown, so it
 * is resolved here (`resolveStepVersion` is server-only, per base.ts's rule
 * that `$lib/server/*` never reaches a `.svelte` file) and sent down as
 * already-picked text. A change to `?energy=` is a normal navigation, which
 * SvelteKit reruns this load for -- nothing client-side has to recompute it.
 */
function energyFrom(value: string | null): StepVersion {
	return (STEP_VERSIONS as readonly string[]).includes(value ?? '')
		? (value as StepVersion)
		: 'average';
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const viewer = await requireViewer(locals.user);

	const found = await getRoutineWithSteps(sql, viewer, params.id);
	// Not found and not permitted read the same: saying a private routine
	// exists but belongs to someone else is itself the disclosure.
	if (!found) error(404, 'Routine not found');
	const { routine, steps } = found;

	const today = await householdToday(sql, viewer.householdId);
	const energy = energyFrom(url.searchParams.get('energy'));

	const [completions, habits] = await Promise.all([
		stepCompletionsOn(sql, viewer, routine.id, viewer.userId, today),
		// Every habit the viewer can see, for the step editor's "link a habit"
		// picker -- the same trade-off `ingredientsForRecipe`'s picker makes:
		// one query for the whole list beats one per keystroke.
		listHabits(sql, viewer, { limit: 200 })
	]);
	const habitName = new Map(habits.map((h) => [h.id, h.name]));

	return {
		today,
		energy,
		routine: {
			id: routine.id,
			name: routine.name,
			notes: routine.notes ?? '',
			notesHtml: renderMarkdown(routine.notes),
			timeOfDay: routine.timeOfDay,
			updatedAt: routine.updatedAt.toISOString(),
			archivedAt: routine.archivedAt ? routine.archivedAt.toISOString() : null
		},
		steps: steps.map((step) => ({
			id: step.id,
			position: step.position,
			title: step.title,
			highVersion: step.highVersion ?? '',
			averageVersion: step.averageVersion,
			minimalVersion: step.minimalVersion ?? '',
			durationMinutes: step.durationMinutes,
			habitId: step.habitId,
			habitName: step.habitId ? (habitName.get(step.habitId) ?? null) : null,
			versionText: resolveStepVersion(step, energy),
			completedVersion: completions.get(step.id) ?? null
		})),
		habitOptions: habits.map((h) => ({ value: h.id, label: h.name }))
	};
};

type Action =
	| 'saveRoutine'
	| 'archiveRoutine'
	| 'addStep'
	| 'saveStep'
	| 'moveStep'
	| 'archiveStep'
	| 'toggleStep';

/** One refusal wording per reason, matching the recipe page's `refused`. */
function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This routine changed elsewhere. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this routine.' });
		default:
			return fail(404, { action, error: 'Could not find that.' });
	}
}

const stepFields = (form: FormData) => ({
	title: form.get('title'),
	averageVersion: form.get('averageVersion'),
	highVersion: form.get('highVersion'),
	minimalVersion: form.get('minimalVersion'),
	durationMinutes: form.get('durationMinutes'),
	habitId: form.get('habitId')
});

export const actions: Actions = {
	saveRoutine: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateRoutine(
			sql,
			viewer,
			params.id,
			{ name: form.get('name'), notes: form.get('notes'), timeOfDay: form.get('timeOfDay') },
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refused('saveRoutine', result);
		return { action: 'saveRoutine' as const, saved: true };
	},

	/** Archiving leaves the page (nothing left here to do); restoring stays,
	 *  the same trade-off the recipe page's own archive action makes. */
	archiveRoutine: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setRoutineArchived(sql, viewer, params.id, archived);
		if (!result.ok) return refused('archiveRoutine', result);
		if (archived) redirect(303, '/routines');
		return { action: 'archiveRoutine' as const, restored: true };
	},

	addStep: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await addStep(sql, viewer, params.id, stepFields(form));
		if (!result.ok) return refused('addStep', result);
		return { action: 'addStep' as const, added: result.record.id };
	},

	saveStep: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const stepId = String(form.get('id') ?? '');

		const result = await updateStep(sql, viewer, stepId, stepFields(form));
		if (!result.ok) return refused('saveStep', result);
		return { action: 'saveStep' as const, saved: true, id: stepId };
	},

	moveStep: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const stepId = String(form.get('id') ?? '');
		const direction = String(form.get('direction') ?? '');

		const result = await moveStep(sql, viewer, stepId, direction);
		if (!result.ok) return refused('moveStep', result);
		return { action: 'moveStep' as const, moved: true };
	},

	archiveStep: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const stepId = String(form.get('id') ?? '');

		const result = await setStepArchived(sql, viewer, stepId, true);
		if (!result.ok) return refused('archiveStep', result);
		return { action: 'archiveStep' as const, archived: true };
	},

	/**
	 * Marks a step done or undoes it, for a day and an energy version.
	 * Idempotent both ways, the same as habits' `toggleCheckIn` -- a double
	 * tap on a phone is not an error.
	 */
	toggleStep: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const stepId = String(form.get('id') ?? '');
		const day = String(form.get('day') ?? '');
		const version = String(form.get('version') ?? 'average');

		if (form.get('done') === 'true') {
			const result = await completeStep(sql, viewer, stepId, day, version);
			if (!result.ok) return refused('toggleStep', result);
			return { action: 'toggleStep' as const, id: stepId };
		}
		await uncompleteStep(sql, viewer, stepId, day);
		return { action: 'toggleStep' as const, id: stepId };
	}
};
