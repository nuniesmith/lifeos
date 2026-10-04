import { error, fail, redirect } from '@sveltejs/kit';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import { renderMarkdown } from '$lib/server/markdown';
import {
	addChallengeItem,
	booksForChallengeFill,
	clearChallengeItem,
	countChallengeBooks,
	fillChallengeItem,
	getReadingChallenge,
	listChallengeItems,
	listGenres,
	moveChallengeItem,
	setChallengeItemArchived,
	setReadingChallengeArchived,
	updateChallengeItem,
	updateReadingChallenge,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One challenge: a count challenge shows its progress and the books that
 * count toward it; a prompts challenge shows its prompt list, each filled by
 * a book or offering a "Fill" control. Edit mode (title/year/kind/target/
 * notes/filters, and — for a prompts challenge — managing its items) lives
 * in a Sheet, the same split `/routines/[id]` makes between its "do it now"
 * view and its own edit Sheet.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const challenge = await getReadingChallenge(sql, viewer, params.id);
	// 404 rather than 403 for another household's challenge, or a private one
	// belonging to someone else: saying it exists but is not theirs is itself
	// a disclosure (hard rule 7).
	if (!challenge) error(404, 'Not found');

	const [genres, countBooks, items, fillOptions] = await Promise.all([
		listGenres(sql, viewer, { limit: 300 }),
		challenge.kind === 'count' ? countChallengeBooks(sql, viewer, challenge) : Promise.resolve([]),
		challenge.kind === 'prompts'
			? listChallengeItems(sql, viewer, challenge.id)
			: Promise.resolve([]),
		challenge.kind === 'prompts' ? booksForChallengeFill(sql, viewer) : Promise.resolve([])
	]);

	// Derived from the same rows the page already fetched (never a second,
	// separate query) -- the same way `listReadingChallenges` computes it,
	// just from this page's own already-scoped countBooks/items rather than
	// a correlated subquery across every challenge.
	const progress =
		challenge.kind === 'count'
			? { done: countBooks.length, total: challenge.targetCount ?? 0 }
			: { done: items.filter((item) => item.bookId !== null).length, total: items.length };

	return {
		challenge: {
			...challenge,
			updatedAt: challenge.updatedAt.toISOString(),
			progress
		},
		notesHtml: renderMarkdown(challenge.notes, { headingOffset: 2 }),
		genreOptions: genres.map((g) => ({ value: g.id, label: g.name })),
		countBooks,
		items,
		fillOptions: fillOptions.map((b) => ({ value: b.id, label: b.title })),
		canEdit: canWrite(challenge, viewer)
	};
};

type Action =
	| 'save'
	| 'archive'
	| 'addItem'
	| 'saveItem'
	| 'moveItem'
	| 'archiveItem'
	| 'fillItem'
	| 'clearItem';

function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This challenge changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this challenge.' });
		default:
			return fail(404, { action, error: 'Could not find that.' });
	}
}

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateReadingChallenge(
			sql,
			viewer,
			params.id,
			{
				title: form.get('title'),
				year: form.get('year'),
				notes: form.get('notes'),
				kind: form.get('kind'),
				targetCount: form.get('targetCount'),
				category: form.get('category'),
				format: form.get('format'),
				genreId: form.get('genreId')
			},
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refused('save', result);
		return { action: 'save' as const, saved: true };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setReadingChallengeArchived(sql, viewer, params.id, archived);
		if (!result.ok) return refused('archive', result);
		// Archiving takes it off every list, so back to the catalogue, where
		// the page's own back link leads. Restoring leaves you on the
		// challenge you just brought back.
		if (archived) redirect(303, '/reading/challenges');
		return { action: 'archive' as const, restored: true };
	},

	addItem: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await addChallengeItem(sql, viewer, params.id, { prompt: form.get('prompt') });
		if (!result.ok) return refused('addItem', result);
		return { action: 'addItem' as const, added: result.record.id };
	},

	saveItem: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const itemId = String(form.get('itemId') ?? '');

		const result = await updateChallengeItem(sql, viewer, itemId, { prompt: form.get('prompt') });
		if (!result.ok) return refused('saveItem', result);
		return { action: 'saveItem' as const, saved: true, id: itemId };
	},

	moveItem: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const itemId = String(form.get('itemId') ?? '');
		const direction = String(form.get('direction') ?? '');

		const result = await moveChallengeItem(sql, viewer, itemId, direction);
		if (!result.ok) return refused('moveItem', result);
		return { action: 'moveItem' as const, moved: true };
	},

	archiveItem: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const itemId = String(form.get('itemId') ?? '');

		const result = await setChallengeItemArchived(sql, viewer, itemId, true);
		if (!result.ok) return refused('archiveItem', result);
		return { action: 'archiveItem' as const, archived: true };
	},

	fillItem: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const itemId = String(form.get('itemId') ?? '');
		const bookId = String(form.get('bookId') ?? '');

		const result = await fillChallengeItem(sql, viewer, itemId, bookId);
		if (!result.ok) return refused('fillItem', result);
		return { action: 'fillItem' as const, filled: true };
	},

	clearItem: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const itemId = String(form.get('itemId') ?? '');

		const result = await clearChallengeItem(sql, viewer, itemId);
		if (!result.ok) return refused('clearItem', result);
		return { action: 'clearItem' as const, cleared: true };
	}
};
