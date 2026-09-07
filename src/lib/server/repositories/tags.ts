import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate, toDateOrNull } from '../db/coerce';
import {
	InvalidInput,
	archivedAssignment,
	getScoped,
	guarded,
	householdScope,
	isUuid,
	liveScope,
	pageOf,
	readableScope,
	toText,
	toTextOrNull,
	writableScope,
	writeScoped,
	type PageOptions,
	type Queryable,
	type WriteResult
} from './base';
import { optionalText, requiredText } from './validate';

/**
 * Tags (MODEL-003).
 *
 * Tags belong to the household, not to a person: they have no owner and no
 * visibility of their own, so household isolation is the whole of their
 * authorization. What a tag is *attached to* still carries its own privacy —
 * which is why attaching is scoped by the target record, not by the tag.
 *
 * `entity_tags` is polymorphic by design (a column per entity type would need
 * a migration per feature pack), so the entity type is checked against a
 * whitelist here. It is interpolated as an identifier into the query, and an
 * unchecked value would be exactly the injection this driver otherwise
 * prevents.
 */

/** Entity type as stored in `entity_tags`, mapped to its table. */
export const TAGGABLE = {
	task: 'tasks',
	project: 'projects',
	area: 'areas',
	goal: 'goals',
	habit: 'habits',
	important_date: 'important_dates',
	daily_log: 'daily_logs',
	library_item: 'library_items'
} as const;

export type TaggableType = keyof typeof TAGGABLE;

function tableFor(entityType: string): string {
	const table = TAGGABLE[entityType as TaggableType];
	if (!table) throw new InvalidInput(`${entityType} cannot be tagged`);
	return table;
}

export interface TagRecord {
	id: string;
	householdId: string;
	name: string;
	colour: string | null;
	notionPageId: string | null;
	sourceRecordId: string | null;
	createdAt: Date;
	updatedAt: Date;
	archivedAt: Date | null;
}

interface TagRow {
	id: string;
	household_id: string;
	name: string;
	colour: string | null;
	notion_page_id: string | null;
	source_record_id: string | null;
	created_at: unknown;
	updated_at: unknown;
	archived_at: unknown;
}

const TABLE = 'tags';

const columns = (sql: Queryable): Fragment => sql`
	id, household_id, name, colour, notion_page_id, source_record_id,
	created_at, updated_at, archived_at`;

const mapTag = (row: TagRow): TagRecord => ({
	id: row.id,
	householdId: row.household_id,
	name: toText(row.name),
	colour: toTextOrNull(row.colour),
	notionPageId: row.notion_page_id,
	sourceRecordId: row.source_record_id,
	createdAt: toDate(row.created_at),
	updatedAt: toDate(row.updated_at),
	archivedAt: toDateOrNull(row.archived_at)
});

export interface TagFilters extends PageOptions {
	search?: string;
	includeArchived?: boolean;
}

export async function listTags(
	sql: Queryable,
	viewer: Viewer,
	filters: TagFilters = {}
): Promise<TagRecord[]> {
	const { limit, offset } = pageOf(filters);
	const search = filters.search?.trim()
		? sql`name ilike ${`%${filters.search.trim()}%`}`
		: sql`true`;
	const rows = await sql<TagRow[]>`
		select ${columns(sql)} from tags
		where ${householdScope(sql, viewer, TABLE)}
		  and ${liveScope(sql, TABLE, filters.includeArchived)}
		  and ${search}
		order by name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapTag);
}

export async function getTag(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<TagRecord | null> {
	const row = await getScoped<TagRow>(
		sql,
		TABLE,
		id,
		householdScope(sql, viewer, TABLE),
		columns(sql)
	);
	return row ? mapTag(row) : null;
}

export interface TagInput {
	name?: unknown;
	colour?: unknown;
}

export function createTag(
	sql: Queryable,
	viewer: Viewer,
	input: TagInput
): Promise<WriteResult<TagRecord>> {
	return guarded<TagRecord>(async () => {
		const name = requiredText(input.name, 'name', 100);
		const rows = await sql<TagRow[]>`
			insert into tags (household_id, name, colour)
			values (${viewer.householdId}::uuid, ${name}, ${optionalText(input.colour, 'colour', 40)})
			returning ${columns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapTag(row) };
	});
}

