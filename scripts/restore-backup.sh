#!/usr/bin/env bash
# Restore an operational backup (BKP-003). Runs ON the server.
#
#   ./scripts/restore-backup.sh <dump>             stage and validate only
#   ./scripts/restore-backup.sh <dump> --apply     ...then switch to it
#
# Takes the same LIFEOS_COMPOSE_FILE, LIFEOS_ENV_FILE, LIFEOS_DB_SERVICE and
# LIFEOS_STATE_DIR as backup.sh, plus LIFEOS_APP_SERVICE (default `app`;
# `lifeos-app` on freddy).
#
# The live database is never restored over. The dump goes into a staging
# database beside it and is checked there: against the checksum and the
# per-table row counts backup.sh wrote next to it. Only with --apply, and
# only once that passes:
#
#   1. a backup of the live database, so the restore can itself be undone;
#   2. the app stops, and the two databases swap names in one transaction —
#      the live one is kept as <db>_pre_restore_<stamp>, not dropped;
#   3. every session is deleted, so nobody carries on as of the backup;
#   4. the app starts and must report its database and migrations ready, or
#      the names swap back and the app starts on the database it had.
#
# Uploads are not in the dump (BKP-001), so this restores the database only.
set -Eeuo pipefail

# backup.sh is beside this script, in this repo and in freddy's copy alike.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '2,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    echo "  --without-manifest   restore a dump that has no .sha256/.counts (unchecked)" >&2
    exit 2
}

DUMP=""
APPLY=0
WITHOUT_MANIFEST=0
for arg in "$@"; do
    case "$arg" in
        --apply) APPLY=1 ;;
        --without-manifest) WITHOUT_MANIFEST=1 ;;
        -h|--help) usage ;;
        -*) echo "unknown argument: $arg" >&2; usage ;;
        *) [[ -z "$DUMP" ]] || usage; DUMP="$arg" ;;
    esac
done
[[ -n "$DUMP" ]] || usage
[[ -f "$DUMP" ]] || die "no such file: $DUMP"
DUMP="$(readlink -f "$DUMP")"

ENV_FILE="$(readlink -f "${LIFEOS_ENV_FILE:-.env}" 2>/dev/null || echo "${LIFEOS_ENV_FILE:-.env}")"
[[ -r "$ENV_FILE" ]] || die "$ENV_FILE is not readable; set LIFEOS_ENV_FILE"
COMPOSE_FILE="${LIFEOS_COMPOSE_FILE:-compose.yml}"
DB="${LIFEOS_DB_SERVICE:-db}"
APP="${LIFEOS_APP_SERVICE:-app}"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

# As in backup.sh: only the two keys, never the whole file sourced.
env_value() {
    { grep -m1 "^$1=" "$ENV_FILE" || true; } | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//"
}
POSTGRES_USER="$(env_value POSTGRES_USER)"
POSTGRES_DB="$(env_value POSTGRES_DB)"
: "${POSTGRES_USER:?POSTGRES_USER missing from $ENV_FILE}"
: "${POSTGRES_DB:?POSTGRES_DB missing from $ENV_FILE}"
[[ "$POSTGRES_DB" =~ ^[a-z_][a-z0-9_]*$ ]] || die "POSTGRES_DB must be a plain lower-case name"

# psql against a named database; `postgres` is the maintenance database the
# official image always has, used whenever the live one is being renamed.
psql_on() {
    "${COMPOSE[@]}" exec -T "$DB" \
        psql -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -qtA -c "$2"
}
db_exists() {
    [[ "$(psql_on postgres "select 1 from pg_database where datname = '$1'")" == 1 ]]
}

STAMP=$(date -u +%Y%m%d%H%M%S)
STAGE="${POSTGRES_DB}_restore_${STAMP}"
PREVIOUS="${POSTGRES_DB}_pre_restore_${STAMP}"
IN_CONTAINER="/tmp/lifeos-restore-$$.dump"
STAGED=0
SWITCHED=0

cleanup() {
    "${COMPOSE[@]}" exec -T "$DB" rm -f "$IN_CONTAINER" >/dev/null 2>&1 || true
    if (( STAGED && ! SWITCHED )); then
        psql_on postgres "drop database if exists \"$STAGE\"" >/dev/null 2>&1 \
            || warn "could not drop the staging database $STAGE; drop it by hand"
    fi
}
trap cleanup EXIT

