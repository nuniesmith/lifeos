import { goToDay, loadJournal, saveJournal } from '../entry';
import type { Actions, PageServerLoad } from './$types';

/**
 * One day of the journal (UI-009).
 *
 * The same editor, history and actions as `/journal`; only the day differs.
 * An unparseable date is refused by `loadJournal` as a 404 rather than
 * quietly falling back to today.
 */
export const load: PageServerLoad = ({ locals, params }) => loadJournal(locals, params.date);

export const actions: Actions = {
	save: ({ locals, request }) => saveJournal(locals, request),
	go: ({ locals, request }) => goToDay(locals, request)
};
