-- Backup bookkeeping (BKP-001).
--
-- Readiness already reports on backup freshness and has been answering
-- "degraded: not yet implemented" because this table did not exist. A backup
-- that runs but is never recorded cannot be alerted on, so the record is part
-- of the feature rather than an addition to it.

create table backup_runs (
    id            uuid primary key default gen_random_uuid(),
    started_at    timestamptz not null default now(),
    finished_at   timestamptz,
    status        text        not null default 'running'
                               check (status in ('running','success','failed')),
    -- 'pre_deploy' backups are taken automatically before a migration;
    -- 'scheduled' by the timer; 'manual' by an operator.
    kind          text        not null default 'manual'
                               check (kind in ('manual','scheduled','pre_deploy')),
    file_path     text,
    byte_size     bigint,
    sha256        bytea,
    -- Row counts at backup time, so a restore can be checked against them
    -- rather than merely completing without error.
    table_counts  jsonb       not null default '{}'::jsonb,
    error         text
);

create index backup_runs_recent on backup_runs (finished_at desc)
    where status = 'success';
