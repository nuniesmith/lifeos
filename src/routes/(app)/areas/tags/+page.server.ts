import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Tags moved to /topics, where the workspace navigation has always said they
 * live — "Topics & Resources", under Knowledge rather than under Areas.
 *
 * This stays as a permanent redirect rather than being deleted: the old path
 * is in bookmarks and in the household's own links, and a dead URL is a worse
 * answer than a moved one.
 */
export const load: PageServerLoad = () => {
	redirect(308, '/topics');
};
