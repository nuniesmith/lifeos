import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	MEDIA_STATUSES,
	listMedia,
	setMediaStatus,
	type MediaStatus
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/** Entertainment — what is on, what is queued, what was good. */

const isStatus = (value: unknown): value is MediaStatus =>
	MEDIA_STATUSES.includes(String(value) as MediaStatus);

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const [watching, queued, watched] = await Promise.all([
		listMedia(sql, viewer, { status: 'watching', limit: 50 }),
		listMedia(sql, viewer, { status: 'want_to_watch', limit: 100 }),
		listMedia(sql, viewer, { status: ['watched', 'paused', 'dropped'], limit: 50 })
	]);
	return { watching, queued, watched };
};

export const actions: Actions = {
	setStatus: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const status = form.get('status');
		if (!isStatus(status)) return fail(400, { error: 'Not a status.' });

		const result = await setMediaStatus(sql, viewer, String(form.get('id') ?? ''), status);
		if (!result.ok) return fail(404, { error: 'Could not update that.' });
		return { updated: result.record.id };
	}
};
