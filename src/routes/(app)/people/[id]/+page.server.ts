import { error, fail, redirect } from '@sveltejs/kit';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import {
	archiveImportantDate,
	createImportantDate,
	getPerson,
	householdToday,
	listImportantDates,
	listWishlist,
	setPersonArchived,
	unarchiveImportantDate,
	updatePerson,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One person, place or pet: the page the plan's §13 note always meant to
 * exist but never had (PACK1-002). Everything else in this feature — the
 * /people list, the wishlist — only ever pointed at a name; this is where the
 * name is a whole record, with contact details that belong to it alone.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	// Archived people load too: the Archive links here, and this page is where
	// one is looked at before it is brought back.
	const person = await getPerson(sql, viewer, params.id);
	// 404 rather than 403 for someone else's private person: saying that they
	// exist at all is itself the disclosure.
	if (!person) error(404, 'Not found');

	const [gifts, dates, today] = await Promise.all([
		listWishlist(sql, viewer, { forPersonId: person.id, limit: 200 }),
		// Both live and removed: a date added here has nowhere else to be put
		// back from, so this page has to be able to undo its own "Remove".
		listImportantDates(sql, viewer, { personId: person.id, includeArchived: true, limit: 200 }),
		householdToday(sql, viewer.householdId)
	]);

	return {
		person,
		gifts: gifts.map((g) => ({ id: g.id, name: g.name, status: g.status, occasion: g.occasion })),
		dates,
		today,
		// Presentation only: every action below is refused in SQL for someone
		// who may read this record but not write it, whatever the page offered.
		canEdit: canWrite(person, viewer)
	};
};

type Action = 'save' | 'archive' | 'addDate' | 'archiveDate';

/** One refusal wording per reason, so every action explains itself the same way. */
function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This person changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this person.' });
		default:
			return fail(404, { action, error: 'Could not find that.' });
	}
}

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updatePerson(
			sql,
			viewer,
			params.id,
			{
				name: form.get('name'),
				kind: form.get('kind'),
				groups: form.get('groups'),
				birthday: form.get('birthday'),
				notes: form.get('notes'),
				email: form.get('email'),
				phone: form.get('phone'),
				address: form.get('address')
			},
			// The version the form was rendered from: a save from a stale tab is
			// refused rather than overwriting what the other person changed.
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refused('save', result);
		return { action: 'save', saved: true };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setPersonArchived(sql, viewer, params.id, archived);
		if (!result.ok) return refused('archive', result);

		// Archiving takes them off /people, so back there, where the page's own
		// back link leads. Restoring leaves you on the person you just brought
		// back.
		if (archived) redirect(303, '/people');
		return { action: 'archive', restored: true };
	},

	addDate: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createImportantDate(sql, viewer, {
			title: form.get('title'),
			onDate: form.get('onDate'),
			recurrence: form.get('recurrence'),
			personId: params.id
		});
		if (!result.ok) return refused('addDate', result);
		return { action: 'addDate', addedDate: result.record.id };
	},

	// One action for both directions, the same shape as the person's own
	// `archive` above: which date is named by a hidden `id`, since a person can
	// have many.
	archiveDate: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const dateId = String(form.get('id') ?? '');
		const archived = form.get('archived') === 'true';

		const result = archived
			? await archiveImportantDate(sql, viewer, dateId)
			: await unarchiveImportantDate(sql, viewer, dateId);
		if (!result.ok) return refused('archiveDate', result);
		return { action: 'archiveDate', dateArchived: archived };
	}
};
