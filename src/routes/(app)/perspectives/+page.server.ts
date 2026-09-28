import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	archiveAssessment,
	assessmentPeriods,
	createAssessment,
	listAreas,
	listAssessments,
	unarchiveAssessment,
	updateAssessment
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Perspectives — the wheel of life.
 *
 * A periodic self-rating of each area, lowest first, because the point of the
 * exercise is to see what is being neglected rather than to admire what is
 * going well.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const yearParam = Number(url.searchParams.get('year'));
	const year = Number.isFinite(yearParam) && yearParam > 1900 ? yearParam : undefined;

	const [allAssessments, periods, areas] = await Promise.all([
		// `includeArchived` plus a filter here, rather than a repository filter
		// of its own: this page needs both halves of the same scoped result —
		// the live wheel and the ones an "Archived" toggle can restore — the
		// same idiom `projects.ts`'s own "archived" view uses.
		listAssessments(sql, viewer, { ...(year ? { year } : {}), includeArchived: true, limit: 200 }),
		assessmentPeriods(sql, viewer),
		listAreas(sql, viewer, { order: 'name', limit: 100 })
	]);
	const assessments = allAssessments.filter((a) => a.archivedAt === null);
	const archivedAssessments = allAssessments.filter((a) => a.archivedAt !== null);

	const average =
		assessments.length > 0
			? Math.round((assessments.reduce((s, a) => s + a.rating, 0) / assessments.length) * 10) / 10
			: null;

	return {
		assessments,
		archivedAssessments,
		periods,
		year: year ?? null,
		average,
		areas: areas.map((a) => ({ id: a.id, name: a.name }))
	};
};

const str = (form: FormData, key: string): string => String(form.get(key) ?? '');
/** Absent stays `undefined` rather than `''`, which `updateAssessment` would
 *  try to parse as a timestamp and throw on — see the note on that parameter. */
const optStr = (form: FormData, key: string): string | undefined => {
	const v = form.get(key);
	return v === null ? undefined : String(v);
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createAssessment(sql, viewer, {
			focus: form.get('focus'),
			rating: form.get('rating'),
			period: form.get('period'),
			year: form.get('year'),
			areaId: form.get('areaId') || null
		});
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { added: result.record.id };
	},

	update: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = str(form, 'id');

		const result = await updateAssessment(
			sql,
			viewer,
			id,
			{
				focus: form.get('focus'),
				rating: form.get('rating'),
				period: form.get('period'),
				year: form.get('year'),
				areaId: form.get('areaId') || null,
				isPriority: form.get('isPriority'),
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
						? 'That rating changed elsewhere — reload and try again.'
						: 'Could not update that rating.';
			return fail(status, { action: 'update' as const, error });
		}
		return { action: 'update' as const, savedId: result.record.id };
	},

	/** One action for both directions, same as medications.ts's own
	 *  `archiveMedication`: the hidden `archived` field says which way, so
	 *  "Archive" on the edit sheet and "Restore" on the archived list can share
	 *  one handler instead of two nearly-identical ones. */
	archive: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = str(form, 'id');
		const archived = str(form, 'archived') === 'true';

		const result = archived
			? await archiveAssessment(sql, viewer, id)
			: await unarchiveAssessment(sql, viewer, id);
		if (!result.ok) {
			return fail(404, { action: 'archive' as const, error: 'Could not update that rating.' });
		}
		return { action: 'archive' as const, archived };
	}
};
