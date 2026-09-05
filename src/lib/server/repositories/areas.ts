import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	archiveScoped,
	baseColumns,
	getScoped,
	guarded,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toDayOrNull,
	toInt,
	toIntOrNull,
	toText,
	toTextOrNull,
	writableBy,
	writableScope,
	writeScoped,
	type BaseRow,
	type OwnershipInput,
	type PageOptions,
	type Queryable,
	type RecordBase,
	type WriteResult
} from './base';
import { optionalDay, optionalInt, optionalText, patched, requiredText } from './validate';

/**
 * Life areas (MODEL-003).
 *
 * The source's per-area rollups ("Open Direct Tasks" and friends) are not
 * stored: `openTaskCountsByArea` in `tasks.ts` answers them from the tasks
 * themselves, so an area page and a report cannot disagree.
 */

export interface AreaRecord extends RecordBase {
	name: string;
	description: string | null;
	icon: string | null;
	reviewEveryDays: number | null;
	lastReviewedOn: string | null;
	sortOrder: number;
}

interface AreaRow extends BaseRow {
	name: string;
	description: string | null;
	icon: string | null;
	review_every_days: unknown;
	last_reviewed_on: string | null;
	sort_order: unknown;
}

const TABLE = 'areas';

const columns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, description, icon, review_every_days,
	last_reviewed_on::text as last_reviewed_on, sort_order`;

function mapArea(row: AreaRow): AreaRecord {
	return {
		...mapBase(row),
		name: toText(row.name),
		description: toTextOrNull(row.description),
		icon: toTextOrNull(row.icon),
		reviewEveryDays: toIntOrNull(row.review_every_days),
		lastReviewedOn: toDayOrNull(row.last_reviewed_on),
		sortOrder: toInt(row.sort_order)
	};
}

export interface AreaFilters extends PageOptions {
	includeArchived?: boolean;
	ownerUserId?: string | null;
	search?: string;
	order?: 'manual' | 'name' | 'created';
}

function areaConditions(sql: Queryable, viewer: Viewer, filters: AreaFilters): Fragment {
	const parts: Fragment[] = [
		readableScope(sql, viewer, TABLE),
		liveScope(sql, TABLE, filters.includeArchived)
	];
	if (filters.ownerUserId !== undefined) {
		parts.push(
			filters.ownerUserId === null
				? sql`owner_user_id is null`
				: sql`owner_user_id = ${filters.ownerUserId}::uuid`
		);
	}
	if (filters.search?.trim()) {
		parts.push(sql`name ilike ${`%${filters.search.trim()}%`}`);
	}
	return parts.reduce((all, part) => sql`${all} and ${part}`);
}

export async function listAreas(
	sql: Queryable,
	viewer: Viewer,
	filters: AreaFilters = {}
): Promise<AreaRecord[]> {
	const { limit, offset } = pageOf(filters);
	const order =
		filters.order === 'name'
			? sql`name asc`
			: filters.order === 'created'
				? sql`created_at desc`
				: sql`sort_order asc, name asc`;
	const rows = await sql<AreaRow[]>`
		select ${columns(sql)} from areas
		where ${areaConditions(sql, viewer, filters)}
		order by ${order}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapArea);
}

export async function getArea(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<AreaRecord | null> {
	const row = await getScoped<AreaRow>(
		sql,
		TABLE,
		id,
		readableScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapArea(row) : null;
}

export interface AreaInput extends OwnershipInput {
	name?: unknown;
	description?: unknown;
	icon?: unknown;
	reviewEveryDays?: unknown;
	lastReviewedOn?: unknown;
	sortOrder?: unknown;
}

export function createArea(
	sql: Queryable,
	viewer: Viewer,
	input: AreaInput
): Promise<WriteResult<AreaRecord>> {
	return guarded<AreaRecord>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: viewer.userId,
			visibility: 'household'
		});
		const rows = await sql<AreaRow[]>`
			insert into areas (
				household_id, owner_user_id, visibility, name, description, icon,
				review_every_days, last_reviewed_on, sort_order, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${optionalText(input.description, 'description')},
				${optionalText(input.icon, 'icon', 40)},
				${optionalInt(input.reviewEveryDays, 'review every', { min: 1 })}::int,
				${optionalDay(input.lastReviewedOn, 'last reviewed')}::date,
				${optionalInt(input.sortOrder, 'sort order') ?? 0}::int,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapArea(row) };
	});
}

export function updateArea(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: AreaInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<AreaRecord>> {
	return guarded<AreaRecord>(async () => {
		const current = await getArea(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			description: patched(patch, 'description', current.description, (v) =>
				optionalText(v, 'description')
			),
			icon: patched(patch, 'icon', current.icon, (v) => optionalText(v, 'icon', 40)),
			reviewEveryDays: patched(patch, 'reviewEveryDays', current.reviewEveryDays, (v) =>
				optionalInt(v, 'review every', { min: 1 })
			),
			lastReviewedOn: patched(patch, 'lastReviewedOn', current.lastReviewedOn, (v) =>
				optionalDay(v, 'last reviewed')
			),
			sortOrder: patched(
				patch,
				'sortOrder',
				current.sortOrder,
				(v) => optionalInt(v, 'sort order') ?? 0
			)
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<AreaRow, AreaRecord>({
			sql,
			table: TABLE,
			id,
			readScope: readableScope(sql, viewer, TABLE),
			writeScope: writableScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`
				name = ${next.name},
				description = ${next.description},
				icon = ${next.icon},
				review_every_days = ${next.reviewEveryDays}::int,
				last_reviewed_on = ${next.lastReviewedOn}::date,
				sort_order = ${next.sortOrder}::int,
				owner_user_id = ${ownership.ownerUserId}::uuid,
				visibility = ${ownership.visibility},
				updated_by = ${viewer.userId}::uuid`,
			columns: columns(sql),
			map: mapArea,
			mayWrite: writableBy(viewer)
		});
	});
}

export const setAreaArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<AreaRecord>> =>
	archiveScoped<AreaRow, AreaRecord>({
		sql,
		table: TABLE,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: columns(sql),
		map: mapArea
	});

export const archiveArea = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setAreaArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveArea = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setAreaArchived(sql, viewer, id, false, expectedUpdatedAt);
