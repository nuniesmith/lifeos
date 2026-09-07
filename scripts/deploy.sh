#!/usr/bin/env bash
# Runs ON the server. Deploys a specific image and refuses to leave the
# application running on a version that failed its health check.
#
#   LIFEOS_IMAGE=ghcr.io/nuniesmith/lifeos@sha256:... ./scripts/deploy.sh
#
# The ordering is the point (OPS-011): back up before migrating, migrate as a
# one-shot with the app stopped, keep PostgreSQL up throughout, then gate on
# health and roll back the app — never the database — if it fails.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

STATE_DIR="${LIFEOS_STATE_DIR:-/srv/lifeos}"
RELEASES="$STATE_DIR/releases"

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
# Polls until a condition holds, printing a dot each time round.
#
# The dots are the point. Every silent stretch in this script has cost a
# deploy: the SSH session is dropped from under a command that prints nothing
# for a minute or two, and it surfaces as ssh's own exit 255 with no error of
# ours to explain it. A waiter that says nothing is indistinguishable from a
# hung one to anything between here and the runner.
#
#   wait_for <attempts> <seconds-between> <command...>
wait_for() {
    local attempts=$1 pause=$2; shift 2
    local i elapsed
    for (( i = 0; i < attempts; i++ )); do
        "$@" && return 0
        # A COMPLETE LINE, not a dot. Dots without a newline sit in the output
        # buffer and never reach the far end: the first version of this printed
        # sixty of them into a buffer while the session was dropped underneath
        # it, which looked exactly like the silence it was written to prevent.
        # Every fifth attempt keeps the log readable without going quiet.
        if (( i % 5 == 0 )); then
            elapsed=$(( i * pause ))
            printf '  … still waiting (%ss)\n' "$elapsed"
        fi
        sleep "$pause"
    done
    return 1
}
ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

: "${LIFEOS_IMAGE:?LIFEOS_IMAGE must be set to the image to deploy}"
[[ -r .env && -w .env ]] || die ".env must be readable and writable; run scripts/setup-server.sh first"
# Resolve the symlink before replacing the file, so checkout/.env continues
# to point to the persistent environment on subsequent deployments.
ENV_FILE="$(readlink -f .env)"
COMPOSE=(docker compose -f compose.prod.yml --env-file "$ENV_FILE")

set_image() {
    LIFEOS_IMAGE="$1"
    export LIFEOS_IMAGE
    local pending
    pending=$(mktemp "${ENV_FILE}.XXXXXX")
    # Environment lookup avoids interpreting image text as an awk program.
    if ! awk '
        /^LIFEOS_IMAGE=/ { if (!found++) print "LIFEOS_IMAGE=" ENVIRON["LIFEOS_IMAGE"]; next }
        { print }
        END { if (!found) print "LIFEOS_IMAGE=" ENVIRON["LIFEOS_IMAGE"] }
    ' "$ENV_FILE" > "$pending"; then
        rm -f "$pending"
        die "could not update the image in $ENV_FILE"
    fi
    mv "$pending" "$ENV_FILE"
}

# ─── preflight ─────────────────────────────────────────────────────────────
say "Preflight"
free_kb=$(df --output=avail -k "$STATE_DIR" | tail -1)
(( free_kb > 2 * 1024 * 1024 )) || die "less than 2 GB free on $STATE_DIR; deploy would risk the database"
ok "$(( free_kb / 1024 / 1024 )) GB free"

# A deploy that starts while another is mid-flight can migrate twice.
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || die "another deploy holds the lock"

PREVIOUS=$(grep -E '^LIFEOS_IMAGE=' .env | cut -d= -f2- || true)
say "Deploying $LIFEOS_IMAGE"
[[ -n "$PREVIOUS" ]] && say "Current    $PREVIOUS"

# ─── pull first, so a bad reference fails before anything stops ────────────
say "Pulling image"
# Progress is NOT discarded, and that is deliberate. Silencing it made this the
# longest silent stretch of the deploy — minutes with nothing on the wire while
# an arm64 image comes down to the Pi — and the SSH session was being dropped
# underneath it, surfacing as ssh's own exit 255 with no error of ours to
# explain it. Without a TTY docker prints one plain line per layer rather than
# the redrawing progress bars, so this is both a keepalive and a useful log.
docker pull "$LIFEOS_IMAGE" || die "could not pull $LIFEOS_IMAGE"
ok "image present"

# ─── database up, and backed up before any migration ───────────────────────
say "Ensuring the database is running"
LIFEOS_IMAGE="$LIFEOS_IMAGE" "${COMPOSE[@]}" up -d db
db_ready() { "${COMPOSE[@]}" exec -T db pg_isready -q >/dev/null 2>&1; }
# 150 attempts at 2s is a five-minute budget. The run that succeeded took
# 2m23s just for this step, so two minutes was never enough on this host.
wait_for 150 2 db_ready || die "database did not become ready"
ok "database ready"

