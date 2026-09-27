/**
 * What each shelf status is called on the page.
 *
 * Kept apart from `shelf.ts`, which imports the database: the New entry
 * form needs only these words, and importing them from `shelf.ts` pulled
 * `$lib/server/db` into the browser bundle, which SvelteKit refuses to build.
 */
export const SHELF_LABELS = {
	inbox: 'New',
	reading_list: 'Reading list',
	live: 'Kept',
	archived_read: 'Finished'
} as const;
