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
-- `ISBN/UID` cell verbatim even when it is not a valid ISBN (it is often an
-- ASIN, a Kindle edition's Amazon id), which is why this is a separate column
-- from `books.isbn` rather than a second use of it. A row with no ISBN/UID at
-- all gets a digest of its title and authors instead, prefixed `title:` (see
-- storygraph.ts's `titleKey`), so it is recognised on a re-run too.
alter table books add column storygraph_id text;

-- Partial, the same shape as `authors_name_idx` (migration 0030): unique only
-- among rows that actually carry an id, and scoped to the household so two
-- households importing their own StoryGraph histories independently cannot
-- collide on the same UID. This is what makes the import idempotent -- the
-- importer skips a row whose storygraph_id already exists in the household
-- rather than updating or duplicating it, so re-running it is always safe.
create unique index books_storygraph_id_idx on books (household_id, storygraph_id)
    where storygraph_id is not null;

-- Partial read dates. StoryGraph records a read by year only ("2019") or by
-- year and month ("2019/05") whenever the day was never entered, and in the
-- operator's export most of the dated reads are of that kind. Dropping them
-- would lose most of the reading history; storing them as a whole day would
-- show a book "finished 1 January" and pile every year-only read into
-- January's bar on the insights page. So the date column holds the FIRST day
-- of the known period (keeping year and month arithmetic, ordering and the
-- finished-after-started CHECK working unchanged), and these columns say how
-- much of it is real. Everything the app itself logs is a whole day, which is
-- why `day` is the default and no existing row or write path changes.
alter table book_reads
    add column started_precision  text not null default 'day'
        check (started_precision in ('day', 'month', 'year')),
    add column finished_precision text not null default 'day'
        check (finished_precision in ('day', 'month', 'year'));
