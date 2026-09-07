#!/usr/bin/env bash
# Verifies first-run bootstrap against the BUILT artifact, not the source
# modules.
#
# This exists because a real bootstrap failure once survived a full green
# integration suite: the tests import src/, while production runs the bundled
# output, and a driver helper behaved differently there. Anything that must
# work at startup gets checked here, against what actually ships.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

: "${DATABASE_URL:?DATABASE_URL must be set}"
PORT="${PORT:-4180}"
LOG=$(mktemp)
SRV=""

cleanup() {
    [[ -n "$SRV" ]] && kill "$SRV" 2>/dev/null || true
    rm -f "$LOG"
}
trap cleanup EXIT

fail() { printf '\033[31m✘\033[0m %s\n' "$*" >&2; echo "--- server log ---" >&2; cat "$LOG" >&2; exit 1; }
pass() { printf '\033[32m✔\033[0m %s\n' "$*"; }

echo "▸ Applying migrations"
node scripts/migrate.mjs >/dev/null

echo "▸ Building"
npm run build >/dev/null 2>&1

echo "▸ Starting the built server"
NODE_ENV=production ORIGIN="https://lifeos.test" PORT="$PORT" HOST=127.0.0.1 \
    node build/index.js >"$LOG" 2>&1 &
SRV=$!

for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:${PORT}/api/health/live" >/dev/null 2>&1 && break
    sleep 0.5
done
curl -fsS "http://127.0.0.1:${PORT}/api/health/live" >/dev/null || fail "server never became live"
pass "server is live"

# Readiness catches schema drift that liveness deliberately ignores. A fresh
# install has no backup yet, so it may be degraded, but it must not be a 503.
curl -fsS "http://127.0.0.1:${PORT}/api/health/ready" >/dev/null \
    || fail "server did not become ready after migrations"
pass "migrations are ready"

# Bootstrap runs at startup; touch the app once so the first request has
# certainly awaited it.
curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" || fail "home page did not respond"

grep -q 'first-run bootstrap did not complete' "$LOG" && fail "bootstrap reported failure"
grep -q '"level":50' "$LOG" && fail "server logged an error during first run"
pass "no errors during first run"

grep -q 'username: admin' "$LOG" || fail "bootstrap credential was not printed"
grep -qE 'password: [A-Za-z0-9]{20,}' "$LOG" || fail "no generated password in output"
pass "one-time credential printed"

# The credential must be printed once and only once.
[[ "$(grep -c 'username: admin' "$LOG")" -eq 1 ]] || fail "credential printed more than once"
pass "credential printed exactly once"

# Restarting must not create a second admin or reprint a credential.
kill "$SRV"; wait "$SRV" 2>/dev/null || true
: >"$LOG"
NODE_ENV=production ORIGIN="https://lifeos.test" PORT="$PORT" HOST=127.0.0.1 \
    node build/index.js >"$LOG" 2>&1 &
SRV=$!
for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:${PORT}/api/health/live" >/dev/null 2>&1 && break
    sleep 0.5
done
curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" || fail "restart did not respond"
grep -q 'username: admin' "$LOG" && fail "credential reprinted on restart"
pass "restart is idempotent and silent"

printf '\033[32m▸ first-run verification passed\033[0m\n'
