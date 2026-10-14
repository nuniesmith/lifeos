import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf, type Viewer } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import { addMonths, financeByMonth } from '$lib/server/repositories';

/**
 * Money by month (PACK4-002).
 *
 * Each month's income, bill payments and savings, summed exactly and scoped
 * as their own pages scope them: a member's private entry is not in the
 * other member's totals, another household's never is, archived income and
 * savings are left out, and a payment on an archived bill still counts.
 *
 * Every amount and date here is invented, in 2031 so nothing depends on today.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let owner: Viewer;
let partner: Viewer;
let householdId: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
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
			mustChangeCredentials: false,
			isBootstrap: false
		},
		householdId
	);
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

type Ownership = { household?: string; privateTo?: string; archived?: boolean };

const own = (o: Ownership) => ({
	household: o.household ?? householdId,
	visibility: o.privateTo ? 'private' : 'household',
	owner: o.privateTo ?? null,
	archived: o.archived ? new Date() : null
});

async function income(
	on: string,
	expected: number | null,
	actual: number | null,
	o: Ownership = {}
) {
	const w = own(o);
	await sql`
		insert into income_entries
			(household_id, visibility, owner_user_id, title, received_on,
			 expected_amount, actual_amount, archived_at)
		values (${w.household}::uuid, ${w.visibility}, ${w.owner}::uuid, 'Pay', ${on}::date,
		        ${expected}, ${actual}, ${w.archived})
	`;
}

async function bill(o: Ownership = {}) {
	const w = own(o);
	return one(
		await sql<{ id: string }[]>`
			insert into bills (household_id, visibility, owner_user_id, name, archived_at)
			values (${w.household}::uuid, ${w.visibility}, ${w.owner}::uuid, 'Internet', ${w.archived})
			returning id
		`
	).id;
}

const pay = (billId: string, on: string, amount: number) =>
	sql`insert into bill_payments (bill_id, paid_on, amount_paid)
	    values (${billId}::uuid, ${on}::date, ${amount})`;

async function save(on: string, amount: number, o: Ownership = {}) {
	const w = own(o);
	await sql`
		insert into savings_contributions
			(household_id, visibility, owner_user_id, title, amount, contributed_on, archived_at)
		values (${w.household}::uuid, ${w.visibility}, ${w.owner}::uuid, 'Rainy day', ${amount},
		        ${on}::date, ${w.archived})
	`;
}

describe('money by month', () => {
	it('sums each month exactly, newest first, with empty months as zeros', async () => {
		await income('2031-01-15', 2500, 2500.1);
		await income('2031-01-31', 100.2, null);
		await income('2031-03-01', 2500, 2400);
		const internet = await bill();
		await pay(internet, '2031-01-03', 79.99);
		await pay(internet, '2031-01-28', 0.02);
		await pay(internet, '2031-03-03', 79.99);
		await save('2031-01-20', 0.1);
		await save('2031-01-21', 0.2);

		const report = await financeByMonth(sql, owner, '2031-01', '2031-03');
		expect(report.currency).toBe('CAD');
		expect(report.months).toEqual([
			{
				month: '2031-03',
				incomeExpected: 2500,
				incomeReceived: 2400,
				billsPaid: 79.99,
				billPayments: 1,
				saved: 0
			},
			{
				month: '2031-02',
				incomeExpected: 0,
				incomeReceived: 0,
				billsPaid: 0,
				billPayments: 0,
				saved: 0
			},
			{
				// Summed in SQL: 0.1 + 0.2 is 0.3 here, not 0.30000000000000004.
				month: '2031-01',
				incomeExpected: 2600.2,
				incomeReceived: 2500.1,
				billsPaid: 80.01,
				billPayments: 2,
				saved: 0.3
			}
		]);
	});

	it('keeps a month to its own dates, at both ends', async () => {
		await save('2030-12-31', 5);
		await save('2031-01-01', 7);
		await save('2031-01-31', 11);
		await save('2031-02-01', 13);

		const { months } = await financeByMonth(sql, owner, '2031-01', '2031-01');
		expect(months.map((m) => [m.month, m.saved])).toEqual([['2031-01', 18]]);
	});

	it('leaves out the other member’s private entries, and another household’s', async () => {
		const [next] = await sql<{ id: string }[]>`
			insert into households (name) values ('Next door') returning id
		`;
		await income('2031-01-10', 1000, 1000, { privateTo: partner.userId });
		await income('2031-01-10', 50, 50, { household: next!.id });
		await pay(await bill({ privateTo: partner.userId }), '2031-01-10', 30);
		await pay(await bill({ household: next!.id }), '2031-01-10', 40);
		await save('2031-01-10', 20, { privateTo: partner.userId });
		await save('2031-01-10', 60, { household: next!.id });

		const [ownerSees] = (await financeByMonth(sql, owner, '2031-01', '2031-01')).months;
		expect(ownerSees).toMatchObject({ incomeReceived: 0, billsPaid: 0, billPayments: 0, saved: 0 });

		const [partnerSees] = (await financeByMonth(sql, partner, '2031-01', '2031-01')).months;
		expect(partnerSees).toMatchObject({
			incomeReceived: 1000,
			billsPaid: 30,
			billPayments: 1,
			saved: 20
		});
	});

	it('leaves out archived income and savings, but counts payments on an archived bill', async () => {
		await income('2031-01-10', 900, 900, { archived: true });
		await save('2031-01-10', 25, { archived: true });
		await pay(await bill({ archived: true }), '2031-01-10', 15);

		const [month] = (await financeByMonth(sql, owner, '2031-01', '2031-01')).months;
		expect(month).toMatchObject({ incomeReceived: 0, saved: 0, billsPaid: 15, billPayments: 1 });
	});

	it('refuses a range that is not one', async () => {
		await expect(financeByMonth(sql, owner, '2031-03', '2031-01')).rejects.toThrow(RangeError);
		await expect(financeByMonth(sql, owner, '2031-13', '2031-13')).rejects.toThrow(RangeError);
	});
});

describe('addMonths', () => {
	it('crosses year boundaries both ways', () => {
		expect(addMonths('2031-01', -1)).toBe('2030-12');
		expect(addMonths('2030-12', 1)).toBe('2031-01');
		expect(addMonths('2031-03', -11)).toBe('2030-04');
		expect(addMonths('2031-03', 24)).toBe('2033-03');
	});
});
