import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	DOCUMENT_KINDS,
	attentionState,
	createDocument,
	daysBetween,
	householdToday,
	listDocuments,
	listPeople,
	type AttentionState,
	type DocumentKind,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Life Admin HQ (migration 0036): documents and renewals -- IDs, insurance,
 * warranties, licences -- grouped by what needs attention first.
 *
 * The source's own "Life Admin HQ" database exported empty, so there is no
 * importer and nothing here was carried over; every row comes from this
 * page's own quick add, or the detail page's full editor.
 */

const isKind = (value: unknown): value is DocumentKind =>
	typeof value === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(value);

/**
 * "Expired 3 days ago" / "expires in 12 days" -- only for the two states the
 * Needs Attention section shows with a day count at all; `ok` and `none`
 * rows are shown by plain date or not dated, on the page itself.
 *
 * Built here, not in the page: `daysBetween` lives under `$lib/server`, and a
 * `.svelte` file may only `import type` from there (rule: server code stays
 * out of the browser bundle).
 */
function attentionLabel(
	state: AttentionState,
	expiresOn: string | null,
	today: string
): string | null {
	if (expiresOn === null || (state !== 'expired' && state !== 'due')) return null;
	const days = daysBetween(today, expiresOn);
	if (state === 'expired') {
		const n = Math.abs(days);
		return `expired ${n} day${n === 1 ? '' : 's'} ago`;
	}
	return days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);

	const kindParam = url.searchParams.get('kind');
	const kind = isKind(kindParam) ? kindParam : undefined;
	const holderParam = url.searchParams.get('holder');
	const holder = holderParam && holderParam.trim() ? holderParam : undefined;

	const [rows, people, today] = await Promise.all([
		listDocuments(sql, viewer, { kind, holder, limit: 500 }),
		// A document's holder is a person, or a pet's own registration -- never
		// a place -- the same restriction createDocument/updateDocument enforce
		// server-side through resolveHolder.
		listPeople(sql, viewer, { kind: ['me', 'person', 'pet'] }),
		householdToday(sql, viewer.householdId)
	]);

	// `rows` already arrives soonest-expiry-first with no expiry last (see
	// listDocuments's own ORDER BY), so attaching state here and letting the
	// page filter by it keeps that one order intact across all three
	// sections instead of three separate sorts that could disagree.
	const documents = rows.map((d) => {
		const state = attentionState(d.expiresOn, today, d.renewLeadDays);
		return { ...d, state, dueLabel: attentionLabel(state, d.expiresOn, today) };
	});

	return {
		documents,
		people: people.map((p) => ({ id: p.id, name: p.name })),
		kinds: DOCUMENT_KINDS,
		kind: kind ?? '',
		holder: holder ?? '',
		today
	};
};

type Action = 'create';

/** One refusal wording per reason, matching every other form in this app. */
function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'That changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change that.' });
		default:
			return fail(404, { action, error: result.message ?? 'Could not find that.' });
	}
}

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createDocument(sql, viewer, {
			title: form.get('title'),
			kind: form.get('kind'),
			holderPersonId: form.get('holderPersonId') || null,
			expiresOn: form.get('expiresOn')
		});
		if (!result.ok) return refused('create', result);
		return { action: 'create' as const, addedId: result.record.id };
	}
};
