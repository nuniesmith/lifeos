-- Reading challenges and their prompts (Reading Tracker R3).
--
-- R1 (migration 0030) gave the household a catalogue; R2 (migration 0033)
-- gave each person their own read-through history. Neither answers "how is
-- the year going" -- a household that sets itself "read 30 books in 2026" or
-- fills in a prompt sheet like "a book with a blue cover" has nowhere to keep
-- that goal or check it off. This is additive, purely new tables, and reads
-- nothing from either earlier pack's rows.
--
-- `reading_challenges` is a full owned record -- household_id/owner_user_id/
-- visibility, notion_page_id/source_record_id included even though nothing
-- imports into it yet -- the same shape `books` (migration 0030) already
-- uses. Two kinds share the one table rather than two: a `count` challenge
-- ("read 30 books this year") and a `prompts` challenge (a sheet of prompts,
-- each filled by a book) differ only in which of their own columns apply, the
-- same choice `tasks.is_template` or `goals`' several statuses already make
-- for a single table over a join. Progress for a `count` challenge is never
-- stored: it is the owner's own finished reads in the challenge's year,
-- optionally narrowed by category/format/genre, computed fresh by
-- reading-challenges.ts on every read the same way `book_series`'
-- `finishedCount` already is -- a stored counter would drift the moment a
-- read is edited, backfilled, or deleted out from under it.
--
-- `reading_challenge_items` is the prompt list of a `prompts` challenge,
-- scoped through its challenge exactly the way `routine_steps` (migration
-- 0031) is scoped through `routines`: no household_id, owner or visibility of
-- its own, because a prompt is not a record anyone owns independently of the
-- challenge it belongs to. Positions are unique among live items the same
-- way (compact on archive, append on restore); see routines.ts's `moveStep`
-- for the swap this schema is built to support, and archive.ts's
-- `NOT_IN_THE_ARCHIVE` for why a single item has no restore entry of its own.

-- ─── reading_challenges ─────────────────────────────────────────────────────

create table reading_challenges (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    title            text not null check (length(trim(title)) between 1 and 200),
    year             integer not null check (year between 1900 and 2200),
    -- Markdown, rendered with renderMarkdown like a book's own description.
    notes            text,

    kind             text not null check (kind in ('count', 'prompts')),
    -- Required for, and only for, a 'count' challenge -- the CHECK below is
    -- the database's own backstop for reading-challenges.ts's validation, the
    -- same discipline books.rating's quarter-star CHECK already applies.
    target_count     integer check (target_count is null or target_count > 0),
    check ((kind = 'count') = (target_count is not null)),

    -- Optional filters that narrow what counts toward a 'count' challenge's
    -- progress (reading-challenges.ts's `readingChallengeProgress`). A
    -- 'prompts' challenge has no notion of "what counts" beyond its own items,
    -- so these stay null for one -- the second half of the CHECK above.
    category         text check (category is null or category in ('fiction', 'nonfiction')),
    format           text check (format is null or format in ('print', 'ebook', 'audiobook')),
    genre_id         uuid references genres(id) on delete set null,
    check (kind = 'count' or (category is null and format is null and genre_id is null)),

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

-- No updated_at trigger: only migration 0004's own tables have one (see
-- base.ts's header). Every UPDATE here sets updated_at itself.
--
-- /reading/challenges reads "this year's challenges first, older years
-- below" off this column before anything else -- the same reason
-- `books_status_idx` (migration 0030) leads with the column its own home
-- page sorts by first.
create index reading_challenges_household_year_idx
    on reading_challenges (household_id, year desc) where archived_at is null;

-- ─── reading_challenge_items ────────────────────────────────────────────────

create table reading_challenge_items (
    id             uuid primary key default gen_random_uuid(),
    challenge_id   uuid not null references reading_challenges(id) on delete cascade,
    -- Live items occupy a contiguous 1..N per challenge, exactly like
    -- `routine_steps.position` -- see that column's comment (migration 0031)
    -- for why an archived item keeps its old number rather than being
    -- renumbered, and the partial index below for the same reason repeated.
    position       integer not null,

    prompt         text not null check (length(trim(prompt)) between 1 and 500),
    -- The book that fills this prompt. Readability is checked in the same
    -- statement that sets it (reading-challenges.ts's `fillChallengeItem`),
    -- not here -- a CHECK constraint has no access to a Viewer, the same
    -- reason `routine_steps.habit_id` (migration 0031) is checked in its own
    -- repository rather than at this layer.
    book_id        uuid references books(id) on delete set null,
    -- Defaults to the household's own today when a book is set
    -- (reading-challenges.ts, using base.ts's householdToday) rather than
    -- here: "today" depends on the household's timezone, which a column
    -- default cannot see -- the same reasoning `books.tbr_added_on`
    -- (migration 0030) already follows. Clearing the book clears this too, so
    -- a date can never outlive the fill it belongs to.
    completed_on   date,
    check (book_id is not null or completed_on is null),

    archived_at    timestamptz,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    created_by     uuid references users(id) on delete set null,
    updated_by     uuid references users(id) on delete set null
);

-- Unique among LIVE items only. See the column comment above for why an
-- archived row is excluded rather than renumbered.
create unique index reading_challenge_items_position_idx
    on reading_challenge_items (challenge_id, position) where archived_at is null;
