import { fail } from '@sveltejs/kit';
import {
	createMember,
	listMembers,
	resetCredential,
	setDisabled,
	setRole
} from '$lib/server/auth/admin';
import { requireAdmin } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

// Every household has exactly one row in this release; the import assigns
// records to it. Multi-household is not a supported configuration.
async function householdOf(userId: string): Promise<string> {
	const rows = await sql<{ household_id: string }[]>`
		select household_id from household_members where user_id = ${userId} limit 1
	`;
	const id = rows[0]?.household_id;
	if (!id) throw new Error('user belongs to no household');
	return id;
}

export const load: PageServerLoad = async ({ locals }) => {
	const admin = requireAdmin(locals.user);
	const householdId = await householdOf(admin.id);
	return { members: await listMembers(sql, householdId), me: admin.id };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const admin = requireAdmin(locals.user);
		const form = await request.formData();
		const result = await createMember(sql, admin.id, await householdOf(admin.id), {
			username: String(form.get('username') ?? ''),
			displayName: String(form.get('displayName') ?? ''),
			role: form.get('role') === 'admin' ? 'admin' : 'member'
		});

		if (!result.ok) {
			return fail(400, {
				error:
					result.reason === 'username_taken'
						? 'That username is already taken.'
						: 'Enter a username and a display name.'
			});
		}
		// Shown once so it can be handed over in person.
		return { created: { username: result.username, password: result.password } };
	},

	reset: async ({ request, locals }) => {
		const admin = requireAdmin(locals.user);
		const form = await request.formData();
		const { password } = await resetCredential(sql, admin.id, String(form.get('userId')));
		return { reset: { username: String(form.get('username')), password } };
	},

	disable: async ({ request, locals }) => {
		const admin = requireAdmin(locals.user);
		const form = await request.formData();
		const result = await setDisabled(
			sql,
			admin.id,
			String(form.get('userId')),
			form.get('disabled') === 'true'
		);
		if (!result.ok) {
			return fail(400, {
				error:
					result.reason === 'self'
						? 'You cannot disable your own account.'
						: 'There must be at least one active administrator.'
			});
		}
		return { done: true };
	},

	role: async ({ request, locals }) => {
		const admin = requireAdmin(locals.user);
		const form = await request.formData();
		const result = await setRole(
			sql,
			admin.id,
			String(form.get('userId')),
			form.get('role') === 'admin' ? 'admin' : 'member'
		);
		if (!result.ok) {
			return fail(400, { error: 'There must be at least one active administrator.' });
		}
		return { done: true };
	}
};
