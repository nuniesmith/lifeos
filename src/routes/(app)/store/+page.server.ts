import { requireViewer } from '$lib/server/viewer';
import { areaWorkspace } from './workspace-area';
import type { PageServerLoad } from './$types';

/** Etsy Store — the area's real work, since the source dashboard is empty. */
export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	return areaWorkspace(viewer, ['etsy', 'store', 'shop']);
};
