import { fail } from '@sveltejs/kit';
import {
	createTask,
	listTasks,
	setTaskArchived,
	updateTask,
	type TaskFilters,
	type TaskStatus
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import { householdToday } from '$lib/server/repositories/base';
import type { Actions, PageServerLoad } from './$types';

/** The list's named views. `all` still excludes archived and templates. */
const VIEWS = ['today', 'week', 'overdue', 'open', 'done', 'dropped', 'all'] as const;
type View = (typeof VIEWS)[number];

const isView = (value: string | null): value is View => VIEWS.includes((value ?? '') as View);

function filtersFor(view: View, today: string): TaskFilters {
	switch (view) {
		case 'today':
			return { status: 'open', dueTo: today, order: 'due' };
		case 'week':
			return { status: 'open', dueTo: addDays(today, 7), order: 'due' };
		case 'overdue':
			// dueTo is exclusive of today here: yesterday and earlier.
			return { status: 'open', dueTo: addDays(today, -1), order: 'due' };
		case 'done':
			return { status: 'done' as TaskStatus, order: 'created' };
		case 'dropped':
			return { status: 'dropped' as TaskStatus, order: 'created' };
		case 'all':
			return { order: 'due' };
		case 'open':
		default:
			return { status: 'open', order: 'due' };
	}
}

/** Plain calendar arithmetic on a YYYY-MM-DD string, no timezone involved. */
function addDays(day: string, delta: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + delta);
	return d.toISOString().slice(0, 10);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const view: View = isView(url.searchParams.get('view'))
		? (url.searchParams.get('view') as View)
		: 'open';
	const search = url.searchParams.get('q')?.trim() || undefined;

	const tasks = await listTasks(sql, viewer, {
		...filtersFor(view, today),
		...(search ? { search } : {}),
		limit: 200
	});

	return { tasks, view, views: VIEWS, search: search ?? '', today };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createTask(sql, viewer, {
			title: form.get('title'),
			doOn: form.get('doOn') || undefined,
			isImportant: form.get('isImportant') === 'on'
		});

		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { created: result.record.id };
	},

	/**
	 * Toggling completion from the list. Sends the row's `updatedAt` so a stale
	 * tab cannot silently overwrite a change made on the phone.
	 */
	toggle: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const done = form.get('done') === 'true';

		const result = await updateTask(
			sql,
			viewer,
			id,
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
		return { toggled: id };
	},

	archive: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await setTaskArchived(
			sql,
			viewer,
			String(form.get('id') ?? ''),
			form.get('archived') === 'true'
		);
		if (!result.ok) return fail(400, { error: 'Could not archive that task.' });
		return { archived: true };
	}
};
