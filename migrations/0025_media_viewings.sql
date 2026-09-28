-- Per-viewing history for the watchlist (PACK5-001).
--
-- `media_items.times_watched` and `last_watched_at` (migration 0014) answer
-- "how many times, and when most recently" but nothing behind them says
-- which of those sittings had which episode, or why a rewatch happened at
-- all -- questions this household actually has about a title worth watching
-- twice. This table is the log those questions read from: one row per
-- sitting, added by `logMediaViewing` rather than replacing either summary
-- column on media_items -- see that function for why `times_watched` is
-- incremented, never recomputed as a count of these rows (the importer's
-- own counts have no viewing rows behind them at all).
--
-- Deliberately carries no `visibility` or `owner_user_id` of its own, unlike
-- `lab_results` (migration 0020), which can be shared or kept private
-- independently of the marker it points at. Nobody in a two-person household
-- watches a shared show privately; a viewing is exactly as visible as the
-- title it belongs to, so every read and write here is authorised against
-- the parent `media_items` row instead (see logMediaViewing/listMediaViewings
-- in collections.ts). That is also why this table has no `archived_at`: there
-- is nothing of its own for the Archive to list or restore. Nothing removes a
-- row here yet either -- a mislogged viewing is corrected by logging the
-- right one, not by hunting for an undo -- and if a delete lands later it
-- will be a hard delete of a log line, not something the Archive holds.
--
-- `household_id` is carried anyway, the same as `lab_results`, rather than
-- left out the way a bare junction table (`recipe_ingredients`) leaves it
-- out: every real row in this schema says which household it belongs to, so
-- a query that forgets to join back to media_items still cannot cross the
-- one boundary that actually matters.
create table media_viewings (
    id            uuid primary key default gen_random_uuid(),
    household_id  uuid not null references households(id) on delete cascade,
    media_item_id uuid not null references media_items(id) on delete cascade,
    -- The day watched, not a timestamp: "we watched it Tuesday" is the fact
    -- being logged, and a timestamp would need a timezone this table has no
    -- other reason to carry -- see base.ts's own header on the same point.
    watched_on    date not null,
    -- Which episode, for a show logged mid-run; both null for a movie, or for
    -- a show someone logged without noting where they were.
    season        integer check (season is null or season >= 0),
    episode       integer check (episode is null or episode >= 0),
    note          text,
    -- Who logged the entry, not who was in the room for it -- provenance for
    -- the log line, the same role `created_by` plays on every other table.
    logged_by     uuid references users(id) on delete set null,

    created_at    timestamptz not null default now()
);

-- A title's own page reads every viewing for it, most recent first.
create index media_viewings_item_idx on media_viewings (media_item_id, watched_on desc);