# ─── the file ──────────────────────────────────────────────────────────────
say "Checking $(basename "$DUMP")"
[[ "$(head -c 5 "$DUMP")" == "PGDMP" ]] || die "not a custom-format dump (no PGDMP header)"

COUNTS_FILE="$DUMP.counts"
if [[ -f "$DUMP.sha256" && -f "$COUNTS_FILE" ]]; then
    expected=$(cut -d' ' -f1 "$DUMP.sha256")
    actual=$(sha256sum "$DUMP" | cut -d' ' -f1)
    [[ "$expected" == "$actual" ]] || die "checksum mismatch: the dump is not the file that was backed up"
    ok "checksum matches"
elif (( WITHOUT_MANIFEST )); then
    warn "no .sha256/.counts beside the dump; restoring it unchecked"
    COUNTS_FILE=""
else
    die "no $(basename "$DUMP").sha256 and .counts beside it; pass --without-manifest to restore it unchecked"
fi

say "Checking the database is reachable"
"${COMPOSE[@]}" exec -T "$DB" pg_isready -q >/dev/null 2>&1 || die "database is not ready"
db_exists "$STAGE" && die "$STAGE already exists"

# ─── stage ─────────────────────────────────────────────────────────────────
say "Restoring into a staging database, $STAGE"
"${COMPOSE[@]}" cp "$DUMP" "$DB:$IN_CONTAINER" >/dev/null || die "could not copy the dump into the database container"
psql_on postgres "create database \"$STAGE\"" >/dev/null
STAGED=1
# --no-owner, so a dump from a host whose database user had another name
# still restores; the restoring user owns everything, as the app expects.
# One transaction: a restore that fails part-way leaves nothing half-loaded.
"${COMPOSE[@]}" exec -T "$DB" pg_restore -U "$POSTGRES_USER" -d "$STAGE" \
    --no-owner --no-acl --exit-on-error --single-transaction "$IN_CONTAINER" \
    || die "pg_restore failed; the live database was not touched"
ok "restored"

# ─── validate ──────────────────────────────────────────────────────────────
say "Checking what was restored"
[[ "$(psql_on "$STAGE" "select to_regclass('public.schema_migrations') is not null")" == t ]] \
    || die "the restored database has no schema_migrations; is this a LifeOS dump?"

# The same query backup.sh records the counts with.
RESTORED=$(psql_on "$STAGE" "
    select c.relname || E'\t' || (
        xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from public.%I', c.relname),
                           false, true, ''))
    )[1]::text
    from pg_class c
    join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind = 'r'
    order by c.relname")

if [[ -n "$COUNTS_FILE" ]]; then
    # backup.sh counts just after the dump, not inside its snapshot, so a
    # sign-in or a session in those seconds can move these few by a row or
    # two. A difference there is reported; anywhere else it fails.
    VOLATILE=" sessions auth_audit backup_runs "
    mismatches=0
    while IFS=$'\t' read -r table expected_n; do
        [[ -n "$table" ]] || continue
        restored_n=$(awk -F'\t' -v t="$table" '$1 == t { print $2 }' <<<"$RESTORED")
        if [[ -z "$restored_n" ]]; then
            warn "$table: missing from the restore"; mismatches=$((mismatches + 1))
        elif [[ "$restored_n" != "$expected_n" ]]; then
            if [[ "$VOLATILE" == *" $table "* ]]; then
                warn "$table: $restored_n rows, $expected_n recorded (expected to drift)"
            else
                warn "$table: $restored_n rows, $expected_n recorded"; mismatches=$((mismatches + 1))
            fi
        fi
    done < "$COUNTS_FILE"
    (( mismatches == 0 )) || die "$mismatches table(s) do not match the backup's counts"
    ok "$(grep -c . "$COUNTS_FILE") tables match the backup's row counts"
fi

if (( ! APPLY )); then
    ok "validated; nothing was changed. Run again with --apply to switch to it."
    exit 0
fi

