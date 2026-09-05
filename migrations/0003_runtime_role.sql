-- Least-privilege runtime role (DB-001).
--
-- Migrations run as the owner (MIGRATION_DATABASE_URL). The application runs
-- as lifeos_runtime, which can read and write rows but cannot change schema,
-- and cannot rewrite history in the two append-only tables.
--
-- In development both URLs point at the same superuser-ish role and this
-- migration is effectively a no-op beyond creating the role. In production the
-- two are different, which is the point.

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'lifeos_runtime') then
        -- No password here: it is set out of band by OPS-007 so a credential
        -- never enters the repository or the migration history.
        create role lifeos_runtime login;
    end if;
end
$$;

-- GRANT does not accept a function as the database name, so this one grant
-- has to be assembled dynamically.
do $$
begin
    execute format('grant connect on database %I to lifeos_runtime', current_database());
end
$$;

grant usage on schema public to lifeos_runtime;

-- Row access for normal operation.
grant select, insert, update, delete on all tables    in schema public to lifeos_runtime;
grant usage, select                  on all sequences in schema public to lifeos_runtime;

-- Tables created by later migrations inherit the same grants, so a new table
-- is never accidentally unreadable — or accidentally droppable — by the app.
alter default privileges in schema public
    grant select, insert, update, delete on tables to lifeos_runtime;
alter default privileges in schema public
    grant usage, select on sequences to lifeos_runtime;

-- ─── append-only surfaces ──────────────────────────────────────────────────
-- Audit and change history exist to be evidence. The application writes them
-- and reads them; it must not be able to edit or erase them. An operator with
-- the owner role still can, which is accepted and documented.
revoke update, delete on auth_audit  from lifeos_runtime;
revoke update, delete on change_log  from lifeos_runtime;

-- schema_migrations is the runner's bookkeeping; the app has no business in it.
revoke insert, update, delete on schema_migrations from lifeos_runtime;

-- Explicitly deny schema modification. Ownership already prevents this, but
-- stating it makes the intent auditable rather than implied.
revoke create on schema public from lifeos_runtime;
