#!/usr/bin/env bash
# Runs the real deploy against a throwaway local stack (OPS-011 rehearsal).
#
#   ./scripts/rehearse-deploy.sh
#
# Why this exists: deploy.sh only ever ran on the Raspberry Pi, one step per
# attempt, over a link that drops. Five bugs were found that way — one per
# failed deploy — and two of them (a single-probe readiness check, an unquoted
# value that broke sourcing .env) had nothing to do with the network and would
# have shown up here in one run.
#
# It exercises `scripts/deploy.sh` UNMODIFIED, including the parts that only
# matter on a bad day: the pre-deploy backup, the migrations, the health gate,
# and the rollback. Nothing here touches the development stack, the production
# host, or any real registry — a local registry is started, used and removed.
#
# It is not a substitute for deploying. It is how you find out that the script
# is broken without needing a server to tell you.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROJECT="lifeosrehearsal"
REGISTRY_NAME="lifeos-rehearsal-registry"
REGISTRY_PORT="${LIFEOS_REHEARSAL_PORT:-5555}"
REGISTRY="127.0.0.1:${REGISTRY_PORT}"
STATE="$(mktemp -d "${TMPDIR:-/tmp}/lifeos-rehearsal-XXXXXX")"

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

# Always tear down, including on failure: a rehearsal that leaves containers
# and a registry behind is one nobody runs twice.
cleanup() {
    docker compose -f compose.prod.yml -f "$STATE/compose.override.yml" \
        --env-file "$STATE/.env" -p "$PROJECT" down -v >/dev/null 2>&1 || true
    docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
    for tag in good broken; do
        docker rmi -f "$REGISTRY/lifeos:$tag" >/dev/null 2>&1 || true
    done
    rm -f .env
    [[ -f .env.rehearsal-backup ]] && mv .env.rehearsal-backup .env
    # PostgreSQL writes its data directory as root, so this user cannot delete
    # it. Remove it the same way it was created — from a container — rather
    # than leaving 60 MB behind or asking for sudo.
    if [[ -d "$STATE/pgdata" ]]; then
        docker run --rm -v "$STATE:/state" alpine rm -rf /state/pgdata >/dev/null 2>&1 || true
    fi
    rm -rf "$STATE"
}
trap cleanup EXIT

mkdir -p "$STATE/backups" "$STATE/releases" "$STATE/pgdata"

# compose.prod.yml bind-mounts the database at /srv/lifeos/data/postgres — a
# real host path, which `down -v` cannot remove and which a rehearsal has no
# business creating on a developer's machine. It also makes the rehearsal
# non-repeatable: PostgreSQL only reads POSTGRES_PASSWORD when it initialises,
# so a surviving directory means the second run fails to authenticate against
# the first run's database.
#
# An override redirects it into the throwaway state directory. Compose merges
# `volumes` by target path, so this replaces the mount rather than adding a
# second one at the same place.
cat > "$STATE/compose.override.yml" <<YAML
services:
  db:
    volumes:
      - $STATE/pgdata:/var/lib/postgresql/data
YAML

cat > "$STATE/.env" <<EOF
NODE_ENV=production
ORIGIN=http://127.0.0.1:8080
POSTGRES_DB=lifeos
POSTGRES_USER=lifeos_app
POSTGRES_PASSWORD=rehearsal-only-not-a-secret
DATABASE_URL=postgresql://lifeos_app:rehearsal-only-not-a-secret@db:5432/lifeos
MIGRATION_DATABASE_URL=postgresql://lifeos_app:rehearsal-only-not-a-secret@db:5432/lifeos
LIFEOS_UPLOAD_DIR=/data/uploads
LIFEOS_IMPORT_DIR=/data/imports
LIFEOS_BACKUP_DIR=/data/backups
LIFEOS_TIMEZONE=America/Toronto
LIFEOS_CURRENCY=CAD
LIFEOS_WEATHER_LABEL="Local forecast"
LIFEOS_IMAGE=$REGISTRY/lifeos:good
EOF

