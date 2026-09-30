import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	createBill,
	createIncomeEntry,
	createSavingsContribution,
	deleteBillPayment,
	getBill,
	getIncomeEntry,
	householdToday,
	incomeSummaryForMonth,
	listBillPayments,
	listBills,
	listIncomeEntries,
	listSavingsContributions,
	recordBillPayment,
	savingsSummary,
	setBillArchived,
	setIncomeEntryArchived,
	setSavingsContributionArchived,
	updateBill,
	updateIncomeEntry,
	updateSavingsContribution
} from '$lib/server/repositories';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * The Financial Hub (PACK4-002, migration 0029): editable bills, the payment
 * log "mark paid" writes and undoes, income, and savings toward a goal.
 *
 * All amounts and payees below are invented for this test file — nothing
 * here is read from the household's own data.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	const householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	owner = viewerOf(
		{
			id: admin.id,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		householdId
	);
	const created = await createMember(sql, admin.id, householdId, {
		username: 'partner',
		displayName: 'Partner',
		role: 'member'
	});
	if (!created.ok) throw new Error('could not create the member');
	partner = viewerOf(
		{
			id: created.userId,
			username: 'partner',
			displayName: 'Partner',
			role: 'member',
			mustChangeCredentials: true,
			isBootstrap: false
		},
		householdId
	);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

