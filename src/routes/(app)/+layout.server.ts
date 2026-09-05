import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * The authenticated boundary. Everything under (app) is refused to anonymous
 * requests here, on the server — route grouping and hidden navigation are not
 * access control.
 */
export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		const next = url.pathname + url.search;
		redirect(303, `/login?next=${encodeURIComponent(next)}`);
	}

	// A bootstrap account may reach exactly one page until it has rotated its
	// credentials, so an unrotated first-run admin cannot be left in place.
	if (locals.user.mustChangeCredentials && !url.pathname.startsWith('/account/credentials')) {
		redirect(303, '/account/credentials');
	}

	return { user: locals.user };
};
