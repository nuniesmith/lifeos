-- Links between library entries (PACK1-001).
--
-- Every relation the importer brought in runs between two different Notion
-- databases (a task and its project, a habit and its goal). A library entry
-- pointing at another library entry — "the sequel to", "the talk this book is
-- based on", "goes with this" — has no source-side equivalent, so this table
-- exists for LifeOS's own use rather than to hold anything imported.
--
-- Modelled on `task_dependencies` (migration 0004): a same-table relation, no
-- surrogate id, no `household_id` of its own — both ends already carry one,
-- and every repository call scopes through `library_items` the same way
-- `task_dependencies`' queries scope through `tasks`. Unlike a dependency,
-- though, a library link has no direction: the plan (§13) asks for it to show
-- on both entries' pages alike, and "the sequel to" read from the other end is
-- still a true statement about that entry, not a different relation. Storing
-- one row per edge, in a canonical order, keeps that single: the check below
-- forces `item_a_id` to be the smaller id, so the same pair can never be
-- inserted a second time the other way round, and the primary key is what
-- actually rejects the duplicate.
create table library_links (
    item_a_id  uuid not null references library_items(id) on delete cascade,
    item_b_id  uuid not null references library_items(id) on delete cascade,
    created_at timestamptz not null default now(),
    created_by uuid references users(id) on delete set null,
    primary key (item_a_id, item_b_id),
    constraint library_links_ordered check (item_a_id < item_b_id)
);

-- The primary key already indexes item_a_id; a link is looked up from either
-- end, so item_b_id needs an index of its own.
create index library_links_b_idx on library_links (item_b_id);
