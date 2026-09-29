import { error, fail, redirect } from '@sveltejs/kit';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import { safeLinkUrl } from '$lib/server/markdown';
import {
	BILL_FREQUENCIES,
	BILL_STATUSES,
	BILL_TYPES,
	deleteBillPayment,
	getBill,
	householdToday,
	listBillPayments,
	recordBillPayment,
	setBillArchived,
	updateBill,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One bill or subscription (PACK4-002): every field, its payment history,
 * and "mark paid" — everything /finance's own list has no room for. See that
 * page's own header for why editing lives here rather than in a sheet.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	// Archived bills load too: the Archive links here, and this page is where
	// one is looked at before it is restored.
	const bill = await getBill(sql, viewer, params.id);
	// 404 rather than 403 for someone else's private bill: saying that it
	// exists at all is itself the disclosure.
	if (!bill) error(404, 'Not found');

	const [payments, today] = await Promise.all([
		listBillPayments(sql, viewer, bill.id),
		householdToday(sql, viewer.householdId)
	]);

	// The stored link is checked on the way out as well as on the way in: an
	// imported or hand-typed value never went through the repository's own
	// validation, and safeLinkUrl is what /wishlist/[id] uses for the same
	// reason.
	const href = safeLinkUrl(bill.url);

	return {
		bill,
		payments,
		today,
		source: bill.url ? { href, label: href ?? bill.url } : null,
		// Presentation only: every action below is refused in SQL for someone
		// who may read this bill but not write it, whatever the page offered.
		canEdit: canWrite(bill, viewer),
		// Sent from the load rather than imported by the page: $lib/server/*
		// must never reach the browser bundle — only `npm run build` catches
		// that, not svelte-check — so a <Select>'s options travel as data.
		billTypes: BILL_TYPES,
		billFrequencies: BILL_FREQUENCIES,
		billStatuses: BILL_STATUSES
	};
};

type Action = 'save' | 'archive' | 'markPaid' | 'undoPayment';

/** One refusal wording per reason, so every action here explains itself the
 *  same way the rest of the app's forms do. */
function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This bill changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this bill.' });
		default:
			return fail(404, { action, error: 'Could not find that.' });
	}
}

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateBill(
			sql,
			viewer,
			params.id,
			{
				name: form.get('name'),
				type: form.get('type'),
				amount: form.get('amount'),
				currency: form.get('currency'),
				frequency: form.get('frequency'),
				nextDueOn: form.get('nextDueOn'),
				category: form.get('category'),
				account: form.get('account'),
				autopay: form.get('autopay'),
				status: form.get('status'),
				freeTrialEndsOn: form.get('freeTrialEndsOn'),
				trialPrice: form.get('trialPrice'),
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

		const result = await setBillArchived(sql, viewer, params.id, archived);
		if (!result.ok) return refused('archive', result);

		// Archiving takes it off /finance, so back there, where the page's own
		// back link leads. Restoring leaves you on the bill you just brought
		// back — the same shape /people/[id]'s own archive action uses.
		if (archived) redirect(303, '/finance');
		return { action: 'archive' as const, restored: true };
	},

	markPaid: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await recordBillPayment(sql, viewer, params.id, {
			amountPaid: form.get('amountPaid'),
			paidOn: form.get('paidOn'),
			note: form.get('note')
		});
		if (!result.ok) return refused('markPaid', result);
		return { action: 'markPaid' as const };
	},

	undoPayment: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const paymentId = String(form.get('paymentId') ?? '');

		const result = await deleteBillPayment(sql, viewer, params.id, paymentId);
		if (!result.ok) return refused('undoPayment', result);
		return { action: 'undoPayment' as const };
	}
};
