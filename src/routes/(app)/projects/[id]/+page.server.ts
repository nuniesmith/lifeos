import { error, fail, redirect } from '@sveltejs/kit';
import {
	createTask,
	getProject,
	householdToday,
	listAreas,
	listTasks,
	openTaskCountsByProject,
	setProjectArchived,
	updateProject,
	updateTask
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import {
	areasByProject,
	countsById,
	nullable,
	progressOf,
	tagActions,
	tagPanel,
	version
} from '../planning';
import type { Actions, PageServerLoad } from './$types';

/**
 * One project: its work, its progress and its settings (UI-005).
 *
 * Milestones are tasks with `kind = 'milestone'`, so they are the same records
 * shown apart. They count towards the project's progress exactly like any other
 * task, which is what the source workspace meant by them: a milestone is a task
 * that is worth naming.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const project = await getProject(sql, viewer, params.id);
	// Not found and not permitted are the same answer on purpose: saying a
	// project exists but is not yours to see is itself a disclosure.
	// getProject already applies the readable scope.
	if (!project) error(404, 'Project not found');

	const today = await householdToday(sql, viewer.householdId);

	const [milestones, tasks, counts, areas, tags] = await Promise.all([
		listTasks(sql, viewer, { projectId: project.id, kind: 'milestone', order: 'due', limit: 100 }),
		listTasks(sql, viewer, { projectId: project.id, kind: 'task', order: 'due', limit: 200 }),
		openTaskCountsByProject(sql, viewer, { today }),
		listAreas(sql, viewer, { limit: 100 }),
		tagPanel(viewer, 'project', params.id)
	]);

	// The whole-project figures come from the counts query rather than from the
	// rows above: those are capped at 200 and could differ on a very large
	// project, and a page that reports two different totals for one project is
	// worse than one that reports a single honest one.
	const progress = progressOf(countsById(counts).get(project.id));

	const chips = await areasByProject(sql, viewer, areas);

	const asRow = (task: {
		id: string;
		title: string;
		status: string;
		doOn: string | null;
		deadlineOn: string | null;
		updatedAt: Date;
	}) => ({
		id: task.id,
		title: task.title,
		status: task.status,
		due: task.doOn ?? task.deadlineOn,
		updatedAt: task.updatedAt
	});

	return {
		today,
		project,
		progress,
		milestones: milestones.map(asRow),
		tasks: tasks.map(asRow),
		// The areas a project belongs to. The opposite direction — the goals a
		// project serves — would cost a query per goal, so the goal's own page
		// draws that link instead.
		areas: chips.get(project.id) ?? [],
		tags
	};
};

export const actions: Actions = {
	...tagActions('project'),

	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateProject(
			sql,
			viewer,
			params.id,
			{
				name: form.get('name'),
				description: nullable(form.get('description')),
				status: form.get('status'),
				startOn: form.get('startOn'),
				dueOn: form.get('dueOn')
				// `completedOn` is deliberately absent: the repository dates a
				// project the moment its status becomes `done`, and offering the
				// field as well is how the two end up disagreeing.
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			if (result.reason === 'conflict') {
				return fail(409, {
					error: 'This project changed elsewhere. Reload to see the current version.'
				});
			}
			if (result.reason === 'invalid') {
				return fail(400, { error: result.message ?? 'That change is not valid.' });
			}
			return fail(403, { error: 'You cannot change this project.' });
		}
		return { saved: true };
	},

	/** Adds a task or a milestone; they differ only in `kind`. */
	addTask: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const kind = form.get('kind') === 'milestone' ? 'milestone' : 'task';

		const result = await createTask(sql, viewer, {
			title: form.get('title'),
			projectId: params.id,
			kind,
			deadlineOn: form.get('deadlineOn') || undefined
		});
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error:
					result.reason === 'invalid'
						? (result.message ?? 'That could not be added.')
						: 'You cannot add work to this project.'
			});
		}
		return { added: true };
	},

	/**
	 * Ticking a task off from the project page. The row's `updatedAt` travels
	 * with it so a stale tab cannot overwrite a change made on the phone.
	 */
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

		const result = await setProjectArchived(
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
						? 'This project changed elsewhere. Reload to see the current version.'
						: 'Could not archive that project.'
			});
		}

		// Archiving removes it from the lists, so the list is where to land.
		// Restoring leaves you on the project you have just brought back.
		if (archived) redirect(303, '/projects');
		return { restored: true };
	}
};