# deploy.sh reads .env from the checkout, resolving the symlink — exactly how
# setup-server.sh arranges it on the real host.
[[ -e .env && ! -L .env ]] && mv .env .env.rehearsal-backup
ln -sfn "$STATE/.env" .env

say "Starting a throwaway registry on $REGISTRY"
docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
docker run -d --name "$REGISTRY_NAME" -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null
for _ in $(seq 1 30); do
    curl -fsS "http://$REGISTRY/v2/" >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS "http://$REGISTRY/v2/" >/dev/null 2>&1 || fail "the local registry did not come up"

say "Building the image under test"
docker build -q -t "$REGISTRY/lifeos:good" . >/dev/null
docker push -q "$REGISTRY/lifeos:good" >/dev/null

# An image that starts and never serves. The health gate has to notice.
say "Building an image that starts but never serves"
printf 'FROM %s/lifeos:good\nCMD ["sleep", "infinity"]\n' "$REGISTRY" > "$STATE/broken.Dockerfile"
docker build -q -t "$REGISTRY/lifeos:broken" -f "$STATE/broken.Dockerfile" . >/dev/null
docker push -q "$REGISTRY/lifeos:broken" >/dev/null

# ─── the happy path ────────────────────────────────────────────────────────
say "Deploying the good image"
LIFEOS_STATE_DIR="$STATE" LIFEOS_IMAGE="$REGISTRY/lifeos:good" \
    COMPOSE_PROJECT_NAME="$PROJECT" LIFEOS_COMPOSE_OVERRIDE="$STATE/compose.override.yml" \
    ./scripts/deploy.sh \
    || fail "the deploy failed on the happy path"

curl -fsS --max-time 5 http://127.0.0.1:8080/api/health/live >/dev/null \
    || fail "the application is not answering after a successful deploy"
grep -q "lifeos:good" "$STATE/.env" || fail ".env does not record the deployed image"
[[ -s "$STATE/releases/history" ]] || fail "no release was recorded"
compgen -G "$STATE/backups/lifeos-pre_deploy-*.dump" >/dev/null \
    || fail "no pre-deploy backup was taken"
ok "deployed, healthy, backed up and recorded"

# ─── the path that matters on a bad day ────────────────────────────────────
say "Deploying the broken image; the gate must catch it"
if LIFEOS_STATE_DIR="$STATE" LIFEOS_IMAGE="$REGISTRY/lifeos:broken" \
    COMPOSE_PROJECT_NAME="$PROJECT" LIFEOS_COMPOSE_OVERRIDE="$STATE/compose.override.yml" \
    ./scripts/deploy.sh; then
    fail "the broken image was accepted — the health gate did not hold"
fi

# The rollback has to leave a SERVING application, not merely a changed file.
#
# Waited for rather than checked instantly: deploy.sh starts the previous image
# and exits without gating on it — correctly, since it is already reporting a
# failure — so the container is still coming up when this line runs. Asserting
# immediately failed the rehearsal on a rollback that had actually worked.
say "Waiting for the rolled-back application"
rolled_back_live=false
for _ in $(seq 1 45); do
    if curl -fsS --max-time 3 http://127.0.0.1:8080/api/health/live >/dev/null 2>&1; then
        rolled_back_live=true
        break
    fi
    sleep 2
done
[[ "$rolled_back_live" == true ]] || fail "nothing is serving after the rollback"
grep -q "lifeos:good" "$STATE/.env" \
    || fail ".env was not rolled back to the previous image"
running=$(docker inspect --format '{{.Config.Image}}' "${PROJECT}-app-1" 2>/dev/null || true)
[[ "$running" == "$REGISTRY/lifeos:good" ]] \
    || fail "the running container is $running, not the rolled-back image"
ok "rejected the bad image and rolled back to a serving one"

printf '\033[32m▸ deploy rehearsal passed\033[0m\n'