if [[ -x scripts/backup.sh ]]; then
    say "Pre-deploy backup"
    ./scripts/backup.sh --pre-deploy || die "backup failed; not migrating"
    ok "backup taken"
else
    say "Pre-deploy database backup"
    mkdir -p "$STATE_DIR/backups"
    backup=$(mktemp "$STATE_DIR/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
    if ! "${COMPOSE[@]}" exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$backup"; then
        rm -f "$backup"
        die "backup failed; not migrating"
    fi
    [[ -s "$backup" ]] || { rm -f "$backup"; die "backup was empty; not migrating"; }
    mv "$backup" "$backup.dump"
    ok "database backup taken"
fi

# ─── migrate with the app stopped ──────────────────────────────────────────
# Stopping the app first means no request can hit a half-migrated schema.
say "Stopping the application for migration"
"${COMPOSE[@]}" stop app 2>/dev/null || true

say "Running migrations"
# `compose ps --format json` has changed shape across Compose versions, so the
# result is checked rather than interpolated blindly — an empty value would
# become `docker run --network ""`, which fails with a message that says
# nothing about the real cause.
DB_NETWORK=$("${COMPOSE[@]}" ps --format json db 2>/dev/null | head -1 \
    | grep -o '"Networks":"[^"]*"' | cut -d'"' -f4 || true)
if [[ -z "$DB_NETWORK" ]]; then
    DB_NETWORK=$(docker inspect -f '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}}{{end}}' \
        "$("${COMPOSE[@]}" ps -q db)" 2>/dev/null | head -1 || true)
fi
[[ -n "$DB_NETWORK" ]] || die "could not determine the database network; is the db container running?"
say "Database network: $DB_NETWORK"

docker run --rm \
    --network "$DB_NETWORK" \
    --env-file "$ENV_FILE" \
    -e DATABASE_URL="$(grep -E '^MIGRATION_DATABASE_URL=' .env | cut -d= -f2- || grep -E '^DATABASE_URL=' .env | cut -d= -f2-)" \
    "$LIFEOS_IMAGE" node scripts/migrate.mjs \
    || die "migration failed; the application was not started on this image"
ok "migrations applied"

# ─── roll out ──────────────────────────────────────────────────────────────
say "Starting the application"
set_image "$LIFEOS_IMAGE"
"${COMPOSE[@]}" up -d app nginx

# ─── hard health gate ──────────────────────────────────────────────────────
say "Waiting for health"
app_live() { curl -fsS --max-time 3 http://127.0.0.1:8080/api/health/live >/dev/null 2>&1; }
healthy=false
wait_for 45 2 app_live && healthy=true

if [[ "$healthy" != true ]]; then
    printf '\033[31m✘\033[0m %s\n' "new image failed its health check"
    if [[ -n "$PREVIOUS" ]]; then
        say "Rolling back to $PREVIOUS"
        set_image "$PREVIOUS"
        "${COMPOSE[@]}" up -d app nginx
        # The database is never rolled back: a migration may already have
        # committed, and reversing it blindly is how data is lost.
        die "rolled back the application; the database was left as migrated"
    fi
    die "no previous image to roll back to"
fi
ok "application is live"

# Readiness is reported but does not gate: a stale backup or a disk warning
# should be visible without refusing an otherwise good deploy.
ready=$(curl -fsS --max-time 5 http://127.0.0.1:8080/api/health/ready || echo '{"status":"unreachable"}')
say "Readiness: $(echo "$ready" | head -c 200)"

# ─── reclaim disk (OPS-015) ────────────────────────────────────────────────
# Not silenced: this runs AFTER the health gate, so a connection dropped here
# would fail a deploy that had already succeeded — the worst way to lose one.
say "Pruning old images"
docker image prune -f
keep=3
mapfile -t old < <(docker images --filter=reference='ghcr.io/*/lifeos' --format '{{.ID}} {{.CreatedAt}}' \
    | sort -k2 -r | tail -n +$((keep + 1)) | cut -d' ' -f1)
for id in "${old[@]:-}"; do
    [[ -n "$id" ]] || continue
    say "Removing image $id"
    docker rmi "$id" >/dev/null 2>&1 || true
done
ok "kept the $keep most recent images"

mkdir -p "$RELEASES"
date -u +"%Y-%m-%dT%H:%M:%SZ $LIFEOS_IMAGE" >> "$RELEASES/history"
ok "deployed $LIFEOS_IMAGE"
