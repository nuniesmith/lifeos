import { fail } from '@sveltejs/kit';
import {
	addDays,
	attachTag,
	daysBetween,
	detachTag,
	listGoals,
	listProjects,
	listTags,
	tagsForEntity,
	type AreaRecord,
	type OpenTaskCount,
	type Queryable,
	type TaggableType,
	type Viewer
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';

/**
 * Shared server-side pieces of the planning surfaces (UI-005, UI-006, UI-007).
 *
 * Projects, goals and areas are three views of one structure, and each of them
 * shows the other two: progress is derived the same way on all three, an area
 * chip means the same thing everywhere, and tagging behaves identically. This
 * module holds those pieces for the same reason `journal/entry.ts` holds the
 * journal's — two copies of a rule drift, and here they would drift into two
 * different answers to "how far along is this?".
 *
 * It lives beside the projects route because progress is defined in terms of a
 * project's tasks; the goals and areas routes import it from here.
 */

// ─── derived progress ──────────────────────────────────────────────────────

/**
 * Progress, computed from live task counts and never stored.
 *
 * The Notion source carried `PROJECT HEALTH`, `Percent Completed` and
 * `Task Percent Progress` as rendered strings. They were deliberately not
 * imported (IMP-008): a stored percentage is a snapshot that goes quietly stale
 * the moment a task is ticked. These numbers are asked for at request time.
 *
 * `closed` is "no longer open" — done *or* dropped. That is the only split
 * `openTaskCountsByProject` offers, and using it everywhere is what keeps a
 * list and a detail page from reporting different figures for the same project.
 * No "health" score is computed: the household never defined one, and the
 * source's version could not be reproduced.
 */
export interface TaskProgress {
	open: number;
	closed: number;
	total: number;
	/** Open tasks whose earliest date is before today. */
	overdue: number;
	/** `closed / total` as a whole percent; 0 when there is nothing to count. */
	percent: number;
}

export function progressOf(count: OpenTaskCount | undefined): TaskProgress {
	const total = count?.totalCount ?? 0;
	const open = count?.openCount ?? 0;
	// Clamped rather than trusted: the two counts come from one query, but a
	// negative "closed" would render as a bar pointing backwards if that ever
	// stopped being true.
	const closed = Math.max(0, total - open);
	return {
		open,
		closed,
		total,
		overdue: count?.overdueCount ?? 0,
		percent: total === 0 ? 0 : Math.round((closed / total) * 100)
	};
}

/** Adds up progress across several projects, for a goal's or an area's roll-up. */
export function sumProgress(parts: TaskProgress[]): TaskProgress {
	const total = parts.reduce((n, p) => n + p.total, 0);
	const open = parts.reduce((n, p) => n + p.open, 0);
	const closed = Math.max(0, total - open);
	return {
		open,
		closed,
		total,
		overdue: parts.reduce((n, p) => n + p.overdue, 0),
		percent: total === 0 ? 0 : Math.round((closed / total) * 100)
	};
}

export const countsById = (counts: OpenTaskCount[]): Map<string, OpenTaskCount> =>
	new Map(counts.map((count) => [count.id, count]));

// ─── area links ────────────────────────────────────────────────────────────

/** The minimum needed to render a chip that links to a record. */
export interface Chip {
	id: string;
	name: string;
}

/**
 * Which life areas each project — or each goal — belongs to.
 *
 * `project_areas` and `goal_areas` are many-to-many, and the repositories
 * expose the relation in one direction only: "the projects in this area". So it
 * is asked in that direction, once per area, and inverted here. That is a query
 * per area, which is bounded by how a household actually thinks — a dozen or so
 * areas, not a table that grows with use. The opposite inversion, "the goals a
 * project serves", would be a query per goal and is deliberately not drawn.
 */
async function areasByRecord(
	areas: AreaRecord[],
	listIn: (areaId: string) => Promise<{ id: string }[]>
): Promise<Map<string, Chip[]>> {
	const lists = await Promise.all(areas.map((area) => listIn(area.id)));
	const byRecord = new Map<string, Chip[]>();

	lists.forEach((records, index) => {
		const area = areas[index];
		if (!area) return;
		for (const record of records) {
			const chips = byRecord.get(record.id) ?? [];
			chips.push({ id: area.id, name: area.name });
			byRecord.set(record.id, chips);
		}
	});
	return byRecord;
}

export const areasByProject = (
	db: Queryable,
	viewer: Viewer,
	areas: AreaRecord[]
): Promise<Map<string, Chip[]>> =>
	areasByRecord(areas, (areaId) => listProjects(db, viewer, { areaId, limit: 500 }));

export const areasByGoal = (
	db: Queryable,
	viewer: Viewer,
	areas: AreaRecord[]
): Promise<Map<string, Chip[]>> =>
	areasByRecord(areas, (areaId) => listGoals(db, viewer, { areaId, limit: 500 }));

// ─── review cadence ────────────────────────────────────────────────────────

export type ReviewState = 'unscheduled' | 'never' | 'due' | 'scheduled';

export interface AreaReview {
	everyDays: number | null;
	lastReviewedOn: string | null;
	/** When the next review falls due; null when there is no cadence yet. */
	nextDueOn: string | null;
	/** Days until that date. Negative means it has been missed by that many. */
	dueInDays: number | null;
	state: ReviewState;
}

/**
 * When an area is next due a look, derived from its cadence.
 *
 * A cadence with no last-review date is due now rather than never: the point of
 * setting one is to be asked, and "reviewed on" being empty is the state a
 * freshly created area is in.
 */
export function reviewOf(
	area: { reviewEveryDays: number | null; lastReviewedOn: string | null },
	today: string
): AreaReview {
	const everyDays = area.reviewEveryDays;
	const lastReviewedOn = area.lastReviewedOn;

	if (everyDays === null) {
		return { everyDays, lastReviewedOn, nextDueOn: null, dueInDays: null, state: 'unscheduled' };
	}
	if (lastReviewedOn === null) {
		return { everyDays, lastReviewedOn, nextDueOn: null, dueInDays: null, state: 'never' };
	}

	const nextDueOn = addDays(lastReviewedOn, everyDays);
	const dueInDays = daysBetween(today, nextDueOn);
	return {
		everyDays,
		lastReviewedOn,
		nextDueOn,
		dueInDays,
		state: dueInDays <= 0 ? 'due' : 'scheduled'
	};
}

// ─── tags ──────────────────────────────────────────────────────────────────

export interface TagPanel {
	/** The tags on this record. */
	tags: Chip[];
	/** Household tags not on it yet, which is what the add control offers. */
	available: Chip[];
}

/**
 * The tags on one record, plus what else could be put on it.
 *
 * `tagsForEntity` is scoped by the record, so a tag on something the viewer may
 * not read is not returned; the available list is the household's tags, which
 * belong to nobody in particular.
 */
export async function tagPanel(
	viewer: Viewer,
	entityType: TaggableType,
	entityId: string
): Promise<TagPanel> {
	const [attached, all] = await Promise.all([
		tagsForEntity(sql, viewer, entityType, entityId),
		listTags(sql, viewer, { limit: 200 })
	]);
	const taken = new Set(attached.map((tag) => tag.id));
	return {
		tags: attached.map((tag) => ({ id: tag.id, name: tag.name })),
		available: all
			.filter((tag) => !taken.has(tag.id))
			.map((tag) => ({ id: tag.id, name: tag.name }))
	};
}

/** The shape of a form action's event that the tag actions actually use. */
interface TagEvent {
	locals: App.Locals;
	params: Partial<Record<string, string>>;
	request: Request;
}

/**
 * The attach/detach pair, bound to an entity type.
 *
 * Written once and spread into each detail route's actions, so tagging a
 * project and tagging an area cannot end up behaving differently. Both ends are
 * scoped inside the repository: the tag must be this household's and the record
 * must be one the viewer may write.
 */
export function tagActions(entityType: TaggableType) {
	return {
		attachTag: async ({ locals, params, request }: TagEvent) => {
			const viewer = await requireViewer(locals.user);
			const form = await request.formData();

			const result = await attachTag(
				sql,
				viewer,
				String(form.get('tagId') ?? ''),
				entityType,
				String(params.id ?? '')
			);
			if (!result.ok) return fail(400, { error: 'Could not add that tag.' });
			return { tagged: true };
		},

		detachTag: async ({ locals, params, request }: TagEvent) => {
			const viewer = await requireViewer(locals.user);
			const form = await request.formData();

			// A tag that is already off the record is the state the caller asked
			// for, so this reports success either way.
			await detachTag(
				sql,
				viewer,
				String(form.get('tagId') ?? ''),
				entityType,
				String(params.id ?? '')
			);
			return { untagged: true };
		}
	};
}

// ─── form helpers ──────────────────────────────────────────────────────────

/**
 * Empty select and date values arrive as `''`, which means "no link" or "no
 * date" rather than "unchanged". The repositories read `''` as null for dates
 * and text, but an id has to be flattened here.
 */
export const nullable = (value: FormDataEntryValue | null): string | null => {
	const text = String(value ?? '').trim();
	return text === '' ? null : text;
};

/**
 * The optimistic concurrency token as the repositories want it.
 *
 * A blank one becomes `undefined` — "no precondition" — rather than `''`, which
 * the timestamp coercion rejects with a TypeError and a 500. Only the archive
 * paths take an optional token; an edit always carries one.
 */
export const version = (value: FormDataEntryValue | null): string | undefined => {
	const text = String(value ?? '').trim();
	return text === '' ? undefined : text;
};
