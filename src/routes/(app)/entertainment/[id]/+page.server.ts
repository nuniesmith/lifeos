import { error, fail } from '@sveltejs/kit';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import {
	MEDIA_STATUSES,
	MEDIA_TYPES,
	coversForPages,
	getMediaItem,
	householdToday,
	listMediaViewings,
	logMediaViewing,
	mediaStreamingServices,
	setMediaItemArchived,
	setMediaStatus,
	updateMediaItem,
	type MediaStatus,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One title: every field, its progress, and the history of when it was
 * actually watched (plan §13, features 2 and 3).
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	// Archived titles load too: the Archive links here, and this is where one
	// is looked at before it is brought back.
	const item = await getMediaItem(sql, viewer, params.id);
	// 404 rather than 403 for someone else's private title: saying that it
	// exists is itself the disclosure.
	if (!item) error(404, 'Title not found');

	const [viewings, covers, today, streamingServices] = await Promise.all([
		listMediaViewings(sql, viewer, item.id),
		coversForPages(sql, viewer, [item.notionPageId], 'display'),
		householdToday(sql, viewer.householdId),
		mediaStreamingServices(sql, viewer)
	]);
	const cover = (item.notionPageId && covers.get(item.notionPageId)) || null;

	return {
		item,
		cover: cover ? { id: cover.id, width: cover.width, height: cover.height } : null,
		// Who logged each viewing, without naming anyone: a two-person
		// household only ever needs to tell "me" apart from "not me".
		viewings: viewings.map((v) => ({ ...v, loggedByMe: v.loggedBy === viewer.userId })),
		today,
		streamingServices,
		mediaTypes: MEDIA_TYPES,
		statuses: MEDIA_STATUSES,
		// Presentation only: every action below is refused in SQL for someone
		// who may not write this title, whatever the page offered them.
		canEdit: canWrite(item, viewer)
	};
};

type Action = 'save' | 'setStatus' | 'archive' | 'logViewing';

/** One refusal wording per reason, matching the pattern in
 *  food/recipes/[id] -- see that page for why each one reads as it does. */
function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This title changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this title.' });
		default:
			return fail(404, { action, error: 'Could not find that title.' });
	}
}

const isStatus = (value: unknown): value is MediaStatus =>
	MEDIA_STATUSES.includes(String(value) as MediaStatus);

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateMediaItem(
			sql,
			viewer,
			params.id,
			{
				name: form.get('name'),
				mediaType: form.get('mediaType'),
				status: form.get('status'),
				genre: form.get('genre'),
				streamingService: form.get('streamingService'),
				releaseYear: form.get('releaseYear'),
				totalSeasons: form.get('totalSeasons'),
				currentSeason: form.get('currentSeason'),
				currentEpisode: form.get('currentEpisode'),
				rating: form.get('rating'),
				whySaved: form.get('whySaved'),
				// An unchecked checkbox is simply absent from the submitted form,
				// so the value sent here is always a real true/false rather than
				// leaving updateMediaItem to guess what "not present" meant.
				isFavourite: form.get('isFavourite') === 'on',
				watchAgain: form.get('watchAgain') === 'on',
				startedOn: form.get('startedOn'),
				finishedOn: form.get('finishedOn')
			},
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refused('save', result);
		return { action: 'save' as const, saved: true };
	},

	/** The same quick queue actions /entertainment offers, reusing setMediaStatus
	 *  so "Start watching" / "Finished" here bump times_watched exactly as they
	 *  do there -- see collections.ts on why the full edit above does not. */
	setStatus: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const status = form.get('status');
		if (!isStatus(status))
			return fail(400, { action: 'setStatus' as const, error: 'Not a status.' });

		const result = await setMediaStatus(sql, viewer, params.id, status);
		if (!result.ok) return refused('setStatus', result);
		return { action: 'setStatus' as const };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setMediaItemArchived(sql, viewer, params.id, archived);
		if (!result.ok) return refused('archive', result);
		return { action: 'archive' as const, archived };
	},

	logViewing: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await logMediaViewing(sql, viewer, params.id, {
			watchedOn: form.get('watchedOn'),
			season: form.get('season'),
			episode: form.get('episode'),
			note: form.get('note')
		});
		if (!result.ok) return refused('logViewing', result);
		return { action: 'logViewing' as const, logged: true };
	}
};
