import { error, fail, redirect } from '@sveltejs/kit';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import { renderMarkdown, safeLinkUrl } from '$lib/server/markdown';
import {
	DOCUMENT_KINDS,
	deleteRenewal,
	getDocument,
	householdToday,
	listDocumentRenewals,
	listPeople,
	renewDocument,
	setDocumentArchived,
	updateDocument,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One document (migration 0036): every field, including the reference --
 * shown here only, never on the list, a search result or the Today card --
 * its renewal history, and renew/undo.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	// Archived documents load too: the Archive links here, and this is where
	// one is looked at before it is restored.
	const document = await getDocument(sql, viewer, params.id);
	// 404 rather than 403 for someone else's private document -- saying that
	// it exists at all is itself the disclosure.
	if (!document) error(404, 'Not found');

	const [renewals, people, today] = await Promise.all([
		listDocumentRenewals(sql, viewer, document.id),
		// A document's holder is a person, or a pet's own registration -- never
		// a place -- the same restriction the repository enforces server-side.
		listPeople(sql, viewer, { kind: ['me', 'person', 'pet'] }),
		householdToday(sql, viewer.householdId)
	]);

	// The stored link is checked on the way out as well as on the way in, the
	// same reasoning /finance/bills/[id] applies to its own `bills.url`.
	const href = safeLinkUrl(document.url);

	return {
		document,
		renewals,
		today,
		notesHtml: renderMarkdown(document.notes),
		source: document.url ? { href, label: href ?? document.url } : null,
		// Presentation only: every action below is refused in SQL for someone
		// who may read this document but not write it, whatever the page offered.
		canEdit: canWrite(document, viewer),
		people: people.map((p) => ({ id: p.id, name: p.name })),
		kinds: DOCUMENT_KINDS
	};
};

type Action = 'save' | 'archive' | 'renew' | 'undoRenewal';

/** One refusal wording per reason, matching every other form in this app. */
function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This document changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this document.' });
		default:
			return fail(404, { action, error: result.message ?? 'Could not find that.' });
	}
}

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateDocument(
			sql,
			viewer,
			params.id,
			{
				title: form.get('title'),
				kind: form.get('kind'),
				holderPersonId: form.get('holderPersonId'),
				issuer: form.get('issuer'),
				reference: form.get('reference'),
				issuedOn: form.get('issuedOn'),
				expiresOn: form.get('expiresOn'),
				renewLeadDays: form.get('renewLeadDays'),
				location: form.get('location'),
				url: form.get('url'),
				notes: form.get('notes')
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

		const result = await setDocumentArchived(sql, viewer, params.id, archived);
		if (!result.ok) return refused('archive', result);

		// Archiving takes it off /life-admin, so back there, where the page's
		// own back link leads. Restoring leaves you on the document you just
		// brought back -- the same shape /finance/bills/[id]'s own archive
		// action uses.
		if (archived) redirect(303, '/life-admin');
		return { action: 'archive' as const, restored: true };
	},

	renew: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await renewDocument(sql, viewer, params.id, {
			newExpiresOn: form.get('newExpiresOn'),
			renewedOn: form.get('renewedOn'),
			note: form.get('note')
		});
		if (!result.ok) return refused('renew', result);
		return { action: 'renew' as const };
	},

	undoRenewal: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const renewalId = String(form.get('renewalId') ?? '');

		const result = await deleteRenewal(sql, viewer, params.id, renewalId);
		if (!result.ok) return refused('undoRenewal', result);
		return { action: 'undoRenewal' as const };
	}
};
