import { error, fail, redirect } from '@sveltejs/kit';
import {
	getGoal,
	householdToday,
	listAreas,
	listHabits,
	listProjects,
	openTaskCountsByProject,
	setGoalArchived,
	updateGoal
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import {
	areasByGoal,
	countsById,
	nullable,
	progressOf,
	sumProgress,
	tagActions,
	tagPanel,
	version,
	type Chip
} from '../../projects/planning';
import type { Actions, PageServerLoad } from './$types';

/**
 * One goal, and what is actually being done about it (UI-006).
 *
 * A goal's progress is the progress of its projects, added up from live task
 * counts. `goals.manual_progress` exists in the schema as an override for goals
 * with nothing countable underneath them, and it is deliberately not offered
 * here: a hand-typed percentage beside a derived one is exactly the pair that
 * drifts, and the import notes (IMP-008) are explicit that the source's stored
 * progress columns were not brought across.
 *
 * ── What is read-only, and why ─────────────────────────────────────────────
 * `project_goals`, `goal_areas` and `goal_habits` are join tables that only the
 * importer writes; the repositories expose no way to add or remove a link, and
 * adding one is repository work rather than page work. So the links are shown
 * and not edited. No control is drawn that would do nothing.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const goal = await getGoal(sql, viewer, params.id);
	// Not found and not permitted are one answer; getGoal applies the readable
	// scope, and saying "it exists but is not yours" would itself disclose it.
	if (!goal) error(404, 'Goal not found');

	const today = await householdToday(sql, viewer.householdId);

	const [projects, counts, areas, tags] = await Promise.all([
		listProjects(sql, viewer, { goalId: goal.id, order: 'due', limit: 200 }),
		openTaskCountsByProject(sql, viewer, { today }),
		listAreas(sql, viewer, { limit: 100 }),
		tagPanel(viewer, 'goal', params.id)
	]);

	const byId = countsById(counts);
	const projectRows = projects.map((project) => ({
		id: project.id,
		name: project.name,
		status: project.status,
		dueOn: project.dueOn,
		progress: progressOf(byId.get(project.id))
	}));

	const chips = await areasByGoal(sql, viewer, areas);
	const goalAreas: Chip[] = chips.get(goal.id) ?? [];

	// Habits are attached to an *area*, not to a goal — `goal_habits` exists but
	// nothing can write it. What can be answered honestly is which habits sit in
	// this goal's areas, and that is what the card says it shows.
	const habitLists = await Promise.all(
		goalAreas.map((area) => listHabits(sql, viewer, { areaId: area.id, limit: 100 }))
	);
	const seen = new Set<string>();
	const habits = habitLists.flat().filter((habit) => {
		if (seen.has(habit.id)) return false;
		seen.add(habit.id);
		return true;
	});

	return {
		today,
		goal,
		projects: projectRows,
		progress: sumProgress(projectRows.map((row) => row.progress)),
		areas: goalAreas,
		habits: habits.map((habit) => ({
			id: habit.id,
			name: habit.name,
			active: habit.active,
			targetCount: habit.targetCount,
			targetPeriod: habit.targetPeriod
		})),
		tags
	};
};

export const actions: Actions = {
	...tagActions('goal'),

	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateGoal(
			sql,
			viewer,
			params.id,
			{
				title: form.get('title'),
				description: nullable(form.get('description')),
				status: form.get('status'),
				targetDate: form.get('targetDate')
				// `achievedOn` is left to the repository, which dates a goal when
				// its status becomes `achieved`.
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			if (result.reason === 'conflict') {
				return fail(409, {
					error: 'This goal changed elsewhere. Reload to see the current version.'
				});
			}
			if (result.reason === 'invalid') {
				return fail(400, { error: result.message ?? 'That change is not valid.' });
			}
			return fail(403, { error: 'You cannot change this goal.' });
		}
		return { saved: true };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setGoalArchived(
			sql,
			viewer,
			params.id,
			archived,
			version(form.get('updatedAt'))
		);
		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : 400, {
				error:
					result.reason === 'conflict'
						? 'This goal changed elsewhere. Reload to see the current version.'
						: 'Could not archive that goal.'
			});
		}

		if (archived) redirect(303, '/goals');
		return { restored: true };
	}
};
