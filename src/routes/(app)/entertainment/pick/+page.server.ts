import { sql } from '$lib/server/db';
import {
	MEDIA_TYPES,
	mediaStreamingServices,
	pickMediaToWatch,
	type MediaType
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * "What should we watch?" (plan §13, feature 4): a random, unwatched
 * suggestion, optionally narrowed by type and streaming service, with
 * "Another" to re-roll under the same filters.
 */

const isMediaType = (value: unknown): value is MediaType =>
	MEDIA_TYPES.includes(String(value) as MediaType);

/** The bits of a suggestion the page actually shows -- not the whole record,
 *  so this route's action result stays a small, explicit shape rather than
 *  whatever the repository happens to return. */
function suggestionOf(item: Awaited<ReturnType<typeof pickMediaToWatch>>) {
	if (!item) return null;
	return {
		id: item.id,
		name: item.name,
		mediaType: item.mediaType,
		genre: item.genre,
		streamingService: item.streamingService,
		releaseYear: item.releaseYear
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);

	const [suggestion, streamingServices] = await Promise.all([
		pickMediaToWatch(sql, viewer, {}),
		mediaStreamingServices(sql, viewer)
	]);

	return {
		suggestion: suggestionOf(suggestion),
		mediaType: '',
		streamingService: '',
		mediaTypes: MEDIA_TYPES,
		streamingServices
	};
};

export const actions: Actions = {
	roll: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const mediaTypeRaw = form.get('mediaType');
		const mediaType = isMediaType(mediaTypeRaw) ? mediaTypeRaw : undefined;
		const streamingServiceRaw = form.get('streamingService');
		const streamingService =
			typeof streamingServiceRaw === 'string' && streamingServiceRaw
				? streamingServiceRaw
				: undefined;

		const suggestion = await pickMediaToWatch(sql, viewer, { mediaType, streamingService });

		return {
			suggestion: suggestionOf(suggestion),
			mediaType: mediaType ?? '',
			streamingService: streamingService ?? ''
		};
	}
};
