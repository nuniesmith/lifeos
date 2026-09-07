import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	createTask,
	listAreas,
	listProjects,
	listTasks,
	setTaskArchived,
	updateTask
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Quick Drop | Inbox.
 *
 * Capture and triage are deliberately the same page: the cost of writing
 * something down has to stay near zero, and the cost of filing it has to be
 * one click from where it landed. Everything here is a task with status
 * `inbox` — see migration 0008 for why that is a status rather than a view.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);

	const [tasks, projects, areas] = await Promise.all([
		listTasks(sql, viewer, { status: 'inbox', order: 'created', limit: 200 }),
		listProjects(sql, viewer, { openOnly: true, order: 'name', limit: 200 }),
		listAreas(sql, viewer, { order: 'name', limit: 200 })
	]);

	return {
		tasks,
		projects: projects.map((p) => ({ id: p.id, name: p.name })),
		areas: areas.map((a) => ({ id: a.id, name: a.name }))
	};
};

export const actions: Actions = {
	/** Capture. Nothing but a title is asked for, on purpose. */
	capture: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createTask(sql, viewer, {
			title: form.get('title'),
			status: 'inbox'
		});

		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { captured: result.record.id };
	},

	/**
	 * Triage: file the task somewhere and leave the inbox in one step.
	 *
	 * A destination of `''` means "keep it where it is but stop asking" — the
	 * task becomes a plain to-do with no project. That is a real answer to
	 * "where does this belong", so it is offered rather than forced.
	 */
	file: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const destination = String(form.get('destination') ?? '');

		const [kind, value] = destination.includes(':')
			? destination.split(':', 2)
			: ([destination, ''] as const);

		const result = await updateTask(
			sql,
			viewer,
			id,
			{
				status: 'todo',
				...(kind === 'project' && value ? { projectId: value } : {}),
				...(kind === 'area' && value ? { areaId: value } : {})
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : 400, {
				error:
					result.reason === 'conflict'
						? 'That task changed elsewhere. Reload to see the current version.'
						: 'Could not file that task.'
			});
		}
		return { filed: id };
	},

	/** Straight to done, for the things that turn out to take a minute. */
	complete: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');

		const result = await updateTask(
			sql,
			viewer,
			id,
			{ status: 'done' },
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return fail(400, { error: 'Could not complete that task.' });
		return { completed: id };
	},

	/** Recoverable, like every deletion here: it moves to the archive. */
	discard: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await setTaskArchived(sql, viewer, String(form.get('id') ?? ''), true);
		if (!result.ok) return fail(400, { error: 'Could not discard that task.' });
		return { discarded: true };
	}
};