export function updateTag(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: TagInput,
	expectedUpdatedAt: Date | string
): Promise<WriteResult<TagRecord>> {
	return guarded<TagRecord>(async () => {
		const current = await getTag(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };
		const name = 'name' in patch ? requiredText(patch.name, 'name', 100) : current.name;
		const colour = 'colour' in patch ? optionalText(patch.colour, 'colour', 40) : current.colour;

		return writeScoped<TagRow, TagRecord>({
			sql,
			table: TABLE,
			id,
			readScope: householdScope(sql, viewer, TABLE),
			writeScope: householdScope(sql, viewer, TABLE),
			expectedUpdatedAt,
			assignments: sql`name = ${name}, colour = ${colour}`,
			columns: columns(sql),
			map: mapTag,
			// A tag has no owner, so either household member may rename it.
			mayWrite: () => true
		});
	});
}

export function setTagArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<TagRecord>> {
	return writeScoped<TagRow, TagRecord>({
		sql,
		table: TABLE,
		id,
		readScope: householdScope(sql, viewer, TABLE),
		writeScope: householdScope(sql, viewer, TABLE),
		expectedUpdatedAt,
		assignments: archivedAssignment(sql, archived),
		columns: columns(sql),
		map: mapTag,
		mayWrite: () => true
	});
}

export const archiveTag = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setTagArchived(sql, viewer, id, true, expectedUpdatedAt);

export const unarchiveTag = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	expectedUpdatedAt?: Date | string
) => setTagArchived(sql, viewer, id, false, expectedUpdatedAt);

// ─── attaching ─────────────────────────────────────────────────────────────

export interface TagAttachment {
	tagId: string;
	entityType: TaggableType;
	entityId: string;
}

/**
 * Attaches a tag to a record, in one statement.
 *
 * Both ends are scoped in the query: the tag must be this household's, and the
 * record must be one the viewer may *write* — tagging changes how someone
 * else's record presents itself, which is a modification. Nothing matching
 * means nothing is written, so a cross-household attach is not refused so much
 * as impossible.
 */
export function attachTag(
	sql: Queryable,
	viewer: Viewer,
	tagId: string,
	entityType: TaggableType,
	entityId: string
): Promise<WriteResult<TagAttachment>> {
	return guarded<TagAttachment>(async () => {
		const table = tableFor(entityType);
		if (!isUuid(tagId) || !isUuid(entityId)) return { ok: false, reason: 'not_found' };

		const rows = await sql<{ tag_id: string }[]>`
			insert into entity_tags (tag_id, entity_type, entity_id)
			select t.id, ${entityType}, e.id
			from tags t, ${sql(table)} e
			where t.id = ${tagId}::uuid
			  and ${householdScope(sql, viewer, 't')}
			  and t.archived_at is null
			  and e.id = ${entityId}::uuid
			  and ${writableScope(sql, viewer, 'e')}
			on conflict (tag_id, entity_type, entity_id)
				do update set created_at = entity_tags.created_at
			returning tag_id
		`;
		if (rows.length === 0) return { ok: false, reason: 'not_found' };
		return { ok: true, record: { tagId, entityType, entityId } };
	});
}

/** Removes a tag from a record. Not attached is success, not a failure. */
export async function detachTag(
	sql: Queryable,
	viewer: Viewer,
	tagId: string,
	entityType: TaggableType,
	entityId: string
): Promise<boolean> {
	const table = tableFor(entityType);
	if (!isUuid(tagId) || !isUuid(entityId)) return false;

	const rows = await sql<{ tag_id: string }[]>`
		delete from entity_tags et
		where et.tag_id = ${tagId}::uuid
		  and et.entity_type = ${entityType}
		  and et.entity_id = ${entityId}::uuid
		  and exists (
		      select 1 from tags t
		      where t.id = et.tag_id and ${householdScope(sql, viewer, 't')}
		  )
		  and exists (
		      select 1 from ${sql(table)} e
		      where e.id = et.entity_id and ${writableScope(sql, viewer, 'e')}
		  )
		returning et.tag_id
	`;
	return rows.length > 0;
}

/** The tags on a record, provided the viewer may read the record itself. */
export async function tagsForEntity(
	sql: Queryable,
	viewer: Viewer,
	entityType: TaggableType,
	entityId: string
): Promise<TagRecord[]> {
	const table = tableFor(entityType);
	if (!isUuid(entityId)) return [];

	// Written as EXISTS rather than a join: `entity_tags` also has a
	// `created_at`, and an unqualified column list over a join would be
	// ambiguous on it.
	const rows = await sql<TagRow[]>`
		select ${columns(sql)} from tags
		where ${householdScope(sql, viewer, TABLE)}
		  and exists (
		      select 1 from entity_tags et
		      where et.tag_id = tags.id
		        and et.entity_type = ${entityType}
		        and et.entity_id = ${entityId}::uuid
		  )
		  and exists (
		      select 1 from ${sql(table)} e
		      where e.id = ${entityId}::uuid and ${readableScope(sql, viewer, 'e')}
		  )
		order by name asc
	`;
	return rows.map(mapTag);
}
