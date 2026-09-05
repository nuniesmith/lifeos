import { error, fail, redirect } from '@sveltejs/kit';
import {
	addTaskDependency,
	createTask,
	getTask,
	listTaskDependencies,
	removeTaskDependency,
	listAreas,
	listProjects,
	listTasks,
	setTaskArchived,
	updateTask
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const task = await getTask(sql, viewer, params.id);
	// Not found and not permitted are the same answer on purpose: telling a
	// member that a task exists but is not theirs to see is itself a
	// disclosure. getTask already applies the readable scope.
	if (!task) error(404, 'Task not found');

	const [subtasks, projects, areas, parent, dependencies, candidates] = await Promise.all([
		listTasks(sql, viewer, { parentTaskId: task.id, includeArchived: true, order: 'manual' }),
		listProjects(sql, viewer, { limit: 200 }),
		listAreas(sql, viewer, { limit: 200 }),
		task.parentTaskId ? getTask(sql, viewer, task.parentTaskId) : Promise.resolve(null),
		listTaskDependencies(sql, viewer, task.id),
		listTasks(sql, viewer, { status: 'open', limit: 100, order: 'title' })
	]);

	// Anything already linked, or the task itself, is not offered again.
	const linked = new Set([
		task.id,
		...dependencies.blockedBy.map((d) => d.blockingTaskId),
		...dependencies.blocking.map((d) => d.blockedTaskId)
	]);

	return {
		task,
		subtasks,
		parent,
		projects,
		areas,
		dependencies,
		candidates: candidates.filter((t) => !linked.has(t.id))
	};
};

/** Empty select values arrive as '' and mean "no link", not "unchanged". */
const nullable = (value: FormDataEntryValue | null): string | null => {
	const text = String(value ?? '').trim();
	return text === '' ? null : text;
};

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateTask(
			sql,
			viewer,
			params.id,
			{
				title: form.get('title'),
				notes: nullable(form.get('notes')),
				status: form.get('status'),
				doOn: nullable(form.get('doOn')),
				deadlineOn: nullable(form.get('deadlineOn')),
				projectId: nullable(form.get('projectId')),
				areaId: nullable(form.get('areaId')),
				energy: nullable(form.get('energy')),
				context: nullable(form.get('context')),
				isImportant: form.get('isImportant') === 'on',
				isUrgent: form.get('isUrgent') === 'on'
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			if (result.reason === 'conflict') {
				return fail(409, {
					error: 'This task changed elsewhere. Reload to see the current version.'
				});
			}
			if (result.reason === 'invalid') return fail(400, { error: result.message });
			return fail(403, { error: 'You cannot change this task.' });
		}
		return { saved: true };
	},

	addSubtask: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createTask(sql, viewer, {
			title: form.get('title'),
			parentTaskId: params.id
		});
		if (!result.ok) {
			return fail(400, {
				error: result.reason === 'invalid' ? result.message : 'Could not add that subtask.'
			});
		}
		return { added: true };
	},

	toggleSubtask: async ({ locals, request }) => {
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
		if (!result.ok) return fail(400, { error: 'Could not update that subtask.' });
		return { ok: true };
	},

	addDependency: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await addTaskDependency(
			sql,
			viewer,
			params.id,
			String(form.get('blockingTaskId') ?? '')
		);
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 404, {
				error:
					result.reason === 'invalid'
						? (result.message ?? 'That dependency is not allowed.')
						: 'That task is not available.'
			});
		}
		return { ok: true };
	},

	removeDependency: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		await removeTaskDependency(
			sql,
			viewer,
			String(form.get('blockedTaskId') ?? ''),
			String(form.get('blockingTaskId') ?? '')
		);
		// Removing an edge that is already gone is the state the caller asked
		// for, so it is not reported as a failure.
		return { ok: true };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setTaskArchived(sql, viewer, params.id, archived);
		if (!result.ok) return fail(400, { error: 'Could not archive that task.' });

		// Archiving is a removal from view, so returning to the list is the
		// useful outcome. Restoring leaves you on the task you just restored.
		if (archived) redirect(303, '/tasks');
		return { ok: true };
	}
};
