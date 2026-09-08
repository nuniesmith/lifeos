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
 * Returns both the page's cover and the images in its body — everything that
 * arrived on that Notion page — with the cover first.
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
		-- The display variant when one exists, the original otherwise. A variant
		-- is a re-encoding at the same dimensions, so width and height come from
		-- whichever row is actually served.
		-- DISTINCT ON the image, because one file can be linked to a record
		-- twice: six records here use their page cover again inside the body,
		-- and without this the journal draws the same photograph two days
		-- running down the page. The ordering below decides which link wins.
		select distinct on (coalesce(v.id, a.id))
		       coalesce(v.id, a.id) as id,
		       coalesce(v.width, a.width) as width,
		       coalesce(v.height, a.height) as height,
		       a.original_name
		from attachments a
		left join attachments v
		  on v.variant_of = a.id and v.variant_kind = 'display' and v.archived_at is null
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
		  -- A variant is a smaller copy of another image on this page, not a
		  -- picture of its own; listing one shows the same thing twice.
		  and a.variant_of is null
		-- The page's cover first, then the pictures in the body in the order they
		-- appeared. Covers arrive from a different export than everything else
		-- (see scripts/import-covers.mjs) and so were being interleaved by
		-- created_at, which put a day's cover in the middle of its photographs.
		-- DISTINCT ON requires the deduplicated expression to lead the ordering.
		order by coalesce(v.id, a.id), (l.role = 'cover') desc, l.position, a.created_at
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
		-- The thumbnail when one exists. Covers here run to 11 MB and are drawn
		-- as 48-pixel rows and a 6rem band; serving originals made one page ship
		-- 21 MB to render seven pictures.
		select r.notion_page_id::text as page_id,
		       coalesce(v.id, a.id) as id,
		       coalesce(v.width, a.width) as width,
		       coalesce(v.height, a.height) as height,
		       a.original_name
		from attachments a
		left join attachments v
		  on v.variant_of = a.id and v.variant_kind = 'thumb' and v.archived_at is null
		join attachment_links l
		  on l.attachment_id = a.id and l.entity_type = 'source_record'
		 and l.role = 'cover'
		join source_records r on r.id = l.entity_id
		join import_runs ir on ir.id = r.import_run_id
		where r.notion_page_id = any(${ids}::uuid[])
		  and a.household_id = ${viewer.householdId}::uuid
		  and ir.household_id = ${viewer.householdId}::uuid
		  and a.archived_at is null
		  and a.content_type like 'image/%'
	`;

	// One cover per page; the first row wins if a page somehow has two.
	const covers = new Map<string, RecordImage>();
	for (const row of rows) {
		if (covers.has(row.page_id)) continue;
		covers.set(row.page_id, {
			id: row.id,
			width: row.width,
			height: row.height,
			originalName: row.original_name
		});
	}
	return covers;
}
