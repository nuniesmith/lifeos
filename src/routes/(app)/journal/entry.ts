import { error, fail, redirect } from '@sveltejs/kit';
import {
	addDays,
	createDailyLog,
	createHealthTerm,
	getDailyLogForDate,
	getHealthTerm,
	imagesForPage,
	householdToday,
	isDay,
	listDailyLogs,
	logHealthTerm,
	unlogHealthTerm,
	updateDailyLog,
	type DailyLogInput,
	type DailyLogRecord,
	type Viewer
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import {
	JOURNAL_TAG_KINDS,
	isJournalTagKind,
	liveWordNamed,
	loadTags,
	type JournalTagKind,
	type JournalTags
} from './health-tags';

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
	/** The health words on this day, and the household's words to add. */
	tags: JournalTags;
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
	// entry's own page id, and the tags off its id, so there is nothing to ask
	// for until it is known.
	const [images, tags] = await Promise.all([
		imagesForPage(sql, viewer, entry?.notionPageId ?? null),
		loadTags(viewer, entry?.id ?? null)
	]);

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
		tags,
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

	const started = await startDay(viewer, date, fields);
	if (!started.ok) {
		// Another tab created the day between the check above and this write.
		// Its text has not been seen here, so this save must not land on it.
		if ('raced' in started) return fail(409, { error: RELOAD });
		return fail(started.status, { error: started.error });
	}
	return { saved: true, date };
}

type Started =
	| { ok: true; entry: DailyLogRecord }
	| { ok: false; raced: DailyLogRecord }
	| { ok: false; status: 400 | 403; error: string };

/**
 * Writes a day's entry for the first time.
 *
 * The one way a journal day comes into existence, whether the person saved
 * the editor or tagged the day before writing a word of it: both are
 * `createDailyLog` with the day's date, owned by the viewer and private by
 * its default, so a day that began as a tag is exactly the row a save would
 * have made and the editor simply edits it next.
 *
 * `raced` is the unique index refusing a create the caller's existence check
 * had just cleared — another tab won. What that means is the caller's call: a
 * save must not overwrite text it has not seen, while a tag can use the day.
 */
async function startDay(
	viewer: Viewer,
	date: string,
	fields: DailyLogInput = {}
): Promise<Started> {
	const result = await createDailyLog(sql, viewer, { ...fields, onDate: date });
	if (result.ok) return { ok: true, entry: result.record };

	if (result.reason === 'invalid') {
		const raced = await getDailyLogForDate(sql, viewer, date);
		if (raced) return { ok: false, raced };
		return { ok: false, status: 400, error: result.message ?? 'That entry is not valid.' };
	}
	return { ok: false, status: 403, error: 'You cannot write an entry for that day.' };
}

/**
 * The viewer's own entry for a day, started empty if there is none yet.
 *
 * For an action that needs the day to exist — tagging it — and never for a
 * load: opening a day must not create one, or every day a person merely
 * looked at would count as logged.
 */
async function openDay(
	viewer: Viewer,
	date: string
): Promise<{ ok: true; entry: DailyLogRecord } | { ok: false; status: 400 | 403; error: string }> {
	const existing = await getDailyLogForDate(sql, viewer, date);
	if (existing) return { ok: true, entry: existing };

	const started = await startDay(viewer, date);
	if (started.ok) return started;
	if ('raced' in started) return { ok: true, entry: started.raced };
	return started;
}

const WORD_GONE = 'That word is no longer on the list. Reload to see the current one.';

/**
 * Tags the day with one of the household's words, or takes it off (PACK3-001).
 *
 * The form names the day, never an entry id: the day is resolved to the
 * viewer's OWN entry here, so no field could point this at another member's
 * journal. The repository checks the same thing again in SQL, along with the
 * word being theirs to use and in a list the picker offers.
 *
 * Idempotent in both directions, like the habit check-in: `on` is the state
 * asked for rather than a flip, so a double tap lands on the row that is
 * already there, and removing a word that is not on the day leaves the day
 * as asked. Removing from a day with no entry touches nothing — it must not
 * create one. Adding to such a day starts the entry through the same path a
 * save does, but only once the word is known to be one that can be added, so
 * a stale or hand-built request does not leave an empty day behind it.
 */
export async function tagDay(locals: App.Locals, request: Request) {
	const viewer = await requireViewer(locals.user);
	const form = await request.formData();

	const date = String(form.get('date') ?? '');
	if (!isDay(date)) return fail(400, { tagError: 'That is not a date.' });
	const id = String(form.get('id') ?? '');

	if (form.get('on') !== 'true') {
		const entry = await getDailyLogForDate(sql, viewer, date);
		if (entry) await unlogHealthTerm(sql, viewer, entry.id, id, JOURNAL_TAG_KINDS);
		return { tag: { id, on: false, added: false } };
	}

	const word = await getHealthTerm(sql, viewer, id);
	if (!word || word.archivedAt || !isJournalTagKind(word.kind)) {
		return fail(404, { tagError: WORD_GONE });
	}
	return tagWith(viewer, date, word.id, word.kind, false);
}

/**
 * Adds a word to the household's list and tags the day with it, in one step.
 *
 * A word that is already on the list is tagged rather than refused: typing
 * "headache" when "Headache" exists means the person wants Headache on the
 * day, and an error telling them it exists would only send them looking for
 * it. A new word joins the shared list the way one added on `/health` does —
 * the list is the household's, what a person tags with it stays their own.
 */
export async function addTag(locals: App.Locals, request: Request) {
	const viewer = await requireViewer(locals.user);
	const form = await request.formData();

	const date = String(form.get('date') ?? '');
	if (!isDay(date)) return fail(400, { tagError: 'That is not a date.' });
	const kind = form.get('kind');
	if (!isJournalTagKind(kind)) {
		return fail(400, { tagError: 'Add a symptom, an activity or an exercise.' });
	}
	const name = form.get('name');

	const existing = typeof name === 'string' ? await liveWordNamed(viewer, kind, name) : null;
	if (existing) return tagWith(viewer, date, existing, kind, false);

	const created = await createHealthTerm(sql, viewer, { kind, name });
	if (!created.ok) {
		// The repository names its field; the person typed a word.
		const message = (created.message ?? 'that word could not be added').replace(
			/^name\b/,
			'the word'
		);
		return fail(created.reason === 'invalid' ? 400 : 403, {
			tagError: `${message.charAt(0).toUpperCase()}${message.slice(1)}.`,
			tagKind: kind
		});
	}
	return tagWith(viewer, date, created.record.id, kind, true);
}

/** Starts the day if need be, then links the word; shared by both actions. */
async function tagWith(
	viewer: Viewer,
	date: string,
	id: string,
	kind: JournalTagKind,
	added: boolean
) {
	const day = await openDay(viewer, date);
	if (!day.ok) return fail(day.status, { tagError: day.error, tagKind: kind });

	const result = await logHealthTerm(sql, viewer, day.entry.id, id, undefined, JOURNAL_TAG_KINDS);
	if (!result.ok) return fail(404, { tagError: WORD_GONE, tagKind: kind });
	return { tag: { id, on: true, added } };
}

/** The jump-to-a-day control. A redirect, so the URL matches what is shown. */
export async function goToDay(locals: App.Locals, request: Request) {
	await requireViewer(locals.user);
	const form = await request.formData();

	const date = String(form.get('date') ?? '');
	if (!isDay(date)) return fail(400, { error: 'That is not a date.' });

	redirect(303, `/journal/${date}`);
}
