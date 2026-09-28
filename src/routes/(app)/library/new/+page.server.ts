import { fail, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	ENTRY_TYPES,
	LIBRARY_STATUSES,
	createLibraryItem,
	type LibraryStatus
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * A new library entry (PACK1-001).
 *
 * Its own page rather than a form on /library, for the same reason a recipe
 * has one on /food: title is the only thing always known about something
 * worth keeping, and the rest — what it even is, where it came from, what it
 * is about — is often filled in later, the first time the entry is opened
 * again rather than the moment it is added.
 *
 * Household-wide, like every entry the app creates today: `createLibraryItem`
 * defaults to unowned and shared, and nothing anywhere in this pack exposes a
 * privacy control, so this form does not invent one either.
 */

const isStatus = (value: unknown): value is LibraryStatus =>
	LIBRARY_STATUSES.includes(String(value) as LibraryStatus);

export const load: PageServerLoad = async ({ locals, url }) => {
	await requireViewer(locals.user);

	const statusParam = url.searchParams.get('status');
	return {
		statuses: LIBRARY_STATUSES,
		entryTypes: ENTRY_TYPES,
		// /reading links here with ?status=reading_list, so an entry added from
		// there starts on the reading list rather than in the inbox everything
		// else lands in.
		defaultStatus: isStatus(statusParam) ? statusParam : 'inbox'
	};
};

export const actions: Actions = {
	default: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const values = {
			title: String(form.get('title') ?? ''),
			entryType: String(form.get('entryType') ?? ''),
			format: String(form.get('format') ?? ''),
			status: String(form.get('status') ?? ''),
			author: String(form.get('author') ?? ''),
			url: String(form.get('url') ?? ''),
			summary: String(form.get('summary') ?? ''),
			notes: String(form.get('notes') ?? '')
		};

		const result = await createLibraryItem(sql, viewer, values);
		if (!result.ok) {
			// The values go back so a refused save does not cost whatever was
			// just typed out.
			return fail(400, {
				error: result.reason === 'invalid' ? result.message : 'Could not save that entry.',
				values
			});
		}

		redirect(303, `/library/${result.record.id}`);
	}
};
