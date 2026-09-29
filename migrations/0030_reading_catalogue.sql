-- The Reading Tracker's book catalogue: books, authors, series and genres
-- (Reading Tracker R1).
--
-- Notion had a Reading Tracker workspace, but the household never adopted it
-- — "everything is new, so will start to use in the future" — so there is no
-- import to shape this around and nothing below mirrors a Notion column. It
-- is built fresh from the field set the operator chose today, kept
-- deliberately narrow: the reading log (one row per read-through, so a reread
-- is its own record), the TBR picker and a series hub's "next book" are R2;
-- StoryGraph's CSV import, challenges and insights are R3. An additive
-- migration is easy to widen later and hard to narrow once shipped, so
-- nothing from those two packs is guessed at here.
--
-- `authors`, `book_series` and `genres` are reference data shaped like `tags`
-- — household-scoped, with no owner or visibility of their own — rather than
-- full domain records. Unlike `people` or `ingredients` (migration 0016),
-- nothing populates them but the household typing a name into a book, so
-- there is no import history of duplicate labels to protect, and a genuine
-- unique, case-insensitive name is safe to enforce at the database rather
-- than only in the repository. The uniqueness is partial — "among live
-- rows" — so archiving "Cozy Mystery" and later typing it again does not
-- collide with the archived row.
--
-- `books` is a full owned record — household_id/owner_user_id/visibility,
-- notion_page_id/source_record_id included even though nothing imports into
-- it yet — so it shares base.ts's RecordBase shape with every other domain
-- table (see `bills`, migration 0014, for the same shape applied plainly).

-- ─── authors ─────────────────────────────────────────────────────────────

create table authors (
    id           uuid primary key default gen_random_uuid(),
    household_id uuid not null references households(id) on delete cascade,

    name         text not null check (length(trim(name)) between 1 and 200),
    notes        text,

    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    created_by   uuid references users(id) on delete set null,
    updated_by   uuid references users(id) on delete set null,
    archived_at  timestamptz
);

-- Case-insensitive and unique among live rows only: an archived author can be
-- re-created under the same name without the two ever colliding.
create unique index authors_name_idx on authors (household_id, lower(trim(name)))
    where archived_at is null;

-- ─── series ────────────────────────────────────────────────────────────────

create table book_series (
    id            uuid primary key default gen_random_uuid(),
    household_id  uuid not null references households(id) on delete cascade,

    name          text not null check (length(trim(name)) between 1 and 200),
    notes         text,
    -- How many books the series is expected to run to, for "book 3 of 7" on
    -- the series hub (R2). Null means unknown, never zero.
    planned_count integer check (planned_count is null or planned_count > 0),

    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    created_by    uuid references users(id) on delete set null,
    updated_by    uuid references users(id) on delete set null,
    archived_at   timestamptz
);

create unique index book_series_name_idx on book_series (household_id, lower(trim(name)))
    where archived_at is null;

-- ─── genres ────────────────────────────────────────────────────────────────

create table genres (
    id           uuid primary key default gen_random_uuid(),
    household_id uuid not null references households(id) on delete cascade,

    name         text not null check (length(trim(name)) between 1 and 100),
    notes        text,

    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    created_by   uuid references users(id) on delete set null,
    updated_by   uuid references users(id) on delete set null,
    archived_at  timestamptz
);

create unique index genres_name_idx on genres (household_id, lower(trim(name)))
    where archived_at is null;

-- ─── books ───────────────────────────────────────────────────────────────

create table books (
    id                uuid primary key default gen_random_uuid(),
    household_id      uuid not null references households(id) on delete cascade,
    owner_user_id     uuid references users(id) on delete set null,
    visibility        visibility_kind not null default 'household',

    title             text not null check (length(trim(title)) between 1 and 300),
    subtitle          text,

    -- A series member survives its series being deleted; it simply falls out
    -- of the series rather than disappearing with it.
    series_id         uuid references book_series(id) on delete set null,
    -- numeric(6,2), not an integer: a novella slotted between books 1 and 2
    -- is a real position (1.5), the way StoryGraph and Goodreads both allow.
    series_position   numeric(6, 2) check (series_position is null or series_position > 0),

    status            text not null default 'tbr'
                      check (status in ('tbr', 'reading', 'paused', 'read', 'dnf')),
    category          text check (category is null or category in ('fiction', 'nonfiction')),
    audience          text check (audience is null or audience in
                          ('adult', 'young_adult', 'middle_grade', 'children')),
    format            text check (format is null or format in ('print', 'ebook', 'audiobook')),
    owned             boolean not null default false,

    pages             integer check (pages is null or pages > 0),
    audiobook_minutes integer check (audiobook_minutes is null or audiobook_minutes > 0),
    -- Hyphens and spaces stripped, 10 or 13 digits. The check digit is not
    -- verified here or in the repository — see reading.ts's `optionalIsbn`.
    isbn              text check (isbn is null or isbn ~ '^[0-9]{10}$|^[0-9]{13}$'),
    release_date      date,

    -- StoryGraph rates in quarter stars: `rating * 4` must land on a whole
    -- number, so 3.25 and 3.5 are valid and 3.3 is not.
    rating            numeric(3, 2) check (rating is null or
                          (rating between 0 and 5 and rating * 4 = round(rating * 4))),
    favourite         boolean not null default false,
    spice             smallint check (spice is null or spice between 0 and 5),
    pace              text check (pace is null or pace in ('slow', 'medium', 'fast')),

    -- Free-form labels, cleaned by the repository (trimmed, blanks dropped,
    -- deduped case-insensitively keeping the first spelling) rather than
    -- constrained here: what a household calls a trope is theirs to spell.
    tropes            text[] not null default '{}',
    moods             text[] not null default '{}',
    tags              text[] not null default '{}',
    content_warnings  text,

    -- Markdown, rendered with renderMarkdown like the library's notes.
    description       text,
    notes             text,
    -- Free text, rendered only through safeLinkUrl ($lib/server/markdown) —
    -- never trusted as a link outright, the same rule a recipe's source url
    -- follows.
    storygraph_url    text,
    recommended_by    text,
    -- Defaults to the household's own today when a book is created with
    -- status 'tbr' (reading.ts, using base.ts's householdToday) rather than
    -- here: "today" depends on the household's timezone, which a column
    -- default cannot see.
    tbr_added_on      date,

    notion_page_id    uuid unique,
    source_record_id  uuid references source_records(id) on delete set null,

    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    created_by        uuid references users(id) on delete set null,
    updated_by        uuid references users(id) on delete set null,
    archived_at       timestamptz
);

-- The Reading Tracker home reads "currently reading", "up next" and
-- "recently read" off this column before anything else.
create index books_status_idx on books (household_id, status) where archived_at is null;
-- The series hub's one query: every book in a series, in position order.
create index books_series_idx on books (series_id, series_position)
    where series_id is not null;

-- ─── book ↔ author ───────────────────────────────────────────────────────

create table book_authors (
    book_id   uuid not null references books(id) on delete cascade,
    author_id uuid not null references authors(id) on delete cascade,
    -- Author order on the cover (editor vs. co-author, or a series' rotating
    -- writers). Null is "unordered", not "first".
    position  smallint,
    primary key (book_id, author_id)
);

create index book_authors_author_idx on book_authors (author_id);

-- ─── book ↔ genre ────────────────────────────────────────────────────────

create table book_genres (
    book_id  uuid not null references books(id) on delete cascade,
    genre_id uuid not null references genres(id) on delete cascade,
    primary key (book_id, genre_id)
);

create index book_genres_genre_idx on book_genres (genre_id);
