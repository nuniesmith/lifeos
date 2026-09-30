import { fail, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { createBook } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import { bookFormValuesFromForm, emptyBookFormValues } from '../form';
import type { Actions, PageServerLoad } from './$types';

/**
 * A new book (Reading Tracker R1).
 *
 * Every field is here, unlike /library/new's deliberately short first pass —
 * the operator asked for the full set on day one, and unlike the library
 * there is no "open it again later to fill the rest in" page it would
 * otherwise redirect straight past.
 */

export const load: PageServerLoad = async ({ locals }) => {
	await requireViewer(locals.user);
	return { values: emptyBookFormValues() };
};

export const actions: Actions = {
	default: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const values = bookFormValuesFromForm(form);

		const result = await createBook(sql, viewer, values);
		if (!result.ok) {
			// The typed values go back so a refused save does not cost whatever
			// was just filled in across two dozen fields.
			return fail(400, {
				error: result.reason === 'invalid' ? result.message : 'Could not save that book.',
				values
			});
		}

		redirect(303, `/reading/books/${result.record.id}`);
	}
};
