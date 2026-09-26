import { addTag, goToDay, loadJournal, saveJournal, tagDay } from './entry';
import type { Actions, PageServerLoad } from './$types';

/**
 * The journal, opened on today (UI-009).
 *
 * `/journal` is not a redirect to `/journal/<today>`: a redirect would make
 * the browser's back button bounce straight forward again, which on a phone
 * reads as the app refusing to go back. It renders today directly instead, and
 * `/journal/[date]` renders any other day from the same module.
 */
export const load: PageServerLoad = ({ locals }) => loadJournal(locals, null);

export const actions: Actions = {
	save: ({ locals, request }) => saveJournal(locals, request),
	tag: ({ locals, request }) => tagDay(locals, request),
	addTag: ({ locals, request }) => addTag(locals, request),
	go: ({ locals, request }) => goToDay(locals, request)
};
