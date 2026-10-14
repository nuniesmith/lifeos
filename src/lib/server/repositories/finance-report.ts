import type { Viewer } from '../auth/authz';
import { readableScope, toNumberOrNull, type Queryable } from './base';

/**
 * Money by month (PACK4-002): what /finance's glance shows for this month,
 * for each of a run of months, so a past month can be looked back on.
 *
 * Bills, income and savings, not a ledger — the household's own scope. Every
 * total is summed in SQL so it is exact (base.ts rule 1), and each source is
 * scoped as its own page scopes it: a private entry of the other member's is
 * not in these totals any more than it is in their lists.
 *
 * Archived income and savings are left out, as on /finance. A payment against
 * an archived bill still counts: the bill stopped, but the money was paid.
 */

export interface FinanceMonth {
	/** YYYY-MM. */
	month: string;
	incomeExpected: number;
	incomeReceived: number;
	billsPaid: number;
	/** How many payments `billsPaid` adds up. */
	billPayments: number;
	saved: number;
}

export interface FinanceReport {
	/** The household's currency; every amount here is in it. */
	currency: string;
	/** Newest month first. */
	months: FinanceMonth[];
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Whether `value` is a YYYY-MM month. */
export function isMonth(value: unknown): value is string {
	return typeof value === 'string' && MONTH_PATTERN.test(value);
}

/** `month` moved by `delta` months, both YYYY-MM. */
export function addMonths(month: string, delta: number): string {
	const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
	return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * The months from `from` to `to` inclusive (YYYY-MM), newest first, with a
 * row for every month in between even when nothing happened in it.
 */
export async function financeByMonth(
	sql: Queryable,
	viewer: Viewer,
	from: string,
	to: string
): Promise<FinanceReport> {
	if (!isMonth(from) || !isMonth(to) || from > to) {
		throw new RangeError(`not a month range: ${from}..${to}`);
	}

	const rows = await sql<
		{
			month: string;
			income_expected: string | null;
			income_received: string | null;
			bills_paid: string | null;
			bill_payments: number;
			saved: string | null;
		}[]
	>`
		with months as (
			select m::date as starts
			from generate_series(${`${from}-01`}::date, ${`${to}-01`}::date, interval '1 month') m
		),
		income as (
			select date_trunc('month', i.received_on)::date as starts,
			       sum(i.expected_amount) as expected, sum(i.actual_amount) as received
			from income_entries i
			where ${readableScope(sql, viewer, 'i')} and i.archived_at is null
			  and i.received_on >= ${`${from}-01`}::date
			  and i.received_on < (${`${to}-01`}::date + interval '1 month')
			group by 1
		),
		paid as (
			select date_trunc('month', p.paid_on)::date as starts,
			       sum(p.amount_paid) as total, count(*)::int as payments
			from bill_payments p
			join bills b on b.id = p.bill_id
			where ${readableScope(sql, viewer, 'b')}
			  and p.paid_on >= ${`${from}-01`}::date
			  and p.paid_on < (${`${to}-01`}::date + interval '1 month')
			group by 1
		),
		saved as (
			select date_trunc('month', s.contributed_on)::date as starts, sum(s.amount) as total
			from savings_contributions s
			where ${readableScope(sql, viewer, 's')} and s.archived_at is null
			  and s.contributed_on >= ${`${from}-01`}::date
			  and s.contributed_on < (${`${to}-01`}::date + interval '1 month')
			group by 1
		)
		select to_char(months.starts, 'YYYY-MM') as month,
		       income.expected as income_expected, income.received as income_received,
		       paid.total as bills_paid, coalesce(paid.payments, 0) as bill_payments,
		       saved.total as saved
		from months
		left join income using (starts)
		left join paid using (starts)
		left join saved using (starts)
		order by months.starts desc
	`;

	const [household] = await sql<{ currency: string }[]>`
		select currency from households where id = ${viewer.householdId}::uuid
	`;

	return {
		currency: household?.currency.trim() || 'CAD',
		months: rows.map((row) => ({
			month: row.month,
			incomeExpected: toNumberOrNull(row.income_expected) ?? 0,
			incomeReceived: toNumberOrNull(row.income_received) ?? 0,
			billsPaid: toNumberOrNull(row.bills_paid) ?? 0,
			billPayments: row.bill_payments,
			saved: toNumberOrNull(row.saved) ?? 0
		}))
	};
}
