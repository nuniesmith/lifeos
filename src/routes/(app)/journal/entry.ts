import { error, fail, redirect } from '@sveltejs/kit';
import {
	addDays,
	createDailyLog,
	getDailyLogForDate,
	imagesForPage,
	householdToday,
	isDay,
	listDailyLogs,
	updateDailyLog
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';

/**
 * The journal, shared by `/journal` (today) and `/journal/[date]` (any day).
 *
 * Both routes render the same editor and the same history, so the load and the
 * actions live here rather than being written twice and drifting. The only
 * difference between them is where the day comes from.
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 * A daily log is `private` by default and nothing here widens it: no
 * visibility control is offered, none is accepted from the form, and the
 * history is filtered to the viewer's own entries. `readableScope` already
 * refuses another member's private rows in SQL — including an admin's read,
 * which is deliberate (see auth/authz.ts). This module simply never asks for
 * anything broader, so there is no path by which the page could show one
 * member another's journal.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** How many past entries the history list carries. */
const HISTORY_LIMIT = 60;

/** The entry as the editor needs it: strings for inputs, nulls flattened. */
export interface JournalEntry {
	id: string;
	/** ISO, not a Date. A Date rendered into a hidden input loses its
	    milliseconds, and the version precondition then never matches. */
	updatedAt: string;
	note: string;
	energyLevel: number | null;
	mood: string;
	gratitude: string;
	highlight: string;
}

export interface JournalHistoryItem {
	id: string;
	date: string;
	/** The first thing worth recognising the day by. */
	summary: string;
}

export interface JournalData {
	/** Today in the household's timezone, not the server's. */
	today: string;
	date: string;
	entry: JournalEntry | null;
	/**
	 * Pictures that came in on this day's Notion page.
	 *
	 * The import has always stored these; nothing displayed them. Eight of the
	 * twenty-five imported days have one.
	 */
	images: { id: string; width: number | null; height: number | null; alt: string }[];
	previous: string;
	/** Null on today: a journal is written after the day, not before it. */
	next: string | null;
	history: JournalHistoryItem[];
}

/** One short line to recognise a past day by, without opening it. */
function summarise(entry: {
	highlight: string | null;
	note: string | null;
	gratitude: string | null;
	mood: string | null;
}): string {
	const source = entry.highlight ?? entry.note ?? entry.gratitude ?? entry.mood ?? '';
	const flat = source.replace(/\s+/g, ' ').trim();
	return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

/**
 * The editor and the history for one day.
 *
 * `requested` is null on `/journal`, which means today. An unparseable day is
 * a 404 rather than a silent fallback to today: a mistyped URL that quietly
 * shows a different day is how someone writes into the wrong date.
 */
export async function loadJournal(
	locals: App.Locals,
	requested: string | null
): Promise<JournalData> {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	if (requested !== null && !isDay(requested)) error(404, 'Not a date');
	const date = requested ?? today;

	const [entry, history] = await Promise.all([
		getDailyLogForDate(sql, viewer, date),
		listDailyLogs(sql, viewer, {
			// The viewer's own days only. A household-visible entry of the
			// other member's is readable, but it is not *this* person's
			// journal and listing it here would make the history lie.
			ownerUserId: viewer.userId,
			order: 'newest',
			limit: HISTORY_LIMIT
		})
	]);

	// Sequenced after the entry rather than beside it: the images hang off the
	// entry's own page id, so there is nothing to ask for until it is known.
	const images = await imagesForPage(sql, viewer, entry?.notionPageId ?? null);

	return {
		today,
		date,
		images: images.map((image) => ({
			id: image.id,
			width: image.width,
			height: image.height,
			// The original filename is the only description the export carries.
			// Empty rather than invented: a wrong alt is worse than none.
			alt: image.originalName ? image.originalName.replace(/\.[a-z0-9]+$/i, '') : ''
		})),
		entry: entry
			? {
					id: entry.id,
					updatedAt: entry.updatedAt.toISOString(),
					note: entry.note ?? '',
					energyLevel: entry.energyLevel,
					mood: entry.mood ?? '',
					gratitude: entry.gratitude ?? '',
					highlight: entry.highlight ?? ''
				}
			: null,
		previous: addDays(date, -1),
		next: date < today ? addDays(date, 1) : null,
		history: history.map((row) => ({
			id: row.id,
			date: row.onDate,
			summary: summarise(row)
		}))
	};
}

const RELOAD = 'An entry for that day was written somewhere else. Reload the page to edit it.';

/**
 * Saves the day, creating or editing as required.
 *
 * One entry per person per day is a database constraint, so an existing entry
 * is never an error to report — it is simply the thing being edited. The day
 * travels in the form rather than being recomputed from the clock, so a page
 * opened before midnight and saved after still writes to the day it showed.
 */
export async function saveJournal(locals: App.Locals, request: Request) {
	const viewer = await requireViewer(locals.user);
	const form = await request.formData();

	const date = String(form.get('date') ?? '');
	if (!isDay(date)) return fail(400, { error: 'That is not a date.' });

	const fields = {
		note: form.get('note'),
		energyLevel: form.get('energyLevel'),
		mood: form.get('mood'),
		gratitude: form.get('gratitude'),
		highlight: form.get('highlight')
	};

	const existing = await getDailyLogForDate(sql, viewer, date);

	if (existing) {
		const version = String(form.get('updatedAt') ?? '');
		// No version means the form was rendered when there was no entry. It
		// cannot be a safe edit of one that has appeared since, so it is
		// refused rather than allowed to overwrite unseen text.
		if (!version) return fail(409, { error: RELOAD });

		const result = await updateDailyLog(sql, viewer, existing.id, fields, version);
		if (!result.ok) {
			if (result.reason === 'conflict') {
				return fail(409, {
					error: 'This entry changed elsewhere. Reload to see the current version.'
				});
			}
			if (result.reason === 'invalid') return fail(400, { error: result.message });
			return fail(403, { error: 'You cannot change this entry.' });
		}
		return { saved: true, date };
	}

	const result = await createDailyLog(sql, viewer, { ...fields, onDate: date });
	if (!result.ok) {
		// The unique index is the only thing that can refuse a create the
		// existence check just cleared, and that means another tab won the
		// race. Say so, rather than reporting "already exists" as a fault.
		if (result.reason === 'invalid' && (await getDailyLogForDate(sql, viewer, date))) {
			return fail(409, { error: RELOAD });
		}
		if (result.reason === 'invalid') return fail(400, { error: result.message });
		return fail(403, { error: 'You cannot write an entry for that day.' });
	}
	return { saved: true, date };
}

/** The jump-to-a-day control. A redirect, so the URL matches what is shown. */
export async function goToDay(locals: App.Locals, request: Request) {
	await requireViewer(locals.user);
	const form = await request.formData();

	const date = String(form.get('date') ?? '');
	if (!isDay(date)) return fail(400, { error: 'That is not a date.' });

	redirect(303, `/journal/${date}`);
}
