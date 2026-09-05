import { fail, redirect } from '@sveltejs/kit';
import { login } from '$lib/server/auth/service';
import {
	SESSION_COOKIE,
	sessionCookieOptions,
	shouldUseSecureCookie
} from '$lib/server/auth/session';
import { env } from '$lib/server/env';
import { sql } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(303, '/');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, locals, getClientAddress }) => {
		const form = await request.formData();
		const username = String(form.get('username') ?? '');
		const password = String(form.get('password') ?? '');

		if (!username || !password) {
			return fail(400, { username, error: 'Enter a username and password.' });
		}

		const result = await login(
			sql,
			{ username, password },
			{ clientIp: getClientAddress(), userAgent: request.headers.get('user-agent') }
		);

		if (!result.ok) {
			// The same message for a wrong password and an unknown user: a
			// distinct one would confirm which usernames exist.
			const message =
				result.reason === 'locked'
					? 'Too many attempts. Try again later.'
					: result.reason === 'unavailable'
						? 'Sign-in is temporarily unavailable.'
						: result.reason === 'disabled'
							? 'This account is disabled.'
							: 'Incorrect username or password.';
			return fail(result.reason === 'unavailable' ? 503 : 401, { username, error: message });
		}

		cookies.set(
			SESSION_COOKIE,
			result.token,
			sessionCookieOptions(shouldUseSecureCookie(env.ORIGIN), result.expires)
		);
		locals.user = result.user;

		redirect(303, result.user.mustChangeCredentials ? '/account/credentials' : '/');
	}
};
