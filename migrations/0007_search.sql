-- Household-scoped full-text search (UI-010).
--
-- Expression indexes rather than stored tsvector columns: the searchable text
-- is just the record's own fields, so a generated column would duplicate them
-- and give a second place for the two to disagree. PostgreSQL can use an
-- expression index directly for the same query.
--
-- 'english' is the configuration throughout. It is what this household writes
-- in, and stemming matters more than exactness here — searching "walking"
-- should find "walk".

create index tasks_search on tasks using gin (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(notes, ''))
);

create index projects_search on projects using gin (
    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, ''))
);

create index goals_search on goals using gin (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
);

create index areas_search on areas using gin (
    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, ''))
);

create index important_dates_search on important_dates using gin (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(notes, ''))
);

-- Daily logs are searchable only by their author. The index does not enforce
-- that — the query does — but the whole entry is indexed because a person
-- searching their own journal expects to find any of it.
create index daily_logs_search on daily_logs using gin (
    to_tsvector('english',
        coalesce(note, '') || ' ' || coalesce(gratitude, '') || ' ' ||
        coalesce(highlight, '') || ' ' || coalesce(mood, ''))
);
