import { fail } from '@sveltejs/kit';
import {
	createTag,
	listAreas,
	listGoals,
	listHabits,
	listProjects,
	listTags,
	listTasks,
	setTagArchived,
	tagsForEntity,
	type TaggableType
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import { version } from '../projects/planning';
import type { Actions, PageServerLoad } from './$types';

/**
 * Tags, and what carries them (UI-007).
 *
 * Tags belong to the household rather than to a person, and they cut across the
 * structure — a tag is how "the cabin" ends up meaning one thing on a project,
 * an area and a dozen tasks. This page is the only place that shows the cut.
 *
 * ── How the carriers are found ─────────────────────────────────────────────
 * The repositories index this relation in one direction per record type. Tasks
 * can be asked for by tag (`listTasks({ tagId })`), so they are — one query per
 * tag. Projects, goals, areas and habits expose the opposite direction
 * (`tagsForEntity`), so each record is asked for its own tags and the result is
 * inverted here. That is a query per record, which is why every list is capped:
 * a household's planning records number in the dozens, and the caps stop a
 * pathological workspace turning this page into hundreds of round trips.
 *
 * Daily logs can carry tags too and are deliberately not scanned: a daily log
 * is private to its author, and a household-wide page that listed one — even by
 * title — would be a privacy leak dressed as a convenience.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** How many records of each type are scanned for tags. */
const SCAN_LIMIT = 100;
/** How many tagged tasks are listed per tag. */
const TASK_LIMIT = 50;

export interface Carrier {
	id: string;
	name: string;
	kind: TaggableType;
	/** A raw application path; the anchor resolves it. */
	href: string;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const showArchived = url.searchParams.get('view') === 'archived';

	const all = await listTags(sql, viewer, { includeArchived: showArchived, limit: 200 });
	const tags = showArchived ? all.filter((tag) => tag.archivedAt !== null) : all;

	// An archived tag is out of use, so nothing is scanned for it: the archived
	// view exists to bring one back, not to report what it holds.
	if (tags.length === 0 || showArchived) {
		return {
			showArchived,
			tags: tags.map((tag) => ({
				id: tag.id,
				name: tag.name,
				updatedAt: tag.updatedAt,
				archived: tag.archivedAt !== null,
				carriers: [] as Carrier[],
				total: 0
			}))
		};
	}

	const [areas, goals, projects, habits] = await Promise.all([
		listAreas(sql, viewer, { limit: SCAN_LIMIT }),
		listGoals(sql, viewer, { limit: SCAN_LIMIT }),
		listProjects(sql, viewer, { limit: SCAN_LIMIT }),
		listHabits(sql, viewer, { limit: SCAN_LIMIT })
	]);

	const records: Carrier[] = [
		...areas.map((a): Carrier => ({
			id: a.id,
			name: a.name,
			kind: 'area',
			href: `/areas/${a.id}`
		})),
		...goals.map((g): Carrier => ({
			id: g.id,
			name: g.title,
			kind: 'goal',
			href: `/goals/${g.id}`
		})),
		...projects.map((p): Carrier => ({
			id: p.id,
			name: p.name,
			kind: 'project',
			href: `/projects/${p.id}`
		})),
		...habits.map((h): Carrier => ({
			id: h.id,
			name: h.name,
			kind: 'habit',
			href: `/habits/${h.id}`
		}))
	];

	const [recordTags, taggedTasks] = await Promise.all([
		Promise.all(records.map((record) => tagsForEntity(sql, viewer, record.kind, record.id))),
		Promise.all(tags.map((tag) => listTasks(sql, viewer, { tagId: tag.id, limit: TASK_LIMIT })))
	]);

	const byTag = new Map<string, Carrier[]>();
	recordTags.forEach((attached, index) => {
		const record = records[index];
		if (!record) return;
		for (const tag of attached) {
			const carriers = byTag.get(tag.id) ?? [];
			carriers.push(record);
			byTag.set(tag.id, carriers);
		}
	});

	return {
		showArchived,
		tags: tags.map((tag, index) => {
			const carriers = [
				...(byTag.get(tag.id) ?? []),
				...(taggedTasks[index] ?? []).map((task): Carrier => ({
					id: task.id,
					name: task.title,
					kind: 'task',
					href: `/tasks/${task.id}`
				}))
			];
			return {
				id: tag.id,
				name: tag.name,
				updatedAt: tag.updatedAt,
				archived: tag.archivedAt !== null,
				carriers,
				total: carriers.length
			};
		})
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createTag(sql, viewer, { name: form.get('name') });
		if (!result.ok) {
			// A duplicate name comes back as `invalid` from the unique index,
			// which is exactly what it is: a tag the household already has.
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error:
					result.reason === 'invalid'
						? (result.message ?? 'That tag could not be created.')
						: 'Not allowed.'
			});
		}
		return { created: result.record.id };
	},

	/**
	 * Archiving a tag takes it out of the pickers without unpicking it from
	 * anything: the attachments stay, so restoring it restores the grouping.
	 */
	setArchived: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setTagArchived(
			sql,
			viewer,
			String(form.get('id') ?? ''),
			archived,
			version(form.get('updatedAt'))
		);
		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : 400, {
				error:
					result.reason === 'conflict'
						? 'That tag changed elsewhere. Reload to see the current version.'
						: 'Could not change that tag.'
			});
		}
		return { archived };
	}
};
