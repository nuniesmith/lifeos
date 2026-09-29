-- Bills, subscriptions, income and savings (PACK4-002, the Financial Hub).
--
-- The household was explicit about scope: track recurring bills/subscriptions,
-- income and savings, "NOT every single transaction". Nothing here is a
-- ledger — there is no accounts or categories tree and no reconciliation
-- against a bank feed. And unlike `bills` (migration 0014), which arrived
-- already populated from a Notion database, the source's Income page was a
-- pair of rollup formulas over nothing (see /finance's own load, before this
-- migration added anything to show), so income and savings are built fresh,
-- with no rows to carry over and no importer to write.
--
-- Four things land together because they are one feature (Money at a Glance)
-- even though they are three new tables plus one addition to a fourth:
--
--  1. `bills` gains `type` (bill vs. subscription — a distinction the
--     household draws that was previously only implicit in a bill's name),
--     `trial_price` (what a trial converts to, so a free-trial bill can say
--     two prices instead of one), and `url` (a management/cancel link, the
--     same free-text-plus-safeLinkUrl-at-render shape `wishlist_items.url`
--     already uses — see migration 0014 and src/lib/server/markdown.ts).
--  2. `bill_payments` is a log, not a record with its own visibility: scoped
--     through `bills` the way `medication_doses` is scoped through
--     `medications` (migration 0018) rather than carrying a household_id of
--     its own. `previous_next_due_on` exists solely so an undo can put a
--     bill's due date back to exactly what it was, without re-deriving a
--     value that a later frequency change might get wrong — see
--     collections.ts's `recordBillPayment` / `deleteBillPayment`.
--  3. `income_entries` and `savings_contributions` are full records — the
--     household/owner/visibility/notion_page_id/source_record_id/audit
--     columns every other domain table carries (base.ts's `RecordBase`),
--     copying `bills`'s own shape and its default visibility of `household`.
--     `notion_page_id` / `source_record_id` stay even though nothing
--     populates them yet, for the same reason `health_measurements`
--     (migration 0019) carries them despite being built with no importer of
--     its own: a table built fresh today is still a domain table, and the day
--     an import does target it, the columns already exist to receive it.
--
-- `savings_contributions.goal_id` is ON DELETE SET NULL rather than CASCADE:
-- tidying up an old goal is not a reason to also lose the record that the
-- money was actually saved.

alter table bills
    add column type text not null default 'bill' check (type in ('bill', 'subscription')),
    add column trial_price numeric(12, 2) check (trial_price is null or trial_price >= 0),
    add column url text;

-- ─── bill payments ──────────────────────────────────────────────────────────

create table bill_payments (
    id                   uuid primary key default gen_random_uuid(),
    bill_id              uuid not null references bills(id) on delete cascade,

    amount_paid          numeric(12, 2) not null check (amount_paid > 0),
    paid_on              date not null,
    note                 text,
    -- What `next_due_on` was immediately before this payment moved it, so
    -- undoing this exact payment restores it precisely instead of
    -- re-deriving a value a later frequency change could get wrong.
    previous_next_due_on date,

    created_at           timestamptz not null default now(),
    created_by           uuid references users(id) on delete set null
);

-- "This bill's payments, most recent first" is the only question asked.
create index bill_payments_bill_idx on bill_payments (bill_id, paid_on desc, created_at desc);

-- ─── income ─────────────────────────────────────────────────────────────────

create table income_entries (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    title            text not null check (length(trim(title)) between 1 and 200),
    source           text,
    -- Free text, not a fixed list: "salary", "freelance", "gift" are all real
    -- and the household did not ask for a vocabulary to maintain.
    type             text,
    expected_amount  numeric(12, 2) check (expected_amount is null or expected_amount >= 0),
    actual_amount    numeric(12, 2) check (actual_amount is null or actual_amount >= 0),
    received_on      date not null,
    currency         text not null default 'CAD' check (length(currency) = 3),
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz,

    -- Mirrors the repository's own pre-check (base.ts's InvalidInput
    -- pattern): an income entry with neither amount recorded is not a fact
    -- about income, it is a blank row.
    constraint income_entries_amount_check
        check (expected_amount is not null or actual_amount is not null)
);

create index income_entries_month_idx on income_entries (household_id, received_on)
    where archived_at is null;

-- ─── savings ────────────────────────────────────────────────────────────────

create table savings_contributions (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    title            text not null check (length(trim(title)) between 1 and 200),
    amount           numeric(12, 2) not null check (amount > 0),
    contributed_on   date not null,
    goal_id          uuid references goals(id) on delete set null,
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index savings_contributions_month_idx on savings_contributions (household_id, contributed_on)
    where archived_at is null;
create index savings_contributions_goal_idx on savings_contributions (goal_id)
    where goal_id is not null and archived_at is null;
