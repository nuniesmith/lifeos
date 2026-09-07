import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	ARCHIVE_KINDS,
	archivedCounts,
	listArchived,
	restore,
	type ArchiveKind
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * The Archive.
 *
 * Deleting anywhere in LifeOS sets `archived_at` rather than removing a row.
 * This page is what makes that promise real: without somewhere to see what was
 * archived and put it back, "recoverable" is a claim nothing ever honours.
 */

const isKind = (value: unknown): value is ArchiveKind =>
	ARCHIVE_KINDS.includes(String(value) as ArchiveKind);

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);

	const kindParam = url.searchParams.get('kind');
	const kind = isKind(kindParam) ? kindParam : null;
	const search = url.searchParams.get('q')?.trim() || undefined;

	const [records, counts] = await Promise.all([
		listArchived(sql, viewer, {
			...(kind ? { kinds: [kind] } : {}),
			...(search ? { search } : {}),
			limit: 200
		}),
		archivedCounts(sql, viewer)
	]);

	const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
	return { records, counts, kind, kinds: ARCHIVE_KINDS, search: search ?? '', total };
};

export const actions: Actions = {
	restore: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const kind = form.get('kind');

		if (!isKind(kind)) return fail(400, { error: 'Not something that can be restored.' });

		const result = await restore(sql, viewer, kind, String(form.get('id') ?? ''));
		if (!result.ok) {
			return fail(result.reason === 'not_found' ? 404 : 400, {
				error: 'Could not restore that. It may already be back.'
			});
		}
		return { restored: result.record.id };
	}
};