const ok = <T extends { ok: boolean }>(result: T, what: string) => {
	if (!result.ok) throw new Error(`could not ${what}: ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
};
const failed = <T extends { ok: boolean }>(result: T, what: string) => {
	if (result.ok) throw new Error(`expected to fail to ${what}, but it succeeded`);
	return result as Extract<T, { ok: false }>;
};

describe('bills', () => {
	it('creates one with the fields this pack added, and edits every field', async () => {
		const created = ok(
			await createBill(sql, owner, {
				name: 'Fictional Fibernet',
				type: 'subscription',
				amount: 64.99,
				frequency: 'monthly',
				nextDueOn: '2026-10-01',
				category: 'Internet',
				url: 'https://example.com/fictional-fibernet'
			}),
			'create a bill'
		).record;
		expect(created).toMatchObject({
			name: 'Fictional Fibernet',
			type: 'subscription',
			amount: 64.99,
			currency: 'CAD',
			url: 'https://example.com/fictional-fibernet',
			trialPrice: null,
			notes: null
		});

		const edited = ok(
			await updateBill(
				sql,
				owner,
				created.id,
				{
					name: 'Fictional Fibernet Plus',
					type: 'subscription',
					amount: 74.99,
					currency: 'usd',
					frequency: 'annual',
					nextDueOn: '2027-01-15',
					category: 'Internet & TV',
					account: 'Visa ending 4242',
					autopay: 'on',
					status: 'free_trial',
					freeTrialEndsOn: '2026-11-01',
					trialPrice: 9.99,
					url: 'https://example.com/fictional-fibernet-plus',
					notes: 'Introductory rate.'
				},
				created.updatedAt
			),
			'edit every field'
		).record;
		expect(edited).toMatchObject({
			name: 'Fictional Fibernet Plus',
			amount: 74.99,
			currency: 'USD',
			frequency: 'annual',
			nextDueOn: '2027-01-15',
			category: 'Internet & TV',
			account: 'Visa ending 4242',
			autopay: true,
			status: 'free_trial',
			freeTrialEndsOn: '2026-11-01',
			trialPrice: 9.99,
			url: 'https://example.com/fictional-fibernet-plus',
			notes: 'Introductory rate.'
		});

		// Clearing autopay: the route always sends the key (form.get('autopay')
		// is null, not absent, for an unchecked box), and that null must turn
		// autopay off rather than leaving it alone the way a genuinely absent
		// key would (patched()'s "not mentioned" case, proven for name/status/
		// etc. by every field above keeping its value across this same call).
		const uncheck = ok(
			await updateBill(sql, owner, created.id, { autopay: null }, edited.updatedAt),
			'save with autopay unset'
		).record;
		expect(uncheck.autopay).toBe(false);
		expect(uncheck.name).toBe('Fictional Fibernet Plus');
	});

	it('archives and restores a bill', async () => {
		const created = ok(await createBill(sql, owner, { name: 'Fictional Gym' }), 'create').record;

		const archived = ok(await setBillArchived(sql, owner, created.id, true), 'archive').record;
		expect(archived.archivedAt).not.toBeNull();
		expect(await listBills(sql, owner, { status: ['active', 'free_trial'] })).toEqual([]);

		const restored = ok(await setBillArchived(sql, owner, created.id, false), 'restore').record;
		expect(restored.archivedAt).toBeNull();
	});

	it('refuses a negative amount and an out-of-range type with a field message, not a 500', async () => {
		failed(await createBill(sql, owner, { name: 'Fictional Bill', amount: -5 }), 'go negative');
		failed(await createBill(sql, owner, { name: 'Fictional Bill', type: 'loan' }), 'invent a type');
	});

	it('conflicts on a stale edit, and 404s rather than 403s for a private bill', async () => {
		const created = ok(
			await createBill(sql, owner, {
				name: 'Fictional Private Bill',
				visibility: 'private',
				ownerUserId: owner.userId
			}),
			'create a private bill'
		).record;

		const stale = await updateBill(
			sql,
			owner,
			created.id,
			{ amount: 10 },
			'2020-01-01T00:00:00.000Z'
		);
		expect(failed(stale, 'save with a stale version').reason).toBe('conflict');

		// Saying "forbidden" would itself disclose that a private bill exists —
		// see base.ts's own header on why not_found covers both cases.
		expect(await getBill(sql, partner, created.id)).toBeNull();
		const asPartner = failed(await updateBill(sql, partner, created.id, { amount: 1 }), 'edit it');
		expect(asPartner.reason).toBe('not_found');
	});
});

describe('bill payments', () => {
	it('keeps a bill due on the 31st anchored through a short month and an unrelated edit', async () => {
		const bill = ok(
			await createBill(sql, owner, {
				name: 'Fictional Rent',
				amount: 1000,
				frequency: 'monthly',
				nextDueOn: '2026-01-31'
			}),
			'create'
		).record;
		expect(bill.dueDay).toBe(31);

		const february = ok(
			await recordBillPayment(sql, owner, bill.id, { paidOn: '2026-01-30' }),
			'pay January'
		).record;
		expect(february.bill.nextDueOn).toBe('2026-02-28');

		// The edit form resubmits the clamped date with every save: fixing the
		// amount must not re-anchor the bill on the 28th.
		const edited = ok(
			await updateBill(
				sql,
				owner,
				bill.id,
				{ amount: 1050, nextDueOn: '2026-02-28' },
				february.bill.updatedAt
			),
			'edit the amount'
		).record;
		expect(edited.dueDay).toBe(31);

		const march = ok(
			await recordBillPayment(sql, owner, bill.id, { paidOn: '2026-02-27' }),
			'pay February'
		).record;
		expect(march.bill.nextDueOn).toBe('2026-03-31');

		// Moving the date on purpose re-anchors it on the new day.
		const moved = ok(
			await updateBill(sql, owner, bill.id, { nextDueOn: '2026-04-15' }, march.bill.updatedAt),
			'move the due date'
		).record;
		expect(moved.dueDay).toBe(15);
	});

	it('marks a bill paid, defaulting the amount and date, and advances the due date by one period', async () => {
		const bill = ok(
			await createBill(sql, owner, {
				name: 'Fictional Streaming',
				amount: 15.99,
				frequency: 'monthly',
				nextDueOn: '2026-01-31',
				status: 'active'
			}),
			'create a bill'
		).record;

		const paid = ok(
			await recordBillPayment(sql, owner, bill.id, { paidOn: '2026-01-20' }),
			'mark it paid'
		).record;
		expect(paid.payment.amountPaid).toBe(15.99);
		expect(paid.payment.previousNextDueOn).toBe('2026-01-31');
		// The 31st clamped into February, the same rule the unit tests prove for
		// advanceDueDate directly.
		expect(paid.bill.nextDueOn).toBe('2026-02-28');

		const second = ok(
			await recordBillPayment(sql, owner, bill.id, {
				amountPaid: 17.99,
				paidOn: '2026-02-20',
				note: 'Price went up'
			}),
			'mark it paid again with an explicit amount'
		).record;
		expect(second.payment).toMatchObject({
			amountPaid: 17.99,
			paidOn: '2026-02-20',
			note: 'Price went up'
		});
		// Back on the 31st: the bill's due day, not February's clamped 28th, is
		// what each advance starts from (migration 0034).
		expect(second.bill.nextDueOn).toBe('2026-03-31');

		// Most recent PAID date first, not most recently recorded: the two
		// calls above were made in that order, and the list still leads with
		// the later paidOn.
		const history = await listBillPayments(sql, owner, bill.id);
		expect(history.map((p) => p.amountPaid)).toEqual([17.99, 15.99]);
	});

	it('defaults the date paid to today on the household’s clock', async () => {
		const bill = ok(
			await createBill(sql, owner, { name: 'Fictional Default Date', amount: 9.99 }),
			'create'
		).record;
		const today = await householdToday(sql, owner.householdId);
		const paid = ok(await recordBillPayment(sql, owner, bill.id, {}), 'mark it paid').record;
		expect(paid.payment.paidOn).toBe(today);
	});

	it('refuses to mark paid with no amount available at all', async () => {
		const bill = ok(
			await createBill(sql, owner, { name: 'Fictional Bill With No Amount' }),
			'create'
		).record;
		const result = failed(
			await recordBillPayment(sql, owner, bill.id, {}),
			'mark paid with nothing'
		);
		expect(result.reason).toBe('invalid');
	});

	it('undoes only the most recent payment, restoring the due date it replaced', async () => {
		const bill = ok(
			await createBill(sql, owner, {
				name: 'Fictional Utility',
				amount: 40,
				frequency: 'monthly',
				nextDueOn: '2026-05-01'
			}),
			'create'
		).record;
		const first = ok(
			await recordBillPayment(sql, owner, bill.id, { paidOn: '2026-04-28' }),
			'first payment'
		).record;
		expect(first.bill.nextDueOn).toBe('2026-06-01');
		const second = ok(
			await recordBillPayment(sql, owner, bill.id, { paidOn: '2026-05-30' }),
			'second payment'
		).record;
		expect(second.bill.nextDueOn).toBe('2026-07-01');

		// The older payment cannot be undone out of order: doing so would jump
		// the due date backwards past the newer payment's own effect.
		const refused = failed(
			await deleteBillPayment(sql, owner, bill.id, first.payment.id),
			'undo the older payment'
		);
		expect(refused.reason).toBe('invalid');

		const undone = ok(
			await deleteBillPayment(sql, owner, bill.id, second.payment.id),
			'undo the newest payment'
		).record;
		expect(undone.nextDueOn).toBe('2026-06-01');
		expect((await listBillPayments(sql, owner, bill.id)).map((p) => p.id)).toEqual([
			first.payment.id
		]);
	});

	it('undoes the payment entered last, even when it was backdated before an earlier entry', async () => {
		const bill = ok(
			await createBill(sql, owner, {
				name: 'Fictional Water',
				amount: 30,
				frequency: 'monthly',
				nextDueOn: '2026-05-01'
			}),
			'create'
		).record;
		const entered = ok(
			await recordBillPayment(sql, owner, bill.id, { paidOn: '2026-04-30' }),
			'the first payment entered'
		).record;
		// Catching up on the log: a payment for an EARLIER day, entered second.
		const backdated = ok(
			await recordBillPayment(sql, owner, bill.id, { paidOn: '2026-03-31' }),
			'a backdated payment'
		).record;
		expect(backdated.bill.nextDueOn).toBe('2026-07-01');

		// The first entry is no longer the newest link in the due-date chain,
		// though it is still the newest by date paid.
		const refused = failed(
			await deleteBillPayment(sql, owner, bill.id, entered.payment.id),
			'undo the payment entered first'
		);
		expect(refused.reason).toBe('invalid');

		const undone = ok(
			await deleteBillPayment(sql, owner, bill.id, backdated.payment.id),
			'undo the payment entered last'
		).record;
		expect(undone.nextDueOn).toBe('2026-06-01');
	});

	it('leaves next_due_on alone when the bill has no frequency, and null forever once one_off is paid', async () => {
		const irregular = ok(
			await createBill(sql, owner, { name: 'Fictional Irregular', nextDueOn: '2026-06-01' }),
			'create with no frequency'
		).record;
		const paidIrregular = ok(
			await recordBillPayment(sql, owner, irregular.id, { amountPaid: 5 }),
			'pay it'
		).record;
		expect(paidIrregular.bill.nextDueOn).toBe('2026-06-01');

		const oneOff = ok(
			await createBill(sql, owner, {
				name: 'Fictional One-off',
				frequency: 'one_off',
				nextDueOn: '2026-06-01',
				amount: 200
			}),
			'create a one-off'
		).record;
		const paidOneOff = ok(
			await recordBillPayment(sql, owner, oneOff.id, {}),
			'pay the one-off'
		).record;
		expect(paidOneOff.bill.nextDueOn).toBeNull();
	});

	it('cannot mark paid a bill the viewer cannot see', async () => {
		const bill = ok(
			await createBill(sql, owner, {
				name: 'Fictional Private Bill',
				visibility: 'private',
				ownerUserId: owner.userId,
				amount: 5
			}),
			'create'
		).record;
		const result = failed(
			await recordBillPayment(sql, partner, bill.id, {}),
			'mark it paid as partner'
		);
		expect(result.reason).toBe('not_found');
	});
});

describe('income', () => {
	it('requires at least one of expected or actual, and shows the difference once both are set', async () => {
		failed(
			await createIncomeEntry(sql, owner, { title: 'Fictional Income', receivedOn: '2026-09-15' }),
			'save with neither amount'
		);

		const created = ok(
			await createIncomeEntry(sql, owner, {
				title: 'Fictional Paycheque',
				source: 'Fictional Employer',
				expectedAmount: 2000,
				receivedOn: '2026-09-15'
			}),
			'create with only an expected amount'
		).record;
		expect(created.difference).toBeNull();

		const edited = ok(
			await updateIncomeEntry(sql, owner, created.id, { actualAmount: 1980.5 }, created.updatedAt),
			'record what actually arrived'
		).record;
		expect(edited.difference).toBe(-19.5);

		const list = await listIncomeEntries(sql, owner);
		expect(list.map((e) => e.title)).toEqual(['Fictional Paycheque']);
	});

	it('archives and restores, and is invisible to the other member when private', async () => {
		const created = ok(
			await createIncomeEntry(sql, owner, {
				title: 'Fictional Gift',
				actualAmount: 50,
				receivedOn: '2026-09-01',
				visibility: 'private',
				ownerUserId: owner.userId
			}),
			'create private'
		).record;
		expect(await getIncomeEntry(sql, partner, created.id)).toBeNull();
		expect(await listIncomeEntries(sql, partner)).toEqual([]);

		const archived = ok(
			await setIncomeEntryArchived(sql, owner, created.id, true),
			'archive'
		).record;
		expect(archived.archivedAt).not.toBeNull();
		const restored = ok(
			await setIncomeEntryArchived(sql, owner, created.id, false),
			'restore'
		).record;
		expect(restored.archivedAt).toBeNull();
	});

	it('sums expected and actual for one calendar month only, in SQL', async () => {
		await createIncomeEntry(sql, owner, {
			title: 'Fictional Paycheque 1',
			expectedAmount: 2000,
			actualAmount: 1980,
			receivedOn: '2026-09-01'
		});
		await createIncomeEntry(sql, owner, {
			title: 'Fictional Paycheque 2',
			expectedAmount: 2000,
			actualAmount: 2000,
			receivedOn: '2026-09-28'
		});
		// Outside the window: must not be counted.
		await createIncomeEntry(sql, owner, {
			title: 'Fictional Paycheque 3',
			expectedAmount: 2000,
			actualAmount: 2000,
			receivedOn: '2026-10-05'
		});

		const summary = await incomeSummaryForMonth(sql, owner, '2026-09-01', '2026-09-30');
		expect(summary).toMatchObject({ expectedTotal: 4000, actualTotal: 3980, count: 2 });
	});
});

describe('savings', () => {
	it('attaches a contribution to a goal it can read, and refuses one it cannot', async () => {
		const [goal] = await sql<{ id: string }[]>`
			insert into goals (household_id, title, created_by, updated_by)
			values (${owner.householdId}::uuid, 'Fictional Emergency Fund', ${owner.userId}::uuid, ${owner.userId}::uuid)
			returning id
		`;

		const created = ok(
			await createSavingsContribution(sql, owner, {
				title: 'Fictional Transfer',
				amount: 150,
				contributedOn: '2026-09-20',
				goalId: goal!.id
			}),
			'create toward a real goal'
		).record;
		expect(created.goalTitle).toBe('Fictional Emergency Fund');

		const noGoal = ok(
			await createSavingsContribution(sql, owner, {
				title: 'Fictional Loose Change',
				amount: 5,
				contributedOn: '2026-09-21'
			}),
			'create with no goal'
		).record;
		expect(noGoal.goalId).toBeNull();
		expect(noGoal.goalTitle).toBeNull();

		const missing = failed(
			await createSavingsContribution(sql, owner, {
				title: 'Fictional Ghost Goal',
				amount: 5,
				contributedOn: '2026-09-21',
				goalId: '00000000-0000-4000-8000-000000000000'
			}),
			'attach a goal that does not exist'
		);
		expect(missing.reason).toBe('not_found');

		const [privateGoal] = await sql<{ id: string }[]>`
			insert into goals (household_id, owner_user_id, visibility, title, created_by, updated_by)
			values (
				${partner.householdId}::uuid, ${partner.userId}::uuid, 'private', 'Fictional Partner Secret Goal',
				${partner.userId}::uuid, ${partner.userId}::uuid
			)
			returning id
		`;
		const blocked = failed(
			await createSavingsContribution(sql, owner, {
				title: 'Fictional Sneaky Contribution',
				amount: 5,
				contributedOn: '2026-09-21',
				goalId: privateGoal!.id
			}),
			'attach a goal owner cannot see'
		);
		expect(blocked.reason).toBe('not_found');

		const changedGoal = ok(
			await updateSavingsContribution(sql, owner, created.id, { goalId: null }, created.updatedAt),
			'detach the goal'
		).record;
		expect(changedGoal.goalId).toBeNull();
	});

	it('never shows the title of a goal the viewer cannot read, but still counts the money', async () => {
		const [privateGoal] = await sql<{ id: string }[]>`
			insert into goals (household_id, owner_user_id, visibility, title, created_by, updated_by)
			values (${partner.householdId}::uuid, ${partner.userId}::uuid, 'private',
			        'Fictional Secret Goal', ${partner.userId}::uuid, ${partner.userId}::uuid)
			returning id
		`;
		// Shared with the household (the default), but toward a private goal.
		const shared = ok(
			await createSavingsContribution(sql, partner, {
				title: 'Fictional Shared Transfer',
				amount: 75,
				contributedOn: '2026-09-10',
				goalId: privateGoal!.id
			}),
			'create toward their own private goal'
		).record;
		expect(shared.goalTitle).toBe('Fictional Secret Goal');

		const [seen] = await listSavingsContributions(sql, owner);
		expect(seen?.title).toBe('Fictional Shared Transfer');
		expect(seen?.goalTitle).toBeNull();

		const summary = await savingsSummary(sql, owner, '2026-09-01', '2026-09-30');
		expect(summary.total).toBe(75);
		expect(summary.perGoal).toEqual([]);
		expect((await savingsSummary(sql, partner, '2026-09-01', '2026-09-30')).perGoal).toEqual([
			{ goalId: privateGoal!.id, goalTitle: 'Fictional Secret Goal', total: 75 }
		]);
	});

	it('archives and restores a contribution', async () => {
		const created = ok(
			await createSavingsContribution(sql, owner, {
				title: 'Fictional Contribution',
				amount: 25,
				contributedOn: '2026-09-01'
			}),
			'create'
		).record;
		const archived = ok(
			await setSavingsContributionArchived(sql, owner, created.id, true),
			'archive'
		).record;
		expect(archived.archivedAt).not.toBeNull();
		expect(await listSavingsContributions(sql, owner)).toEqual([]);
		const restored = ok(
			await setSavingsContributionArchived(sql, owner, created.id, false),
			'restore'
		).record;
		expect(restored.archivedAt).toBeNull();
	});

	it('totals this month, all time, and per goal, in SQL', async () => {
		const [goalA] = await sql<{ id: string }[]>`
			insert into goals (household_id, title, created_by, updated_by)
			values (${owner.householdId}::uuid, 'Fictional Goal A', ${owner.userId}::uuid, ${owner.userId}::uuid)
			returning id
		`;
		const [goalB] = await sql<{ id: string }[]>`
			insert into goals (household_id, title, created_by, updated_by)
			values (${owner.householdId}::uuid, 'Fictional Goal B', ${owner.userId}::uuid, ${owner.userId}::uuid)
			returning id
		`;
		await createSavingsContribution(sql, owner, {
			title: 'A1',
			amount: 100,
			contributedOn: '2026-09-05',
			goalId: goalA!.id
		});
		await createSavingsContribution(sql, owner, {
			title: 'A2',
			amount: 50,
			contributedOn: '2026-08-05',
			goalId: goalA!.id
		});
		await createSavingsContribution(sql, owner, {
			title: 'B1',
			amount: 30,
			contributedOn: '2026-09-10',
			goalId: goalB!.id
		});
		await createSavingsContribution(sql, owner, {
			title: 'No goal',
			amount: 10,
			contributedOn: '2026-09-12'
		});

		const summary = await savingsSummary(sql, owner, '2026-09-01', '2026-09-30');
		expect(summary.total).toBe(190);
		expect(summary.thisMonth).toBe(140);
		expect(summary.perGoal.sort((a, b) => a.goalTitle.localeCompare(b.goalTitle))).toEqual([
			{ goalId: goalA!.id, goalTitle: 'Fictional Goal A', total: 150 },
			{ goalId: goalB!.id, goalTitle: 'Fictional Goal B', total: 30 }
		]);
	});
});

describe('through a client configured the way the app’s is', () => {
	// `$lib/server/db` hands its client to drizzle(), which replaces the
	// driver's timestamp serializers with pass-throughs: a JS Date sent as a
	// parameter then reaches the wire unconverted and throws, where a plain
	// test client (the `sql` used everywhere above) would silently convert it.
	// See health-measurements.test.ts's identical section for how "Add a
	// reading" once passed every test here while failing in production.
	it('creates and edits a bill, and marks it paid', async () => {
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createBill(appLike, owner, {
					name: 'Fictional Drizzle Bill',
					amount: 20,
					frequency: 'monthly',
					nextDueOn: '2026-09-30'
				}),
				'create through the app-like client'
			).record;
			const edited = ok(
				await updateBill(appLike, owner, created.id, { amount: 22 }, created.updatedAt),
				'edit through the app-like client'
			).record;
			expect(edited.amount).toBe(22);
			const paid = ok(
				await recordBillPayment(appLike, owner, created.id, {}),
				'mark paid through the app-like client'
			).record;
			expect(paid.bill.nextDueOn).toBe('2026-10-30');
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});

	it('creates and edits an income entry', async () => {
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createIncomeEntry(appLike, owner, {
					title: 'Fictional Drizzle Income',
					expectedAmount: 500,
					receivedOn: '2026-09-15'
				}),
				'create through the app-like client'
			).record;
			const edited = ok(
				await updateIncomeEntry(
					appLike,
					owner,
					created.id,
					{ actualAmount: 495 },
					created.updatedAt
				),
				'edit through the app-like client'
			).record;
			expect(edited.difference).toBe(-5);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});

	it('creates and edits a savings contribution', async () => {
		const appLike = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
		drizzle(appLike);
		try {
			const created = ok(
				await createSavingsContribution(appLike, owner, {
					title: 'Fictional Drizzle Savings',
					amount: 40,
					contributedOn: '2026-09-15'
				}),
				'create through the app-like client'
			).record;
			const edited = ok(
				await updateSavingsContribution(
					appLike,
					owner,
					created.id,
					{ amount: 45 },
					created.updatedAt
				),
				'edit through the app-like client'
			).record;
			expect(edited.amount).toBe(45);
		} finally {
			await appLike.end({ timeout: 5 });
		}
	});
});
