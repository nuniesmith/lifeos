-- Notion page keys for the three tables the 2026-10-14 export fills that had
-- none: a reading-log entry, a routine step and a reading-challenge prompt.
--
-- The importer is idempotent by `notion_page_id` (see promote.ts): a re-run
-- updates the record it wrote last time. These three were built for in-app
-- entry, so they had no such key, and an import into them could only ever
-- INSERT -- every re-run would add a second copy of every read, step and
-- prompt. Authors, genres and series need no key: each already has a unique
-- name per household, which the importer matches on instead.
--
-- Nullable and unique, the same shape every other imported table uses: a row
-- created in the app has no Notion page, and no two rows may claim the same
-- one.

alter table book_reads
    add column notion_page_id uuid unique;

alter table routine_steps
    add column notion_page_id uuid unique;

alter table reading_challenge_items
    add column notion_page_id uuid unique;
