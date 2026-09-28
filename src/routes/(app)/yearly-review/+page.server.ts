import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	archiveEvent,
	createEvent,
	householdToday,
	listAreas,
	listAssessments,
	listEvents,
	unarchiveEvent,
	updateEvent,
	yearInReview,
	yearsOnRecord
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Reflect & Reset — the year in review.
 *
 * Every figure on this page is computed from what is already recorded rather
 * than read from a stored rollup. The source keeps these as formula columns on
 * a Years row, which means they are only as fresh as the last recalculation;
 * a query makes "total days logged" true by construction.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const years = await yearsOnRecord(sql, viewer);
	const requested = Number(url.searchParams.get('year'));
	const year =
		Number.isFinite(requested) && requested > 1900
			? requested
			: (years[0] ?? Number(today.slice(0, 4)));

	const [review, allEvents, assessments, areas] = await Promise.all([
		yearInReview(sql, viewer, year),
		// `includeArchived` plus a filter here, rather than a repository filter
		// of its own: this page is the one place that needs both halves of the
		// same scoped result — the live list and the ones an "Archived" toggle
		// can restore — and `projects.ts`'s own "archived" view answers the
		// same question the same way.
		listEvents(sql, viewer, {
			from: `${year}-01-01`,
			to: `${year}-12-31`,
			includeArchived: true,
			limit: 200
		}),
		listAssessments(sql, viewer, { year, limit: 100 }),
		listAreas(sql, viewer, { order: 'name', limit: 100 })
	]);

	return {
		year,
		years: years.length > 0 ? years : [year],
		review,
		events: allEvents.filter((e) => e.archivedAt === null),
		archivedEvents: allEvents.filter((e) => e.archivedAt !== null),
		assessments,
		areas: areas.map((a) => ({ id: a.id, name: a.name }))
	};
};

const str = (form: FormData, key: string): string => String(form.get(key) ?? '');
/** Absent stays `undefined` rather than `''`, which `updateEvent` would try to
 *  parse as a timestamp and throw on — see the note on that parameter. */
const optStr = (form: FormData, key: string): string | undefined => {
	const v = form.get(key);
	return v === null ? undefined : String(v);
};

export const actions: Actions = {
	addEvent: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createEvent(sql, viewer, {
			title: form.get('title'),
			onDate: form.get('onDate'),
			areaId: form.get('areaId') || null
		});
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { added: result.record.id };
	},

	updateEvent: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = str(form, 'id');

		const result = await updateEvent(
			sql,
			viewer,
			id,
			{
				title: form.get('title'),
				onDate: form.get('onDate'),
				areaId: form.get('areaId') || null,
				isFavourite: form.get('isFavourite'),
				notes: form.get('notes')
			},
			optStr(form, 'expectedUpdatedAt')
		);
		if (!result.ok) {
			const status = result.reason === 'invalid' ? 400 : result.reason === 'conflict' ? 409 : 404;
			const error =
				result.reason === 'invalid'
					? result.message
					: result.reason === 'conflict'
						? 'That event changed elsewhere — reload and try again.'
						: 'Could not update that event.';
			return fail(status, { action: 'updateEvent' as const, error });
		}
		return { action: 'updateEvent' as const, savedId: result.record.id };
	},

	/** One action for both directions, same as medications.ts's own
	 *  `archiveMedication`: the hidden `archived` field says which way, so
	 *  "Archive" on the edit sheet and "Restore" on the archived list can share
	 *  one handler instead of two nearly-identical ones. */
	archiveEvent: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = str(form, 'id');
		const archived = str(form, 'archived') === 'true';

		const result = archived
			? await archiveEvent(sql, viewer, id)
			: await unarchiveEvent(sql, viewer, id);
		if (!result.ok) {
			return fail(404, { action: 'archiveEvent' as const, error: 'Could not update that event.' });
		}
		return { action: 'archiveEvent' as const, archived };
	}
};
