import { error, fail, redirect } from '@sveltejs/kit';
import {
	createTask,
	getArea,
	householdToday,
	listGoals,
	listHabits,
	listProjects,
	listTasks,
	openTaskCountsByArea,
	openTaskCountsByProject,
	setAreaArchived,
	updateArea,
	updateTask
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import {
	countsById,
	nullable,
	progressOf,
	reviewOf,
	tagActions,
	tagPanel,
	version
} from '../../projects/planning';
import type { Actions, PageServerLoad } from './$types';

/**
 * One life area: everything that belongs to it, and when it was last looked at
 * (UI-007).
 *
 * The direct-task list and its counts use the strict reading of "direct" — a
 * task pointing at this area itself. See the note on the areas list for why
 * that reading is named rather than inferred (DISC-004).
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const area = await getArea(sql, viewer, params.id);
	// Not found and not permitted are the same answer; getArea applies the
	// readable scope.
	if (!area) error(404, 'Area not found');

	const today = await householdToday(sql, viewer.householdId);

	const [projects, goals, habits, tasks, areaCounts, projectCounts, tags] = await Promise.all([
		listProjects(sql, viewer, { areaId: area.id, order: 'due', limit: 200 }),
		listGoals(sql, viewer, { areaId: area.id, order: 'target', limit: 200 }),
		listHabits(sql, viewer, { areaId: area.id, limit: 200 }),
		listTasks(sql, viewer, { areaId: area.id, status: 'open', order: 'due', limit: 200 }),
		openTaskCountsByArea(sql, viewer, { today }),
		openTaskCountsByProject(sql, viewer, { today }),
		tagPanel(viewer, 'area', params.id)
	]);

	const byProject = countsById(projectCounts);

	return {
		today,
		area,
		review: reviewOf(area, today),
		tasksProgress: progressOf(countsById(areaCounts).get(area.id)),
		projects: projects.map((project) => ({
			id: project.id,
			name: project.name,
			status: project.status,
			dueOn: project.dueOn,
			progress: progressOf(byProject.get(project.id))
		})),
		goals: goals.map((goal) => ({
			id: goal.id,
			title: goal.title,
			status: goal.status,
			targetDate: goal.targetDate
		})),
		habits: habits.map((habit) => ({
			id: habit.id,
			name: habit.name,
			active: habit.active,
			targetCount: habit.targetCount,
			targetPeriod: habit.targetPeriod
		})),
		tasks: tasks.map((task) => ({
			id: task.id,
			title: task.title,
			status: task.status,
			due: task.doOn ?? task.deadlineOn,
			updatedAt: task.updatedAt
		})),
		tags
	};
};

export const actions: Actions = {
	...tagActions('area'),

	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateArea(
			sql,
			viewer,
			params.id,
			{
				name: form.get('name'),
				description: nullable(form.get('description')),
				icon: nullable(form.get('icon')),
				reviewEveryDays: form.get('reviewEveryDays'),
				sortOrder: form.get('sortOrder')
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			if (result.reason === 'conflict') {
				return fail(409, {
					error: 'This area changed elsewhere. Reload to see the current version.'
				});
			}
			if (result.reason === 'invalid') {
				return fail(400, { error: result.message ?? 'That change is not valid.' });
			}
			return fail(403, { error: 'You cannot change this area.' });
		}
		return { saved: true };
	},

	/**
	 * "I have looked at this." Stamps today in the household's timezone, which
	 * is the same clock the cadence is measured against — using the server's
	 * date would tick the review over at a different hour of the evening.
	 */
	markReviewed: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const today = await householdToday(sql, viewer.householdId);

		const result = await updateArea(
			sql,
			viewer,
			params.id,
			{ lastReviewedOn: today },
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : 400, {
				error:
					result.reason === 'conflict'
						? 'This area changed elsewhere. Reload to see the current version.'
						: 'Could not record that review.'
			});
		}
		return { reviewed: true };
	},

	/**
	 * A task straight onto the area, with no project in between — which is what
	 * "direct task" means and the only kind this page counts.
	 */
	addTask: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createTask(sql, viewer, {
			title: form.get('title'),
			areaId: params.id
		});
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error:
					result.reason === 'invalid'
						? (result.message ?? 'That task could not be added.')
						: 'You cannot add a task to this area.'
			});
		}
		return { added: true };
	},

	toggleTask: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const done = form.get('done') === 'true';

		const result = await updateTask(
			sql,
			viewer,
			String(form.get('id') ?? ''),
			{ status: done ? 'done' : 'todo' },
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : 400, {
				error:
					result.reason === 'conflict'
						? 'That task changed elsewhere. Reload to see the current version.'
						: 'Could not update that task.'
			});
		}
		return { toggled: true };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setAreaArchived(
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
						? 'This area changed elsewhere. Reload to see the current version.'
						: 'Could not archive that area.'
			});
		}

		if (archived) redirect(303, '/areas');
		return { restored: true };
	}
};
