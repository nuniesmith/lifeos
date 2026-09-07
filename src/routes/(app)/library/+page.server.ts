import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { ENTRY_TYPES, touchLibraryItem, type EntryType } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import { loadShelf } from './shelf';
import type { Actions, PageServerLoad } from './$types';

/** Everything, filterable — the widest of the three views onto one table. */

const isType = (value: unknown): value is EntryType =>
	ENTRY_TYPES.includes(String(value) as EntryType);

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);

	const typeParam = url.searchParams.get('type');
	const entryType = isType(typeParam) ? typeParam : null;
	const search = url.searchParams.get('q')?.trim() || undefined;

	const shelf = await loadShelf(viewer, {
		...(entryType ? { entryType } : {}),
		...(search ? { search } : {}),
		order: 'title'
	});

	return { ...shelf, entryType, types: ENTRY_TYPES, search: search ?? '' };
};

export const actions: Actions = {
	touch: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await touchLibraryItem(sql, viewer, String(form.get('id') ?? ''));
		if (!result.ok) return fail(404, { error: 'Could not find that entry.' });
		return { touched: result.record.id };
	}
};
