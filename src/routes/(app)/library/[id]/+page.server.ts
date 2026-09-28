import { error, fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import { renderMarkdown } from '$lib/server/markdown';
import {
	ENTRY_TYPES,
	LIBRARY_STATUSES,
	addLibraryLink,
	attachTag,
	bodyImagesForPage,
	createTag,
	detachTag,
	getLibraryItem,
	listLibrary,
	listLibraryLinks,
	listTags,
	removeLibraryLink,
	setLibraryItemArchived,
	tagsForEntity,
	touchLibraryItem,
	updateLibraryItem,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One library entry (PACK1-001 extends UI-008).
 *
 * This route exists because search generates `/library/<id>` for every library
 * hit, and without it every one of those results was a 404 — the link looked
 * right and went nowhere. A page that is only reachable from search still has
 * to be a real page, so it carries what the entry actually holds: the summary,
 * the notes taken out of it (rendered, not just typed back), its topics, its
 * links to other entries, and the controls to move it along or take it out of
 * the library entirely.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const item = await getLibraryItem(sql, viewer, params.id);
	// 404 rather than 403 for a record in another household, or one this
	// viewer may read but not write: telling someone a thing exists but is
	// not fully theirs is itself a disclosure.
	if (!item) error(404, 'Not found');

	const [tags, allTags, links, otherEntries, bodyImages] = await Promise.all([
		tagsForEntity(sql, viewer, 'library_item', item.id),
		listTags(sql, viewer, { limit: 200 }),
		listLibraryLinks(sql, viewer, item.id),
		listLibrary(sql, viewer, { limit: 200, order: 'title' }),
		bodyImagesForPage(sql, viewer, item.notionPageId)
	]);

	const attachedTagIds = new Set(tags.map((t) => t.id));
	const linkedIds = new Set(links.map((l) => l.itemId));

	return {
		item,
		tags: tags.map((t) => ({ id: t.id, name: t.name })),
		// Household topics not yet on this entry — what the "add a topic"
		// picker offers, the same shape `tagPanel` computes for projects.
		availableTags: allTags
			.filter((t) => !attachedTagIds.has(t.id))
			.map((t) => ({ id: t.id, name: t.name })),
		links,
		// Anything already linked, or the entry itself, is not offered again.
		linkCandidates: otherEntries
			.filter((e) => e.id !== item.id && !linkedIds.has(e.id))
			.map((e) => ({ id: e.id, title: e.title })),
		statuses: LIBRARY_STATUSES,
		entryTypes: ENTRY_TYPES,
		// Sanitized HTML, never Markdown: see $lib/server/markdown for what is
		// allowed through. Editing stays plain Markdown text, in the form below.
		notesHtml: renderMarkdown(item.notes, {
			images: bodyImages,
			mediaUrl: (id) => resolve('/api/media/[id]', { id }),
			headingOffset: 2
		}),
		// Presentation only: every write below is refused in SQL for a viewer
		// who may not write this entry, whatever the page offered them. Every
		// entry created or imported today is household-shared and unowned, so
		// this is always true in practice — kept for the day that stops being
		// so, the same way /food/recipes/[id] keeps its own canEdit.
		canEdit: canWrite(item, viewer)
	};
};

type Action =
	| 'save'
	| 'touch'
	| 'attachTopic'
	| 'detachTopic'
	| 'createTopic'
	| 'addLink'
	| 'removeLink'
	| 'archive';

/**
 * One refusal wording per reason, so every action on this page explains
 * itself the same way. `action` says which form it answers, so a refusal
 * shows up beside the control that caused it rather than at the top of a page
 * with five different forms on it.
 */
function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This entry changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this entry.' });
		default:
			return fail(404, { action, error: 'Could not find that.' });
	}
}

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateLibraryItem(
			sql,
			viewer,
			params.id,
			{
				title: form.get('title'),
				author: form.get('author'),
				url: form.get('url'),
				format: form.get('format'),
				summary: form.get('summary'),
				notes: form.get('notes'),
				status: form.get('status'),
				entryType: form.get('entryType'),
				isFavourite: form.get('isFavourite') === 'on'
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) return refused('save', result);
		return { action: 'save', saved: result.record.id };
	},

	touch: async ({ locals, params }) => {
		const viewer = await requireViewer(locals.user);
		const result = await touchLibraryItem(sql, viewer, params.id);
		if (!result.ok) return refused('touch', result);
		return { action: 'touch', touched: result.record.id };
	},

	attachTopic: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await attachTag(
			sql,
			viewer,
			String(form.get('tagId') ?? ''),
			'library_item',
			params.id
		);
		if (!result.ok) return refused('attachTopic', result);
		return { action: 'attachTopic', ok: true };
	},

	/**
	 * The one place this pack departs from how tags work everywhere else:
	 * `TagsCard` (projects, goals, areas) deliberately refuses to create a tag
	 * from its picker, so a workspace does not end up with "Home" and "home"
	 * as two tags. A topic here can be created in place instead — the plan
	 * asks for it, and `tags.name` is `citext` with a household-unique index,
	 * so "Home" and "home" already collide at the database rather than
	 * becoming two rows; the risk that comment guards against is smaller here
	 * than it was for a select with no such column to lean on.
	 */
	createTopic: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const created = await createTag(sql, viewer, { name: form.get('name') });
		if (!created.ok) return refused('createTopic', created);

		const attached = await attachTag(sql, viewer, created.record.id, 'library_item', params.id);
		if (!attached.ok) return refused('createTopic', attached);
		return { action: 'createTopic', ok: true };
	},

	detachTopic: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		// A topic already off the entry is the state the caller asked for, so
		// this reports success either way — the same convention TagsCard uses.
		await detachTag(sql, viewer, String(form.get('tagId') ?? ''), 'library_item', params.id);
		return { action: 'detachTopic', ok: true };
	},

	addLink: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await addLibraryLink(
			sql,
			viewer,
			params.id,
			String(form.get('linkedItemId') ?? '')
		);
		if (!result.ok) return refused('addLink', result);
		return { action: 'addLink', ok: true };
	},

	removeLink: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		// Removing an edge that is already gone is the state the caller asked
		// for, so it is not reported as a failure — the same convention
		// removeDependency uses on /tasks/[id].
		await removeLibraryLink(sql, viewer, params.id, String(form.get('linkedItemId') ?? ''));
		return { action: 'removeLink', ok: true };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setLibraryItemArchived(sql, viewer, params.id, archived);
		if (!result.ok) return refused('archive', result);

		// Archiving takes it out of view, so back to the library, where the
		// page's own back link leads. Restoring leaves you on the entry you
		// just brought back.
		if (archived) redirect(303, '/library');
		return { action: 'archive', restored: true };
	}
};
