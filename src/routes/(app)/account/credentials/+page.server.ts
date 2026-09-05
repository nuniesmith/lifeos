import { fail, redirect } from '@sveltejs/kit';
import { changeCredentials } from '$lib/server/auth/service';
import { sql } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({
	mustChange: locals.user?.mustChangeCredentials ?? false,
	isBootstrap: locals.user?.isBootstrap ?? false,
	username: locals.user?.username ?? ''
});

export const actions: Actions = {
	default: async ({ request, locals, getClientAddress }) => {
		if (!locals.user) redirect(303, '/login');

		const form = await request.formData();
		const currentPassword = String(form.get('currentPassword') ?? '');
		const newPassword = String(form.get('newPassword') ?? '');
		const confirmPassword = String(form.get('confirmPassword') ?? '');
		const newUsername = String(form.get('newUsername') ?? '').trim();

		if (newPassword !== confirmPassword) {
			return fail(400, { error: 'The new passwords do not match.' });
		}

		const result = await changeCredentials(
			sql,
			locals.user.id,
			{
				currentPassword,
				newPassword,
				newUsername: newUsername && newUsername !== locals.user.username ? newUsername : undefined
			},
			{ sessionId: locals.sessionId ?? undefined, clientIp: getClientAddress() }
		);

		if (!result.ok) {
			const message = {
				invalid_current: 'That current password is not correct.',
				username_taken: 'That username is already taken.',
				weak_password: 'Use at least 12 characters.'
			}[result.reason];
			return fail(400, { error: message });
		}

		redirect(303, '/');
	}
};
