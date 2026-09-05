import { json } from '@sveltejs/kit';
import {
	createDailyLog,
	createTask,
	getDailyLogForDate,
	updateDailyLog
} from '$lib/server/repositories';
import { householdToday } from '$lib/server/repositories/base';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import type { RequestHandler } from './$types';

/**
 * Quick capture (UI-003).
 *
 * One box, reachable with a thumb, that puts a thought somewhere sensible
 * without making you choose a destination first. The point is that capture
 * never fails for want of a decision — triage happens later, on the list.
 */

const KINDS = ['task', 'note', 'journal'] as const;
type Kind = (typeof KINDS)[number];

const isKind = (value: unknown): value is Kind =>
	typeof value === 'string' && (KINDS as readonly string[]).includes(value);

export const POST: RequestHandler = async ({ locals, request }) => {
	const viewer = await requireViewer(locals.user);

	let body: { kind?: unknown; title?: unknown; detail?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Expected JSON.' }, { status: 400 });
	}

	const title = typeof body.title === 'string' ? body.title.trim() : '';
	const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
	if (!title) return json({ error: 'Give it a title.' }, { status: 400 });

	const kind: Kind = isKind(body.kind) ? body.kind : 'task';

	if (kind === 'journal') {
		// Appended, never replaced. Quick capture is used repeatedly through a
		// day, and overwriting what was already written would lose the earlier
		// thought — the opposite of what a capture box is for.
		const today = await householdToday(sql, viewer.householdId);
		const existing = await getDailyLogForDate(sql, viewer, today, viewer.userId);
		const line = detail ? `${title}\n${detail}` : title;

		if (existing) {
			const note = existing.note ? `${existing.note}\n\n${line}` : line;
			const result = await updateDailyLog(sql, viewer, existing.id, { note }, existing.updatedAt);
			if (!result.ok) {
				return json(
					{ error: 'That entry changed elsewhere. Open the journal and add it there.' },
					{ status: result.reason === 'conflict' ? 409 : 400 }
				);
			}
			return json({ ok: true, kind, id: result.record.id });
		}

		const created = await createDailyLog(sql, viewer, { onDate: today, note: line });
		if (!created.ok) return json({ error: 'Could not save that.' }, { status: 400 });
		return json({ ok: true, kind, id: created.record.id });
	}

	// A note is a task with no date: it lands in the list to be triaged rather
	// than becoming a second kind of record with nowhere to appear.
	const result = await createTask(sql, viewer, {
		title,
		notes: detail || undefined,
		...(kind === 'note' ? { context: 'inbox' } : {})
	});

	if (!result.ok) {
		return json(
			{ error: result.reason === 'invalid' ? result.message : 'Could not save that.' },
			{ status: result.reason === 'invalid' ? 400 : 403 }
		);
	}
	return json({ ok: true, kind, id: result.record.id });
};
