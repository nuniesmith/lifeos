-- StoryGraph import identity (Reading Tracker R3b).
--
-- The operator's StoryGraph export (2,288 books) is brought in by a
-- dedicated, operator-only CLI (scripts/import-storygraph.mjs), never the
-- Notion importer: re-running that importer would overwrite the household's
-- in-app edits on every table it covers, because it upserts by
-- notion_page_id (migration 0030's `books.notion_page_id`). A StoryGraph row
-- needs an identity of its own so the SAME import can be re-run -- a
-- corrected export, a retry after a partial failure -- without re-creating
-- every book it already brought in.
--
-- Nullable and additive. A book entered by hand, or by the Notion importer,
-- carries no StoryGraph id and is simply exempt from the uniqueness below --
-- there is nothing to deduplicate it against. The column stores StoryGraph's
-- `ISBN/UID` cell verbatim even when it is not a valid ISBN (StoryGraph's own
-- UID is sometimes an internal id with no ISBN shape at all), which is why
-- this is a separate column from `books.isbn` rather than a second use of it.
alter table books add column storygraph_id text;

-- Partial, the same shape as `authors_name_idx` (migration 0030): unique only
-- among rows that actually carry an id, and scoped to the household so two
-- households importing their own StoryGraph histories independently cannot
-- collide on the same UID. This is what makes the import idempotent -- the
-- importer skips a row whose storygraph_id already exists in the household
-- rather than updating or duplicating it, so re-running it is always safe.
create unique index books_storygraph_id_idx on books (household_id, storygraph_id)
    where storygraph_id is not null;
