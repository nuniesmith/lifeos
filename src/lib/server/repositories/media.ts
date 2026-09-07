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
