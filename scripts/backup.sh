#!/usr/bin/env bash
# Database backup (BKP-001). Runs ON the server.
#
#   ./scripts/backup.sh                 a manual backup
#   ./scripts/backup.sh --pre-deploy    what deploy.sh calls before migrating
#   ./scripts/backup.sh --scheduled     what the systemd timer calls
#
# A backup is only a backup if it can be restored, so this records what it
# captured — size, checksum, and per-table row counts — and refuses to report
# success on a dump it cannot verify. The counts are what a restore is checked
# against later; "pg_restore exited 0" is not evidence that the data came back.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

STATE_DIR="${LIFEOS_STATE_DIR:-/srv/lifeos}"
BACKUP_DIR="$STATE_DIR/backups"
RETENTION_DAYS="${LIFEOS_BACKUP_RETENTION_DAYS:-14}"
KIND="manual"

for arg in "$@"; do
    case "$arg" in
        --pre-deploy) KIND="pre_deploy" ;;
        --scheduled)  KIND="scheduled" ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✔\033[0m %s\n' "$*"; }
die() { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

ENV_FILE="$(readlink -f .env 2>/dev/null || echo .env)"
[[ -r "$ENV_FILE" ]] || die ".env is not readable; run scripts/setup-server.sh"
# Overridable so the script can be exercised against the development
# stack; production leaves it at the default.
COMPOSE_FILE="${LIFEOS_COMPOSE_FILE:-compose.prod.yml}"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

psql_q() { "${COMPOSE[@]}" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA -c "$1"; }

set -a; . "$ENV_FILE"; set +a
: "${POSTGRES_USER:?POSTGRES_USER missing from .env}"
: "${POSTGRES_DB:?POSTGRES_DB missing from .env}"

mkdir -p "$BACKUP_DIR"

# ─── preflight ─────────────────────────────────────────────────────────────
"${COMPOSE[@]}" exec -T db pg_isready -q || die "database is not ready"

free_kb=$(df --output=avail -k "$BACKUP_DIR" | tail -1)
(( free_kb > 512 * 1024 )) || die "less than 512 MB free in $BACKUP_DIR"

# The bookkeeping table is created by a migration, and this script runs
# *before* migrations on purpose — so on the deploy that first introduces it,
# the table does not exist yet. Recording is therefore optional: a backup that
# refuses to run because it cannot log itself is worse than an unlogged
# backup, and that ordering blocked a real deploy.
HAS_RUNS_TABLE=$(psql_q "select to_regclass('public.backup_runs') is not null" | tr -d '[:space:]')
RUN_ID=""
if [[ "$HAS_RUNS_TABLE" == "t" ]]; then
    RUN_ID=$(psql_q "insert into backup_runs (kind) values ('$KIND') returning id" | tr -d '[:space:]')
fi
[[ -n "$RUN_ID" ]] || say "backup_runs is not available yet; taking the backup without recording it"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$BACKUP_DIR/lifeos-$KIND-$STAMP.dump"

fail_run() {
    local message="$1"
    if [[ -z "$RUN_ID" ]]; then
        rm -f "$TARGET.partial"
        die "$message"
    fi
    # Single quotes are doubled for SQL rather than shell-escaped: %q produced
    # a backslash-escaped string that was stored verbatim and read badly.
    local escaped="${message//\'/\'\'}"
    psql_q "update backup_runs set status='failed', finished_at=now(),
            error='${escaped}' where id='$RUN_ID'" >/dev/null 2>&1 || true
    rm -f "$TARGET.partial"
    die "$message"
}

# ─── dump ──────────────────────────────────────────────────────────────────
say "Dumping $POSTGRES_DB ($KIND)"
if ! "${COMPOSE[@]}" exec -T db sh -c \
        'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
        > "$TARGET.partial"; then
    fail_run "pg_dump failed"
fi

[[ -s "$TARGET.partial" ]] || fail_run "dump is empty"

# ─── verify before claiming success ────────────────────────────────────────
# A custom-format dump that pg_restore cannot list is not a backup. This is
# the cheapest check that distinguishes "a file exists" from "a file that can
# be read back".
say "Verifying the archive"

# Cheap gate first: a custom-format dump begins with the PGDMP magic.
if [[ "$(head -c 5 "$TARGET.partial")" != "PGDMP" ]]; then
    fail_run "dump does not carry the PGDMP header"
fi

# Then the real check: pg_restore must be able to parse the whole table of
# contents. It has to be a seekable file — piping the archive to /dev/stdin
# or to `-` both fail on a custom-format archive, so it is copied in first.
VERIFY_PATH="/tmp/lifeos-verify-$$.dump"
if ! "${COMPOSE[@]}" cp "$TARGET.partial" "db:$VERIFY_PATH" >/dev/null 2>&1; then
    fail_run "could not stage the archive for verification"
fi
if ! "${COMPOSE[@]}" exec -T db pg_restore --list "$VERIFY_PATH" >/dev/null 2>&1; then
    "${COMPOSE[@]}" exec -T db rm -f "$VERIFY_PATH" >/dev/null 2>&1 || true
    fail_run "pg_restore could not read the archive"
fi
"${COMPOSE[@]}" exec -T db rm -f "$VERIFY_PATH" >/dev/null 2>&1 || true

mv "$TARGET.partial" "$TARGET"
chmod 600 "$TARGET"

BYTES=$(stat -c %s "$TARGET")
SHA=$(sha256sum "$TARGET" | cut -d' ' -f1)

# Row counts per table, recorded so a restore can be checked against them.
COUNTS=$(psql_q "
    select coalesce(jsonb_object_agg(relname, n), '{}'::jsonb)::text from (
        select c.relname, (
            xpath('/row/c/text()',
                  query_to_xml(format('select count(*) as c from public.%I', c.relname),
                               false, true, ''))
        )[1]::text::bigint as n
        from pg_class c
        join pg_namespace s on s.oid = c.relnamespace
        where s.nspname = 'public' and c.relkind = 'r'
    ) t" | tr -d '\n')

if [[ -n "$RUN_ID" ]]; then
    psql_q "update backup_runs set status='success', finished_at=now(),
            file_path='$TARGET', byte_size=$BYTES,
            sha256=decode('$SHA','hex'),
            table_counts='${COUNTS:-{\}}'::jsonb
            where id='$RUN_ID'" >/dev/null
fi

ok "$(numfmt --to=iec "$BYTES" 2>/dev/null || echo "$BYTES bytes") -> $(basename "$TARGET")"

# ─── retention ─────────────────────────────────────────────────────────────
# Pre-deploy backups are kept longer than their age would suggest only in the
# sense that the newest is always retained: deleting every backup on a quiet
# system would leave nothing to restore from.
say "Applying $RETENTION_DAYS-day retention"
mapfile -t old < <(find "$BACKUP_DIR" -name 'lifeos-*.dump' -mtime "+$RETENTION_DAYS" -print | sort)
newest=$(find "$BACKUP_DIR" -name 'lifeos-*.dump' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
removed=0
for f in "${old[@]:-}"; do
    [[ -n "$f" && "$f" != "$newest" ]] || continue
    rm -f "$f" && removed=$((removed + 1))
done
ok "removed $removed expired backup(s); $(find "$BACKUP_DIR" -name 'lifeos-*.dump' | wc -l) retained"
