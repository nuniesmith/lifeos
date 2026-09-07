import { sql } from '$lib/server/db';
import { SEARCH_KINDS, isSearchable, search, type SearchKind } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * Household-scoped search (UI-010).
 *
 * A GET form rather than a POST action, so a search is a URL: it can be
 * bookmarked, shared between the two members — who will each see only what
 * they may see, because the scoping is in the query and not in the link — and
 * restored by the back button.
 */

const isKind = (value: string | null): value is SearchKind =>
	SEARCH_KINDS.includes((value ?? '') as SearchKind);

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);

	const term = url.searchParams.get('q')?.trim() ?? '';
	const kindParam = url.searchParams.get('kind');
	const kind = isKind(kindParam) ? kindParam : null;

	// An empty box is the page's resting state, not an error, and a single
	// character is a typo in progress rather than a query. Neither reaches the
	// database; `tooShort` distinguishes the two for the message.
	if (!isSearchable(term)) {
		return {
			term,
			kind,
			kinds: SEARCH_KINDS,
			hits: [],
			searched: false,
			tooShort: term.length === 1
		};
	}

	const hits = await search(sql, viewer, term, {
		limit: 60,
		...(kind ? { kinds: [kind] } : {})
	});

	return { term, kind, kinds: SEARCH_KINDS, hits, searched: true, tooShort: false };
};
