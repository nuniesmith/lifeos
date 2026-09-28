import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	BILL_FREQUENCIES,
	BILL_TYPES,
	createBill,
	createIncomeEntry,
	createSavingsContribution,
	householdToday,
	incomeSummaryForMonth,
	listBills,
	listGoals,
	listIncomeEntries,
	listSavingsContributions,
	monthlyCommitment,
	savingsSummary,
	setIncomeEntryArchived,
	setSavingsContributionArchived,
	updateIncomeEntry,
	updateSavingsContribution,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Financial Hub (PACK4-002).
 *
 * "Mostly to track recurring bills/subscriptions, income and savings, NOT
 * every single transaction" is the household's own scope for this page —
 * three short lists and a glance at the month, not a ledger. A bill's full
 * set of fields, its payment history and "mark paid" live on its own page
 * (/finance/bills/[id]); income and savings have far fewer fields, so they
 * are add-on-this-list, edit-in-a-sheet, matching the wishlist's own shape.
 */

/** Enough rows to see the month's activity without paging. */
const RECENT_LIMIT = 50;

/** The last day of the month `today` falls in, as a YYYY-MM-DD string. */
function monthEndOf(today: string): string {
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7));
	// Day 0 of next month is the last day of this one — the same trick
	// dates.ts's own daysInMonth uses internally.
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return `${today.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);
	const monthStart = `${today.slice(0, 7)}-01`;
	const monthEnd = monthEndOf(today);

	const [bills, commitment, incomeAll, incomeMonth, savingsAll, savingsTotals, goals] =
		await Promise.all([
			listBills(sql, viewer, { status: ['active', 'free_trial'], limit: 200 }),
			monthlyCommitment(sql, viewer),
			// Archived rows travel with the live ones and are split below, rather
			// than a second query: neither list is fetched again, and this page's
			// only way back for an archived income entry or contribution is
			// right here — unlike a bill, which also has its own detail page and
			// is already reachable from the global Archive besides.
			listIncomeEntries(sql, viewer, { limit: RECENT_LIMIT, includeArchived: true }),
			incomeSummaryForMonth(sql, viewer, monthStart, monthEnd),
			listSavingsContributions(sql, viewer, { limit: RECENT_LIMIT, includeArchived: true }),
			savingsSummary(sql, viewer, monthStart, monthEnd),
			listGoals(sql, viewer, { limit: 200, order: 'title' })
		]);

	// Bills are already ordered "soonest due first" with nulls last (see
	// listBills), so the first one with a date at all is the next one due.
	const nextBill = bills.find((b) => b.nextDueOn !== null) ?? null;

	return {
		today,
		bills,
		commitment,
		income: incomeAll.filter((e) => e.archivedAt === null),
		archivedIncome: incomeAll.filter((e) => e.archivedAt !== null),
		incomeMonth,
		savings: savingsAll.filter((c) => c.archivedAt === null),
		archivedSavings: savingsAll.filter((c) => c.archivedAt !== null),
		savingsTotals,
		goals: goals.map((g) => ({ id: g.id, title: g.title })),
		nextBill,
		// Sent from the load rather than imported by the page: `$lib/server/*`
		// must never reach the browser bundle (svelte-check does not catch
		// this — only `npm run build` does), so the option lists a <Select>
		// needs travel as plain data instead.
		billTypes: BILL_TYPES,
		billFrequencies: BILL_FREQUENCIES
	};
};

type Action =
	| 'addBill'
	| 'addIncome'
	| 'saveIncome'
	| 'archiveIncome'
	| 'addSavings'
	| 'saveSavings'
	| 'archiveSavings';

/** One refusal wording per reason, so every action here explains itself the
 *  same way the rest of the app's forms do. */
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
			return fail(404, { action, error: 'Could not find that.' });
	}
}

export const actions: Actions = {
	addBill: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createBill(sql, viewer, {
			name: form.get('name'),
			type: form.get('type'),
			amount: form.get('amount'),
			frequency: form.get('frequency'),
			nextDueOn: form.get('nextDueOn'),
			category: form.get('category')
		});
		if (!result.ok) return refused('addBill', result);
		return { action: 'addBill' as const, addedId: result.record.id };
	},

	addIncome: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createIncomeEntry(sql, viewer, {
			title: form.get('title'),
			source: form.get('source'),
			expectedAmount: form.get('expectedAmount'),
			actualAmount: form.get('actualAmount'),
			receivedOn: form.get('receivedOn')
		});
		if (!result.ok) return refused('addIncome', result);
		return { action: 'addIncome' as const, addedId: result.record.id };
	},

	saveIncome: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');

		const result = await updateIncomeEntry(
			sql,
			viewer,
			id,
			{
				title: form.get('title'),
				source: form.get('source'),
				type: form.get('type'),
				expectedAmount: form.get('expectedAmount'),
				actualAmount: form.get('actualAmount'),
				receivedOn: form.get('receivedOn'),
				currency: form.get('currency'),
				notes: form.get('notes')
			},
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refused('saveIncome', result);
		return { action: 'saveIncome' as const, saved: true };
	},

	archiveIncome: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const archived = form.get('archived') === 'true';

		const result = await setIncomeEntryArchived(sql, viewer, id, archived);
		if (!result.ok) return refused('archiveIncome', result);
		return { action: 'archiveIncome' as const, archived };
	},

	addSavings: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createSavingsContribution(sql, viewer, {
			title: form.get('title'),
			amount: form.get('amount'),
			contributedOn: form.get('contributedOn'),
			goalId: form.get('goalId') || null
		});
		if (!result.ok) return refused('addSavings', result);
		return { action: 'addSavings' as const, addedId: result.record.id };
	},

	saveSavings: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');

		const result = await updateSavingsContribution(
			sql,
			viewer,
			id,
			{
				title: form.get('title'),
				amount: form.get('amount'),
				contributedOn: form.get('contributedOn'),
				goalId: form.get('goalId') || null,
				notes: form.get('notes')
			},
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refused('saveSavings', result);
		return { action: 'saveSavings' as const, saved: true };
	},

	archiveSavings: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const archived = form.get('archived') === 'true';

		const result = await setSavingsContributionArchived(sql, viewer, id, archived);
		if (!result.ok) return refused('archiveSavings', result);
		return { action: 'archiveSavings' as const, archived };
	}
};
