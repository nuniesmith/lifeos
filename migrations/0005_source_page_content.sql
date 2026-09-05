-- Page body and properties from the Markdown export (IMP-004).
--
-- The canonical CSVs carry properties but no body, so notes, checklists, and
-- rich text exist only in the per-row page files. Both are staged here beside
-- the CSV row so promotion has one place to read from, and so the properties
-- remain available as IMP-008 comparison fixtures.

alter table source_records
    add column body text,
    -- Properties exactly as the page file wrote them. Kept separately from
    -- `raw` rather than merged: where the two sources disagree, which one said
    -- what is the whole point of keeping them.
    add column page_properties jsonb not null default '{}'::jsonb,
    -- Local asset paths referenced by the body, resolved during media linking.
    add column body_images text[] not null default '{}';

-- Only a minority of rows have a body; the partial index keeps it small.
create index source_records_with_body on source_records (import_run_id)
    where body is not null;
