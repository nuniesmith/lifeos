import { error, fail, redirect } from '@sveltejs/kit';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import { renderMarkdown, safeLinkUrl } from '$lib/server/markdown';
import {
	getBook,
	getBookSeries,
	listAuthorsForBook,
	listGenresForBook,
	setBookArchived,
	updateBook,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import { bookFormValuesFromForm, bookFormValuesFromRecord } from '../form';
import type { Actions, PageServerLoad } from './$types';

/**
 * One book: view, edit every field, archive and restore (Reading Tracker R1).
 *
 * The series name is not on `books` itself — only `series_id` is — so the
 * edit form's starting value for it is filled in here, from the series this
 * book already points at, the same way the library's edit form is seeded
 * from a join the entry itself does not carry.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const book = await getBook(sql, viewer, params.id);
	// 404 rather than 403 for another household's book, or one this viewer
	// may read but not write: saying a book exists but is not fully theirs
	// is itself a disclosure (hard rule 7).
	if (!book) error(404, 'Not found');

	const [authors, genres, series] = await Promise.all([
		listAuthorsForBook(sql, viewer, book.id),
		listGenresForBook(sql, viewer, book.id),
		book.seriesId ? getBookSeries(sql, viewer, book.seriesId) : Promise.resolve(null)
	]);

	const values = bookFormValuesFromRecord(book, authors, genres);
	values.seriesName = series?.name ?? '';

	return {
		book,
		authors,
		genres,
		series,
		values,
		// Sanitized HTML, never Markdown — see $lib/server/markdown. Editing
		// stays plain Markdown text, in the form below.
		descriptionHtml: renderMarkdown(book.description, { headingOffset: 2 }),
		notesHtml: renderMarkdown(book.notes, { headingOffset: 2 }),
		// Presentation only: safeLinkUrl also runs again wherever this is
		// rendered from stored data elsewhere, because this value was never
		// checked on the way in — it is free text (plan §26) — only on the
		// way out.
		storygraphHref: safeLinkUrl(book.storygraphUrl),
		// Every book created or imported today is household-shared and
		// unowned, so this is always true in practice — kept for the day a
		// privacy control appears on the new-book form, the same reason
		// /library/[id] keeps its own canEdit despite the same fact holding
		// there.
		canEdit: canWrite(book, viewer)
	};
};

type Action = 'save' | 'archive';

function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This book changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this book.' });
		default:
			return fail(404, { action, error: 'Could not find that.' });
	}
}

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const values = bookFormValuesFromForm(form);

		const result = await updateBook(
			sql,
			viewer,
			params.id,
			values,
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refused('save', result);
		return { action: 'save', saved: result.record.id };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setBookArchived(sql, viewer, params.id, archived);
		if (!result.ok) return refused('archive', result);

		// Archiving takes it off every list, so back to the catalogue, where
		// the page's own back link leads. Restoring leaves you on the book you
		// just brought back.
		if (archived) redirect(303, '/reading/books');
		return { action: 'archive', restored: true };
	}
};
