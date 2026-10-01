import { error, fail, redirect } from '@sveltejs/kit';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import { renderMarkdown, safeLinkUrl } from '$lib/server/markdown';
import {
	deleteRead,
	dnfRead,
	finishRead,
	getBook,
	getBookSeries,
	householdToday,
	listAuthorsForBook,
	listGenresForBook,
	listReadsForBook,
	pauseRead,
	readCount,
	resumeRead,
	setBookArchived,
	startRead,
	updateBook,
	updateRead,
	updateReadProgress,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import { bookFormValuesFromForm, bookFormValuesFromRecord } from '../form';
import type { Actions, PageServerLoad } from './$types';

/**
 * One book: view, edit every field, archive and restore (Reading Tracker R1),
 * plus the Reading section (R2): start/pause/resume/finish/dnf a read,
 * progress, and the read history in a Sheet — see `ReadingSection.svelte`.
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

	const [authors, genres, series, reads, myReadCount, today] = await Promise.all([
		listAuthorsForBook(sql, viewer, book.id),
		listGenresForBook(sql, viewer, book.id),
		book.seriesId ? getBookSeries(sql, viewer, book.seriesId) : Promise.resolve(null),
		listReadsForBook(sql, viewer, book.id),
		readCount(sql, viewer, book.id),
		householdToday(sql, viewer.householdId)
	]);

	const values = bookFormValuesFromRecord(book, authors, genres);
	values.seriesName = series?.name ?? '';

	// The viewer's own open read, if any — the Reading section shows either
	// this (progress/pause-or-resume/finish/dnf) or a plain "Start reading"
	// button, never both. At most one can exist (migration 0033's partial
	// unique index), so `find` is safe. Written as a type predicate (rather
	// than a plain boolean-returning arrow) so `status` narrows to exactly
	// ReadingSection's own `ActiveReadInfo['status']` below.
	const activeRead =
		reads.find(
			(r): r is (typeof reads)[number] & { status: 'reading' | 'paused' } =>
				r.readerUserId === viewer.userId && (r.status === 'reading' || r.status === 'paused')
		) ?? null;

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
		canEdit: canWrite(book, viewer),
		// Every reader's history, newest first, each with its review already
		// rendered — a read's own reader may edit or delete their row in a
		// Sheet (ReadSheet.svelte), gated the same way the server actions
		// below are (hard rule 8): the Sheet only offers the controls, the
		// repository is what actually refuses someone else's row.
		reads: reads.map((r) => ({
			...r,
			reviewHtml: renderMarkdown(r.review, { headingOffset: 3 })
		})),
		readCount: myReadCount,
		activeRead,
		today,
		viewerId: viewer.userId
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

type ReadAction =
	'start' | 'progress' | 'pause' | 'resume' | 'finish' | 'dnf' | 'editRead' | 'deleteRead';

/** As {@link refused}, but for the read-log actions below — worded for "this
 *  read" rather than "this book", since the two are refused independently
 *  (hard rule 8: editing someone else's read of a book you can still see is
 *  its own, narrower, refusal). */
function refusedRead(action: ReadAction, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This read changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this read.' });
		default:
			return fail(404, { action, error: 'Could not find that read.' });
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
	},

	start: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await startRead(sql, viewer, params.id, {
			format: form.get('format') || undefined
		});
		if (!result.ok) return refusedRead('start', result);
		return { action: 'start', readId: result.record.id };
	},

	progress: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await updateReadProgress(
			sql,
			viewer,
			String(form.get('readId') ?? ''),
			{
				progressPages: form.get('progressPages') || undefined,
				progressMinutes: form.get('progressMinutes') || undefined
			},
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refusedRead('progress', result);
		return { action: 'progress', readId: result.record.id };
	},

	pause: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await pauseRead(
			sql,
			viewer,
			String(form.get('readId') ?? ''),
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refusedRead('pause', result);
		return { action: 'pause', readId: result.record.id };
	},

	resume: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await resumeRead(
			sql,
			viewer,
			String(form.get('readId') ?? ''),
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refusedRead('resume', result);
		return { action: 'resume', readId: result.record.id };
	},

	finish: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await finishRead(
			sql,
			viewer,
			String(form.get('readId') ?? ''),
			{
				finishedOn: form.get('finishedOn') || undefined,
				rating: form.get('rating') || undefined,
				review: form.get('review') || undefined
			},
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refusedRead('finish', result);
		return { action: 'finish', readId: result.record.id };
	},

	dnf: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await dnfRead(
			sql,
			viewer,
			String(form.get('readId') ?? ''),
			{ reason: form.get('reason') || undefined },
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refusedRead('dnf', result);
		return { action: 'dnf', readId: result.record.id };
	},

	editRead: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await updateRead(
			sql,
			viewer,
			String(form.get('readId') ?? ''),
			{
				startedOn: form.get('startedOn') || undefined,
				finishedOn: form.get('finishedOn') || undefined,
				format: form.get('format') || undefined,
				rating: form.get('rating') || undefined,
				review: form.get('review') || undefined
			},
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refusedRead('editRead', result);
		return { action: 'editRead', readId: result.record.id };
	},

	deleteRead: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await deleteRead(sql, viewer, String(form.get('readId') ?? ''));
		if (!result.ok) return refusedRead('deleteRead', result);
		return { action: 'deleteRead', deletedId: result.record.id };
	}
};
