-- The reading log: one row per read-through, per person (Reading Tracker R2).
--
-- R1 (migration 0030) gave every book exactly one status and one rating --
-- fine for "have I read this", wrong for "how many times", and wrong the
-- moment two people share a copy: Kayla finishing a book the operator has
-- not even started cannot be recorded as a change to the book's own
-- `status`, which holds only one value for both of them. `book_reads` is
-- that missing per-person history. A re-read is a new row, so "read count"
-- is `count(*)` over a reader's finished rows, never a number stored
-- anywhere -- there is nothing to keep in step if it is never written down.
--
-- It carries no household_id or visibility of its own -- the same shape as
-- `bill_payments` (migration 0029), scoped through `bills` -- because a read
-- is not a record someone owns independently of the book it is a read of. A
-- read is visible to whoever can read the book (reading.ts's readableScope,
-- reached by joining through book_id), but writable only by the reader who
-- logged it: narrower than the book itself, which either household member
-- may edit. That narrower rule has nowhere to live but the repository and
-- this migration's own indexes, because a CHECK constraint cannot see a
-- Viewer.
--
-- No archived_at. A mistaken read is not "still true, just not active" the
-- way an unmade recipe or a cancelled task is -- it is simply wrong, the same
-- reading `habit_logs` (migration 0004) and `food_log_entries` (migration
-- 0032) both take, and like them it is corrected by deleting the row
-- outright, not by hiding it.
--
-- No updated_at trigger: only migration 0004's own tables have one (see
-- base.ts's header). Every UPDATE here sets updated_at itself.

create table book_reads (
    id               uuid primary key default gen_random_uuid(),
    book_id          uuid not null references books(id) on delete cascade,
    -- NOT NULL and cascading, unlike most owner columns in this schema
    -- (which are optional and `on delete set null`, because a household
    -- record can be unowned): a read has no meaning without the person who
    -- did it, the same reasoning `food_log_entries.owner_user_id` (migration
    -- 0032) already applies to an eaten meal.
    reader_user_id   uuid not null references users(id) on delete cascade,

    status           text not null default 'reading'
                          check (status in ('reading', 'paused', 'finished', 'dnf')),

    -- Both nullable: a backfilled read (typed in long after the fact, or
    -- imported someday from StoryGraph) may not know exactly when it started
    -- or ended.
    started_on       date,
    finished_on      date,
    check (finished_on is null or started_on is null or finished_on >= started_on),
    -- A read only finishes by being finished or abandoned; "reading" or
    -- "paused" with a finish date would be a read that is simultaneously
    -- open and over.
    check (finished_on is null or status in ('finished', 'dnf')),

    -- Defaults to the book's own format when the read starts (reading-log.ts's
    -- `startRead`) rather than here, because a column default cannot see the
    -- book it belongs to. Free to differ from it afterwards: a reader can
    -- switch from the ebook to the audiobook partway through.
    format           text check (format is null or format in ('print', 'ebook', 'audiobook')),
    progress_pages   integer check (progress_pages is null or progress_pages >= 0),
    progress_minutes integer check (progress_minutes is null or progress_minutes >= 0),

    -- Quarter stars, the same CHECK as `books.rating` (migration 0030) --
    -- this read's own rating, which `finishRead` also copies onto the book
    -- when the book has none yet, so a first read rates the catalogue entry.
    rating           numeric(3, 2) check (rating is null or
                          (rating between 0 and 5 and rating * 4 = round(rating * 4))),
    -- Markdown, rendered with renderMarkdown like a book's own description.
    review           text,
    dnf_reason       text,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null
);

-- At most one active read per book per reader: starting a book you are
-- already reading, or already have paused, is refused rather than silently
-- opening a second thread of progress through the same copy.
create unique index book_reads_one_active_idx on book_reads (book_id, reader_user_id)
    where status in ('reading', 'paused');

-- The book page's own history, and the series hub / read-count queries that
-- join from a set of books to their reads.
create index book_reads_book_idx on book_reads (book_id);
-- `activeReads(viewer)`: one person's own reading/paused reads across every
-- book, which is the Reading Tracker home page's "Currently reading".
create index book_reads_reader_idx on book_reads (reader_user_id, status);
