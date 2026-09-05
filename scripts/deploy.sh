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

COMPOSE="docker compose -f compose.prod.yml --env-file .env"
STATE_DIR="${LIFEOS_STATE_DIR:-/srv/lifeos}"
RELEASES="$STATE_DIR/releases"

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

: "${LIFEOS_IMAGE:?LIFEOS_IMAGE must be set to the image to deploy}"
[[ -f .env ]] || die ".env is missing; run scripts/setup-server.sh first"

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
docker pull "$LIFEOS_IMAGE" >/dev/null || die "could not pull $LIFEOS_IMAGE"
ok "image present"

# ─── database up, and backed up before any migration ───────────────────────
say "Ensuring the database is running"
LIFEOS_IMAGE="$LIFEOS_IMAGE" $COMPOSE up -d db
for _ in $(seq 1 60); do
    $COMPOSE exec -T db pg_isready -q && break
    sleep 2
done
$COMPOSE exec -T db pg_isready -q || die "database did not become ready"
ok "database ready"

if [[ -x scripts/backup.sh ]]; then
    say "Pre-deploy backup"
    ./scripts/backup.sh --pre-deploy || die "backup failed; not migrating"
    ok "backup taken"
else
    # Explicit rather than silent: migrating without a backup is a decision.
    printf '\033[33m!\033[0m %s\n' "scripts/backup.sh not present — migrating without a fresh backup"
fi

# ─── migrate with the app stopped ──────────────────────────────────────────
# Stopping the app first means no request can hit a half-migrated schema.
say "Stopping the application for migration"
$COMPOSE stop app 2>/dev/null || true

say "Running migrations"
docker run --rm \
    --network "$($COMPOSE ps --format json db | head -1 | grep -o '"Networks":"[^"]*"' | cut -d'"' -f4)" \
    --env-file .env \
    -e DATABASE_URL="$(grep -E '^MIGRATION_DATABASE_URL=' .env | cut -d= -f2- || grep -E '^DATABASE_URL=' .env | cut -d= -f2-)" \
    "$LIFEOS_IMAGE" node scripts/migrate.mjs \
    || die "migration failed; the application was not started on this image"
ok "migrations applied"

# ─── roll out ──────────────────────────────────────────────────────────────
say "Starting the application"
sed -i "s|^LIFEOS_IMAGE=.*|LIFEOS_IMAGE=$LIFEOS_IMAGE|" .env
grep -qE '^LIFEOS_IMAGE=' .env || echo "LIFEOS_IMAGE=$LIFEOS_IMAGE" >> .env
$COMPOSE up -d app nginx

# ─── hard health gate ──────────────────────────────────────────────────────
say "Waiting for health"
healthy=false
for _ in $(seq 1 45); do
    if curl -fsS --max-time 3 http://127.0.0.1:8080/api/health/live >/dev/null 2>&1; then
        healthy=true
        break
    fi
    sleep 2
done

if [[ "$healthy" != true ]]; then
    printf '\033[31m✘\033[0m %s\n' "new image failed its health check"
    if [[ -n "$PREVIOUS" ]]; then
        say "Rolling back to $PREVIOUS"
        sed -i "s|^LIFEOS_IMAGE=.*|LIFEOS_IMAGE=$PREVIOUS|" .env
        $COMPOSE up -d app nginx
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
say "Pruning old images"
docker image prune -f >/dev/null
keep=3
mapfile -t old < <(docker images --filter=reference='ghcr.io/*/lifeos' --format '{{.ID}} {{.CreatedAt}}' \
    | sort -k2 -r | tail -n +$((keep + 1)) | cut -d' ' -f1)
for id in "${old[@]:-}"; do [[ -n "$id" ]] && docker rmi "$id" >/dev/null 2>&1 || true; done
ok "kept the $keep most recent images"

mkdir -p "$RELEASES"
date -u +"%Y-%m-%dT%H:%M:%SZ $LIFEOS_IMAGE" >> "$RELEASES/history"
ok "deployed $LIFEOS_IMAGE"
