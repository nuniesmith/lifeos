-- Life Admin HQ: documents and renewals (PACK5-001).
--
-- The source's "Life Admin HQ" dashboard exported empty -- its database had no
-- rows, only a page nobody had filled in. The household defined the scope
-- themselves: IDs, insurance, warranties, licences and the like, for each one
-- what they hold, whose it is, where it lives, when it expires, and a
-- reminder before it does. There is no importer work here and nothing to
-- carry over; this is built fresh, the same position `income_entries` and
-- `savings_contributions` started from (migration 0029). `notion_page_id` and
-- `source_record_id` still ride along on `documents`, for the same reason
-- those two carry them despite having no importer of their own: the day an
-- import does target this table, the columns already exist to receive it.
--
-- `documents` defaults to `private`, unlike most of this schema's tables
-- (bills, recipes, lab results...), which default to `household` because they
-- are facts a household manages together. A document is the opposite default
-- for the same reason a daily log is (migration 0004): a passport or a
-- driver's licence is one person's thing first, and the household's second,
-- only when its owner chooses to share it (the home insurance policy, say).
-- So `owner_user_id` defaults to the creator rather than to nobody, matching
-- `daily_logs`' own shape, not `bills`'.
--
-- `holder_person_id` points at `people` (migration 0014) rather than adding a
-- second table: a document's holder is a person already modelled there, or a
-- pet (a pet's vaccination record or registration tag). It is `on delete set
-- null`, matching every other optional person-reference in this schema
-- (migration 0028's header has the fuller reasoning): removing a person must
-- not delete the fact that a document exists.
--
-- `document_renewals` is a log, not a record with its own visibility --
-- scoped through `documents` the way `bill_payments` is scoped through
-- `bills` (migration 0029): no `household_id`, no `archived_at`, and a wrong
-- entry is deleted outright rather than archived. `previous_expires_on`
-- exists for the same reason `bill_payments.previous_next_due_on` does: an
-- undo needs to put `expires_on` back to exactly what it was, without
-- re-deriving a value nothing else recorded.

create table documents (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'private',

    title            text not null check (length(trim(title)) between 1 and 200),
    kind             text not null default 'other'
                     check (kind in (
                         'id', 'insurance', 'warranty', 'licence', 'registration',
                         'membership', 'certificate', 'other'
                     )),
    holder_person_id uuid references people(id) on delete set null,
    issuer           text,
    -- Free text; the form's own hint is "last 4 digits only". Never selected
    -- by the list, search or Today card queries below -- only the document's
    -- own page reads this column.
    reference        text,
    issued_on        date,
    -- Null means the document never expires (a birth certificate, most
    -- memberships without a renewal date) -- a different fact from "expiring
    -- today", which `attentionState` in the repository tells apart.
    expires_on       date,
    -- How many days of warning before `expires_on` counts as "due". A CHECK
    -- rather than left unbounded: 0 means "only once it expires", and 365 is
    -- a full year of lead time, past which "due" would stop meaning anything
    -- near-term.
    renew_lead_days  integer not null default 30 check (renew_lead_days between 0 and 365),
    -- Where the original or a copy actually lives: "fire safe", "Google
    -- Drive". Free text, like `bills.account` -- this schema does not get to
    -- enumerate a household's storage.
    location         text,
    -- Free text, rendered only through `safeLinkUrl` at display time, the
    -- same shape `bills.url` and `wishlist_items.url` already use.
    url              text,
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

-- What a holder's own page will eventually ask of this table, and nothing
-- else needs: partial, like `wishlist_person_idx`, since most documents (and
-- every document naming a pet rather than a person) may have no holder set.
create index documents_holder_idx on documents (holder_person_id)
    where holder_person_id is not null;

-- The Today card and /life-admin's own "needs attention" query both ask
-- "what expires soonest", the same shape `bills_due_idx` and
-- `medical_visits_upcoming_idx` already take for their own due-date columns.
create index documents_expires_idx on documents (household_id, expires_on)
    where archived_at is null;

-- ─── document renewals ──────────────────────────────────────────────────────

create table document_renewals (
    id                  uuid primary key default gen_random_uuid(),
    document_id         uuid not null references documents(id) on delete cascade,

    renewed_on          date not null,
    -- Null the first time a document with no prior expiry is given one;
    -- `bill_payments.previous_next_due_on` is nullable for the identical
    -- reason.
    previous_expires_on date,
    new_expires_on      date not null,
    note                text,

    created_at          timestamptz not null default now(),
    created_by          uuid references users(id) on delete set null
);

-- "This document's renewal history, most recently entered first" is the only
-- question asked -- the same shape `bill_payments_bill_idx` takes, ordered by
-- `created_at` alone rather than also by a paid-on-style date: undo always
-- means the entry made last (see `deleteRenewal`'s own header), not the one
-- with the latest `renewed_on`.
create index document_renewals_document_idx on document_renewals (document_id, created_at desc);
