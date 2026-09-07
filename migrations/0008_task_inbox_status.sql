-- The inbox is a status, not a view (UI: Quick Drop | Inbox).
--
-- The Notion workspace models capture as a Status value — "In inbox" — and it
-- is the largest single group in the export: 14 of 32 tasks. The import's
-- status table has no entry for it, so every one of them would have landed on
-- the `todo` fallback and the inbox would have imported empty while the run
-- reported success.
--
-- Deriving it instead ("todo with no project and no area") was the
-- alternative and is wrong: a task can be deliberately unfiled and still not
-- be awaiting triage, and it would reappear in the inbox forever. Notion
-- treats "not yet decided" as a distinct state and so does this.
--
-- `inbox` is an OPEN status: an untriaged task is still work. It is added
-- ahead of 'todo' in the list because that is the order the states occur in.

alter table tasks drop constraint tasks_status_check;

alter table tasks add constraint tasks_status_check
    check (status = any (array['inbox', 'todo', 'in_progress', 'blocked', 'done', 'dropped']));

-- Partial index: the inbox view asks for exactly this and is expected to be
-- small relative to the table, so the index stays small too.
create index tasks_inbox_idx on tasks (household_id, created_at desc)
    where status = 'inbox' and archived_at is null;
