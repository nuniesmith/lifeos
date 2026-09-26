import { sql } from '$lib/server/db';
import {
	MAX_LIMIT,
	healthForLog,
	listHealthTerms,
	type HealthKind,
	type Viewer
} from '$lib/server/repositories';

/**
 * The health words a journal day can be tagged with (PACK3-001).
 *
 * `/health` counts how often each word came up; this is what lets a person
 * give it something to count without a Notion import. The words are the
 * household's `health_vocabulary`, the link is `daily_log_health`, and both
 * are written through `logHealthTerm` / `unlogHealthTerm`, which check in SQL
 * that the day is the viewer's own and the word is one they may use.
 *
 * ── Which lists the picker offers, and why not mood or energy ─────────────
 * Symptoms, activity and exercise. Each has no other home on a day, and each
 * is a many-per-day list of words, which is what a row of toggles is for.
 *
 * Mood and energy are also vocabulary kinds, but the day already records both
 * — as the editor's Energy scale (`daily_logs.energy_level`, one of 1-5) and
 * its Mood line (`daily_logs.mood`, a word or two) — and offering the words
 * here too would put two answers to one question on the same screen, with
 * only one of them counted and nothing saying which. The two are not
 * duplicates in the data today, they are disjoint by era:
 *
 *  - the importer never writes those columns. The Daily Log's Energy is a
 *    RELATION to the Energy Level list ("Balanced (…)"), not a number, and
 *    Mood/Feelings is a relation to the Mood list; both arrive as
 *    `daily_log_health` links (promote.ts, `daily_logs->health_vocabulary`).
 *    Every imported day has words and empty columns;
 *  - nothing in the app writes mood or energy links. Every day written here
 *    has columns and no such words.
 *
 * So the journal keeps its own two fields as THE way to record mood and
 * energy on a day, and the picker does not offer those lists. What an
 * imported day already carries is still shown (see `alsoLogged`), read-only,
 * so the day never hides what is recorded against it, and it still counts on
 * `/health` and in the year's dominant mood. Which of the two shapes should
 * win in the long run — the source's named lists, or the journal's scale and
 * line — is a data decision for the household, not one a picker should make
 * by quietly offering both.
 *
 * The same list is passed down to the repository as its `kinds`, so the
 * restriction holds for a hand-built request as well as for the page. The
 * retired `vitamin` kind is refused below that regardless (see
 * `offeredKinds` in health.ts).
 * ──────────────────────────────────────────────────────────────────────────
 */
export const JOURNAL_TAG_KINDS = [
	'symptom',
	'activity',
	'exercise'
] as const satisfies readonly HealthKind[];

export type JournalTagKind = (typeof JOURNAL_TAG_KINDS)[number];

export const isJournalTagKind = (value: unknown): value is JournalTagKind =>
	JOURNAL_TAG_KINDS.includes(value as JournalTagKind);

export interface JournalWord {
	id: string;
	name: string;
	tagged: boolean;
}

export interface JournalTagGroup {
	kind: JournalTagKind;
	/** Alphabetical, tagged or not, so a tap never moves the word tapped. */
	words: JournalWord[];
}

export interface JournalTags {
	groups: JournalTagGroup[];
	/**
	 * Words on this day from lists the picker does not offer — in practice the
	 * mood and energy an import linked. Shown so the day is complete, not
	 * editable here; see the note above {@link JOURNAL_TAG_KINDS}.
	 */
	alsoLogged: { id: string; kind: HealthKind; name: string }[];
}

const byName = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * The picker for one day: the household's live words in each offered list,
 * with the ones already on this day marked.
 *
 * `entryId` is null for a day with no entry yet, which has nothing tagged and
 * is not created by being looked at.
 */
export async function loadTags(viewer: Viewer, entryId: string | null): Promise<JournalTags> {
	const [live, logged] = await Promise.all([
		// Readable and not archived, in the offered lists only. MAX_LIMIT
		// rather than the default page: a household vocabulary is tens of
		// words (88 across every list in the source), and a picker that
		// silently drops the end of the alphabet would be worse than a long one.
		listHealthTerms(sql, viewer, { kind: JOURNAL_TAG_KINDS, limit: MAX_LIMIT }),
		entryId ? healthForLog(sql, viewer, entryId) : Promise.resolve([])
	]);

	const onDay = new Set(logged.map((term) => term.vocabularyId));

	const groups = JOURNAL_TAG_KINDS.map((kind) => {
		const words = new Map<string, JournalWord>();
		for (const term of live) {
			if (term.kind !== kind) continue;
			words.set(term.id, { id: term.id, name: term.name, tagged: onDay.has(term.id) });
		}
		// A word archived since it was tagged is no longer offered, but it is
		// still on this day: it stays visible there, and one tap removes it.
		for (const term of logged) {
			if (term.kind !== kind || words.has(term.vocabularyId)) continue;
			words.set(term.vocabularyId, { id: term.vocabularyId, name: term.name, tagged: true });
		}
		return { kind, words: [...words.values()].sort(byName) };
	});

	return {
		groups,
		alsoLogged: logged
			.filter((term) => !isJournalTagKind(term.kind))
			.map((term) => ({ id: term.vocabularyId, kind: term.kind, name: term.name }))
	};
}

/**
 * The id of the live word in `kind` spelled `name`, ignoring case and outer
 * space — the same test `createHealthTerm` uses to refuse a duplicate — or
 * null. Adding a word that is already on the list should tag that word, not
 * report an error the person then has to act on.
 */
export async function liveWordNamed(
	viewer: Viewer,
	kind: JournalTagKind,
	name: string
): Promise<string | null> {
	const wanted = name.trim().toLowerCase();
	if (!wanted) return null;
	// Compared here rather than with the repository's `search`, which is an
	// ILIKE: a name with a % or _ in it would be read as a pattern.
	const words = await listHealthTerms(sql, viewer, { kind, limit: MAX_LIMIT });
	return words.find((word) => word.name.trim().toLowerCase() === wanted)?.id ?? null;
}
