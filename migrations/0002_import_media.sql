-- Import provenance and media.
--
-- Shaped by the verified source-format hazards (plan §7). In particular:
-- relations resolve on the 32-hex Notion ID, never on title (this export has
-- 10 duplicate-title groups), and every unmapped source value is retained as
-- JSONB so nothing is silently discarded.

-- ─── import runs ───────────────────────────────────────────────────────────
create table import_runs (
    id             uuid        primary key default gen_random_uuid(),
    household_id   uuid        not null references households(id) on delete cascade,
    started_at     timestamptz not null default now(),
    finished_at    timestamptz,
    status         text        not null default 'running'
                                check (status in ('running','succeeded','failed','dry_run')),
    dry_run        boolean     not null default true,
    importer_version text      not null,
    app_commit     text,
    started_by     uuid        references users(id) on delete set null,
    -- Counts and unresolved items; never record row content here.
    summary        jsonb       not null default '{}'::jsonb
);

create index import_runs_household on import_runs (household_id, started_at desc);

-- ─── import sources ────────────────────────────────────────────────────────
-- One row per source file actually read, with its hash, so a run can be
-- reproduced and a re-import can prove it saw identical inputs.
create table import_sources (
    id            uuid        primary key default gen_random_uuid(),
    import_run_id uuid        not null references import_runs(id) on delete cascade,
    -- Path within the export, e.g. 'md and csv/Life OS/System/Tasks Database ….csv'
    relative_path text        not null,
    kind          text        not null check (kind in ('csv_all','csv_view','html','markdown','media','other')),
    sha256        bytea       not null,
    byte_size     bigint      not null,
    -- Notion database/page id parsed out of the filename, when present.
    notion_id     uuid,
    row_count     integer,
    unique (import_run_id, relative_path)
);

create index import_sources_run on import_sources (import_run_id);

-- ─── source records ────────────────────────────────────────────────────────
-- The canonical staging row: raw values exactly as parsed, before mapping.
-- Promotion to domain tables happens in a transaction after validation.
create table source_records (
    id             uuid        primary key default gen_random_uuid(),
    import_run_id  uuid        not null references import_runs(id) on delete cascade,
    source_id      uuid        not null references import_sources(id) on delete cascade,
    -- The Notion page id. Not unique per run: the same page appears in both
    -- the CSV and HTML/Markdown exports and is reconciled by source precedence.
    notion_page_id uuid,
    database_name  text        not null,
    -- Display title. Deliberately NOT a key: duplicates are known to exist.
    title          text,
    ordinal        integer     not null,
    -- Every column of the source row, verbatim. Nothing is dropped here.
    raw            jsonb       not null,
    created_at     timestamptz not null default now()
);

create index source_records_run   on source_records (import_run_id);
create index source_records_page  on source_records (notion_page_id) where notion_page_id is not null;
create index source_records_db    on source_records (import_run_id, database_name);

-- ─── source links ──────────────────────────────────────────────────────────
-- Relations extracted from cells of the form
--   Title (Database%20Name/Title%20<32-hex>.csv)
-- The 32-hex id is the foreign key; the leading title is display text only.
create table source_links (
    id               uuid    primary key default gen_random_uuid(),
    import_run_id    uuid    not null references import_runs(id) on delete cascade,
    from_record_id   uuid    not null references source_records(id) on delete cascade,
    property         text    not null,
    -- Target may not exist in the export; resolution is checked, not assumed.
    to_notion_page_id uuid   not null,
    to_record_id     uuid    references source_records(id) on delete set null,
    -- Position within a multi-valued cell, so ordering survives.
    position         integer not null default 0,
    display_text     text
);

create index source_links_from on source_links (from_record_id);
create index source_links_to   on source_links (to_notion_page_id);
create index source_links_unresolved on source_links (import_run_id)
    where to_record_id is null;

-- ─── import issues ─────────────────────────────────────────────────────────
-- Every unexplained thing the import found. The gate requires these be
-- explicit rather than silently tolerated.
create table import_issues (
    id            bigserial   primary key,
    import_run_id uuid        not null references import_runs(id) on delete cascade,
    severity      text        not null check (severity in ('info','warning','error')),
    code          text        not null,
    relative_path text,
    record_id     uuid        references source_records(id) on delete set null,
    message       text        not null,
    detail        jsonb       not null default '{}'::jsonb,
    created_at    timestamptz not null default now()
);

create index import_issues_run on import_issues (import_run_id, severity);

-- ─── attachments ───────────────────────────────────────────────────────────
-- Content-addressed and immutable. The export holds 525 image files that are
-- only 298 unique by SHA-256, so deduplication is the normal case.
create table attachments (
    id            uuid        primary key default gen_random_uuid(),
    household_id  uuid        not null references households(id) on delete cascade,
    sha256        bytea       not null,
    byte_size     bigint      not null check (byte_size > 0),
    -- Detected from bytes, never trusted from the filename or client.
    content_type  text        not null,
    width         integer,
    height        integer,
    original_name text,
    storage_key   text        not null,
    created_at    timestamptz not null default now(),
    created_by    uuid        references users(id) on delete set null,
    -- Physical deletion is delayed beyond the backup retention window.
    archived_at   timestamptz,
    purge_after   timestamptz,
    unique (household_id, sha256)
);

create index attachments_purge on attachments (purge_after) where purge_after is not null;

-- ─── attachment links ──────────────────────────────────────────────────────
create table attachment_links (
    attachment_id uuid        not null references attachments(id) on delete cascade,
    entity_type   text        not null,
    entity_id     uuid        not null,
    role          text        not null default 'attachment',
    position      integer     not null default 0,
    created_at    timestamptz not null default now(),
    primary key (attachment_id, entity_type, entity_id, role)
);

create index attachment_links_entity on attachment_links (entity_type, entity_id);
