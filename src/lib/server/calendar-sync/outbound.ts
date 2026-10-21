import { createHash } from 'node:crypto';
import type { Viewer } from '../auth/authz';
import { toDate } from '../db/coerce';
import { liveScope, readableScope, type Queryable } from '../repositories/base';
import type { GoogleEventBody } from './google';

/**
 * What LifeOS writes to the push-target calendar: its own dated items, as
 * the Google events they should be (decided 2026-10-06):
 *  - a task on its do day, and on its deadline as "Due: …" (one event when
 *    those are the same day), until it is done or dropped;
 *  - a medical visit at its time, for an hour;
 *  - a bill on its next due date;
 *  - an important date, every year or month when it recurs.
 *
 * Read as the target calendar's owner (readableScope), so it holds the
 * household's items and that person's own private ones, and never anyone
 * else's private ones. Each event is keyed (kind:id[:part]) and hashed, so a
 * push sends only what changed, and the key travels in the event's private
 * extended properties, so reading the calendar back can tell LifeOS's events
 * from the person's own.
 *
 * All-day items don't mark the person busy and carry no reminders; a visit
 * does both, with the calendar's default reminders.
 */

export interface DesiredEvent {
	key: string;
	body: GoogleEventBody;
	hash: string;
}

export interface OutboundOptions {
	/** The household's today, 'YYYY-MM-DD'. */
	today: string;
	/** The household's zone, for visits. */
	zone: string;
	/** The app's external origin, for links back; null in development. */
	origin: string | null;
	currency: string;
}

/** Days before today an item still goes out, and days ahead. */
export const WINDOW_PAST_DAYS = 7;
export const WINDOW_AHEAD_DAYS = 365;

function addDays(day: string, n: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

function allDay(day: string): { date: string } {
	return { date: day };
}

function finish(
	key: string,
	body: Omit<GoogleEventBody, 'extendedProperties' | 'source'>,
	link: string,
	options: OutboundOptions
): DesiredEvent {
	const url = options.origin ? `${options.origin}${link}` : null;
	const full: GoogleEventBody = {
		...body,
		description: url ? `Added by LifeOS: ${url}` : 'Added by LifeOS.',
		...(url ? { source: { title: 'LifeOS', url } } : {}),
		extendedProperties: { private: { lifeosKey: key } }
	};
	return { key, body: full, hash: createHash('sha256').update(JSON.stringify(full)).digest('hex') };
}

const quiet = { transparency: 'transparent' as const, reminders: { useDefault: false } };

export async function desiredEvents(
	sql: Queryable,
	owner: Viewer,
	options: OutboundOptions
): Promise<Map<string, DesiredEvent>> {
	const from = addDays(options.today, -WINDOW_PAST_DAYS);
	const to = addDays(options.today, WINDOW_AHEAD_DAYS);
	const out = new Map<string, DesiredEvent>();
	const put = (e: DesiredEvent) => out.set(e.key, e);

	const [tasks, visits, bills, dates] = await Promise.all([
		sql<{ id: string; title: string; do_on: string | null; deadline_on: string | null }[]>`
			select t.id, t.title, t.do_on::text as do_on, t.deadline_on::text as deadline_on
			from tasks t
			where ${readableScope(sql, owner, 't')} and ${liveScope(sql, 't')}
			  and t.status in ('todo', 'in_progress', 'blocked')
			  and (t.do_on between ${from}::date and ${to}::date
			       or t.deadline_on between ${from}::date and ${to}::date)
		`,
		sql<{ id: string; reason: string; provider: string | null; visit_at: unknown }[]>`
			select v.id, v.reason, v.provider, v.visit_at
			from medical_visits v
			where ${readableScope(sql, owner, 'v')} and ${liveScope(sql, 'v')}
			  and (v.visit_at at time zone ${options.zone})::date between ${from}::date and ${to}::date
		`,
		sql<{ id: string; name: string; amount: string | null; next_due_on: string }[]>`
			select b.id, b.name, b.amount::text as amount, b.next_due_on::text as next_due_on
			from bills b
			where ${readableScope(sql, owner, 'b')} and ${liveScope(sql, 'b')}
			  and b.status in ('active', 'free_trial')
			  and b.next_due_on between ${from}::date and ${to}::date
		`,
		sql<{ id: string; title: string; on_date: string; recurrence: string }[]>`
			select d.id, d.title, d.on_date::text as on_date, d.recurrence
			from important_dates d
			where ${readableScope(sql, owner, 'd')} and ${liveScope(sql, 'd')}
			  and (d.recurrence in ('yearly', 'monthly') or d.on_date between ${from}::date and ${to}::date)
		`
	]);

	for (const t of tasks) {
		const inWindow = (day: string | null): day is string =>
			day !== null && day >= from && day <= to;
		if (inWindow(t.deadline_on)) {
			put(
				finish(
					`task:${t.id}:due`,
					{
						summary: `Due: ${t.title}`,
						start: allDay(t.deadline_on),
						end: allDay(addDays(t.deadline_on, 1)),
						...quiet
					},
					`/tasks/${t.id}`,
					options
				)
			);
		}
		if (inWindow(t.do_on) && t.do_on !== t.deadline_on) {
			put(
				finish(
					`task:${t.id}:do`,
					{ summary: t.title, start: allDay(t.do_on), end: allDay(addDays(t.do_on, 1)), ...quiet },
					`/tasks/${t.id}`,
					options
				)
			);
		}
	}

	for (const v of visits) {
		const at = toDate(v.visit_at);
		const end = new Date(at.getTime() + 60 * 60 * 1000);
		put(
			finish(
				`visit:${v.id}`,
				{
					summary: v.provider ? `Visit: ${v.reason} (${v.provider})` : `Visit: ${v.reason}`,
					start: { dateTime: at.toISOString(), timeZone: options.zone },
					end: { dateTime: end.toISOString(), timeZone: options.zone },
					transparency: 'opaque',
					reminders: { useDefault: true }
				},
				`/health/visits/${v.id}`,
				options
			)
		);
	}

	for (const b of bills) {
		const amount = b.amount ? ` (${b.amount} ${options.currency})` : '';
		put(
			finish(
				`bill:${b.id}`,
				{
					summary: `Bill due: ${b.name}${amount}`,
					start: allDay(b.next_due_on),
					end: allDay(addDays(b.next_due_on, 1)),
					...quiet
				},
				'/finance/bills',
				options
			)
		);
	}

	for (const d of dates) {
		const rule =
			d.recurrence === 'yearly'
				? 'RRULE:FREQ=YEARLY'
				: d.recurrence === 'monthly'
					? 'RRULE:FREQ=MONTHLY'
					: null;
		put(
			finish(
				`date:${d.id}`,
				{
					summary: d.title,
					start: allDay(d.on_date),
					end: allDay(addDays(d.on_date, 1)),
					...(rule ? { recurrence: [rule] } : {}),
					...quiet
				},
				'/calendar',
				options
			)
		);
	}

	return out;
}
