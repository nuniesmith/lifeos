import type { Sql } from 'postgres';
import type { Viewer } from '../auth/authz';

/**
 * The images that came in on a record's Notion page.
 *
 * The importer stores every image it finds, links it to the `source_records`
 * row it came from, and stops there. Promoted records — a daily log, a goal, a
 * recipe — carry the same `notion_page_id` as their source row, which is the
 * join back to their pictures.
 *
 * Household-scoped in SQL rather than filtered afterwards, like every other
 * read here: the identifier arrives from a page's own data, but the predicate
 * has to be present for the same reason it is present everywhere else.
 */
export interface RecordImage {
	/** The id to request from /api/media/<id>. */
	id: string;
	width: number | null;
	height: number | null;
	originalName: string | null;
}

export async function imagesForPage(
	sql: Sql,
	viewer: Viewer,
	notionPageId: string | null
): Promise<RecordImage[]> {
	if (!notionPageId) return [];

	const rows = await sql<
		{ id: string; width: number | null; height: number | null; original_name: string | null }[]
	>`
		select a.id, a.width, a.height, a.original_name
		from attachments a
		join attachment_links l
		  on l.attachment_id = a.id and l.entity_type = 'source_record'
		join source_records r on r.id = l.entity_id
		-- source_records carries no household of its own; it belongs to the run
		-- that created it. Scoping both sides means a page id that happened to
		-- collide across households still cannot reach the other one's rows.
		join import_runs ir on ir.id = r.import_run_id
		where r.notion_page_id = ${notionPageId}::uuid
		  and a.household_id = ${viewer.householdId}::uuid
		  and ir.household_id = ${viewer.householdId}::uuid
		  and a.archived_at is null
		  and a.content_type like 'image/%'
		order by l.position, a.created_at
	`;

	return rows.map((row) => ({
		id: row.id,
		width: row.width,
		height: row.height,
		originalName: row.original_name
	}));
}

/**
 * Cover images for a set of records, in one query.
 *
 * A list page needs a cover per row, and asking per row is the classic N+1 —
 * /food would issue seventeen queries to draw seventeen recipe cards. The page
 * hands over the ids it is about to render and gets a map back.
 *
 * Covers come from the HTML export via `scripts/import-covers.mjs`; the
 * Markdown & CSV export the importer reads does not carry them. A record
 * without one is simply absent from the map.
 */
export async function coversForPages(
	sql: Sql,
	viewer: Viewer,
	notionPageIds: (string | null)[]
): Promise<Map<string, RecordImage>> {
	const ids = [...new Set(notionPageIds.filter((id): id is string => Boolean(id)))];
	if (ids.length === 0) return new Map();

	const rows = await sql<
		{
			page_id: string;
			id: string;
			width: number | null;
			height: number | null;
			original_name: string | null;
		}[]
	>`
		select r.notion_page_id::text as page_id, a.id, a.width, a.height, a.original_name
		from attachments a
		join attachment_links l
		  on l.attachment_id = a.id and l.entity_type = 'source_record' and l.role = 'cover'
		join source_records r on r.id = l.entity_id
		join import_runs ir on ir.id = r.import_run_id
		where r.notion_page_id = any(${ids}::uuid[])
		  and a.household_id = ${viewer.householdId}::uuid
		  and ir.household_id = ${viewer.householdId}::uuid
		  and a.archived_at is null
		  and a.content_type like 'image/%'
	`;

	return new Map(
		rows.map((row) => [
			row.page_id,
			{
				id: row.id,
				width: row.width,
				height: row.height,
				originalName: row.original_name
			}
		])
	);
}