# ─── switch ────────────────────────────────────────────────────────────────
# Undoable from here: a backup of what is live now, through the same script
# and checks as any other.
if db_exists "$POSTGRES_DB"; then
    say "Backing up the live database before replacing it"
    LIFEOS_COMPOSE_FILE="$COMPOSE_FILE" LIFEOS_ENV_FILE="$ENV_FILE" LIFEOS_DB_SERVICE="$DB" \
        "$SCRIPT_DIR/backup.sh" || die "the pre-restore backup failed; nothing was switched"
else
    say "No live $POSTGRES_DB database (a fresh host); nothing to back up first"
fi

say "Stopping $APP"
"${COMPOSE[@]}" stop "$APP" >/dev/null

# Both renames in one transaction: either both names change or neither does.
# A fresh host may have no live database yet; then there is nothing to keep.
swap_in() {
    if db_exists "$POSTGRES_DB"; then
        psql_on postgres "
            select pg_terminate_backend(pid) from pg_stat_activity
            where datname = '$POSTGRES_DB' and pid <> pg_backend_pid()" >/dev/null
        psql_on postgres "begin;
            alter database \"$POSTGRES_DB\" rename to \"$PREVIOUS\";
            alter database \"$STAGE\" rename to \"$POSTGRES_DB\";
            commit;" >/dev/null
    else
        psql_on postgres "alter database \"$STAGE\" rename to \"$POSTGRES_DB\"" >/dev/null
    fi
}
swap_back() {
    psql_on postgres "
        select pg_terminate_backend(pid) from pg_stat_activity
        where datname = '$POSTGRES_DB' and pid <> pg_backend_pid()" >/dev/null
    if db_exists "$PREVIOUS"; then
        psql_on postgres "begin;
            alter database \"$POSTGRES_DB\" rename to \"$STAGE\";
            alter database \"$PREVIOUS\" rename to \"$POSTGRES_DB\";
            commit;" >/dev/null
    else
        psql_on postgres "alter database \"$POSTGRES_DB\" rename to \"$STAGE\"" >/dev/null
    fi
}

# Puts the app back on the database it had and stops, from any point after
# the switch. If even that fails, says exactly what state it left.
roll_back() {
    warn "$1; switching back"
    "${COMPOSE[@]}" stop "$APP" >/dev/null 2>&1 || true
    if ! swap_back; then
        trap - EXIT
        die "could not switch back: $APP is stopped, the restore is live as $POSTGRES_DB and the old database is $PREVIOUS. Rename them by hand, then start $APP."
    fi
    SWITCHED=0
    "${COMPOSE[@]}" start "$APP" >/dev/null
    die "restore rolled back; the app is on the database it had, and the restore was dropped"
}

say "Switching to the restored database"
swap_in || { "${COMPOSE[@]}" start "$APP" >/dev/null; die "could not switch; the app is back on the database it had"; }
SWITCHED=1

# Sessions in the dump are as old as the backup, and the people holding them
# may have signed out or changed their password since.
say "Signing everyone out"
psql_on "$POSTGRES_DB" "delete from sessions" >/dev/null || roll_back "could not delete the restored sessions"

say "Starting $APP"
"${COMPOSE[@]}" start "$APP" >/dev/null

# Readiness from inside the container, which counts as loopback and so gets
# each check's result. Only the database and migrations decide: a restored
# backup_runs is as old as the backup, and the disk is not this restore's.
ready() {
    local body
    body=$("${COMPOSE[@]}" exec -T "$APP" curl -sS http://127.0.0.1:3000/api/health/ready 2>/dev/null) || return 1
    [[ "$body" == *'"name":"database","status":"ok"'* && "$body" == *'"name":"migrations","status":"ok"'* ]]
}
say "Waiting for $APP to report ready"
for _ in $(seq 1 30); do
    ready && break
    sleep 2
done
ready || roll_back "$APP did not come back ready on the restored database"

ok "restored $(basename "$DUMP") and switched to it"
if db_exists "$PREVIOUS"; then
    echo "  The database it replaced is kept as $PREVIOUS. Once you are sure:"
    echo "    ${COMPOSE[*]} exec -T $DB dropdb -U $POSTGRES_USER $PREVIOUS"
fi
