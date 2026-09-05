#!/usr/bin/env bash
# LifeOS task dispatcher. Thin on purpose: real logic belongs in scripts/.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

compose() {
    if docker compose version >/dev/null 2>&1; then docker compose "$@"
    else die "docker compose is required"; fi
}

cmd_init() {
    say "Creating runtime directories"
    mkdir -p var/imports var/uploads var/backups
    [[ -f .env ]] || { cp .env.example .env; say "Wrote .env from .env.example (development defaults)"; }
    say "Installing dependencies"
    npm ci
    say "Starting database"
    compose up -d db
    say "Done. Next: ./run.sh dev"
}

cmd_dev()   { compose up -d db && npm run dev; }
cmd_up()    { compose up -d; }
cmd_down()  { compose down; }
cmd_logs()  { compose logs -f --tail=100 "${1:-}"; }
cmd_build() { npm run build; }
cmd_migrate() { compose up -d db >/dev/null && node scripts/migrate.mjs "$@"; }
cmd_recover() { node scripts/recover-admin.mjs "$@"; }
cmd_import() { compose up -d db >/dev/null && node scripts/import.mjs "$@"; }

cmd_test() {
    case "${1:-all}" in
        unit)        npm run test:unit ;;
        integration) compose up -d db && npm run test:integration ;;
        e2e)         npm run test:e2e ;;
        first-run)   compose up -d db >/dev/null && ./scripts/verify-first-run.sh ;;
        all)         npm run check && npm run test:unit ;;
        *)           die "unknown test target: $1" ;;
    esac
}

# Reports what is wrong rather than fixing it, so it is safe to run anywhere.
cmd_doctor() {
    local fail=0
    check() { if eval "$2" >/dev/null 2>&1; then printf '  \033[32m✔\033[0m %s\n' "$1"; else printf '  \033[31m✘\033[0m %s\n' "$1"; fail=1; fi; }

    say "Toolchain"
    check "node >= 22"            '[[ $(node -p "process.versions.node.split(\".\")[0]") -ge 22 ]]'
    check "docker present"        'docker --version'
    check "docker compose present" 'docker compose version'

    say "Repository"
    check "node_modules installed" '[[ -d node_modules ]]'
    check ".env present"           '[[ -f .env ]]'
    check "runtime dirs exist"     '[[ -d var/uploads && -d var/imports && -d var/backups ]]'
    check "private data untracked" '! git ls-files --error-unmatch data >/dev/null 2>&1'

    say "Services"
    check "database reachable"    'compose exec -T db pg_isready'
    # A .env that parses but cannot authenticate is the failure this catches:
    # `run.sh init` succeeds, then `run.sh dev` dies on connect. Connects from
    # the host with the app's own driver, because DATABASE_URL is written from
    # the host's point of view and would resolve differently inside a container.
    check "DATABASE_URL authenticates" 'node scripts/check-db.mjs'

    [[ $fail -eq 0 ]] && say "All checks passed" || die "Some checks failed"
}

usage() {
    cat <<'USAGE'
Usage: ./run.sh <command>

  init                 install deps, create .env and runtime dirs, start db
  dev                  start db and run the dev server
  build                production build
  migrate [--status|--verify]   apply database migrations
  recover [--list|--reset <user>|--invalidate-sessions]   account recovery
  import [--root <dir>] [--commit]   dry-run (default) or commit the Notion import
  test [unit|integration|e2e|first-run|all]
  up | down | logs [service]
  doctor               diagnose the local setup
USAGE
}

case "${1:-}" in
    init) shift; cmd_init "$@" ;;
    dev)  shift; cmd_dev "$@" ;;
    build) shift; cmd_build "$@" ;;
    migrate) shift; cmd_migrate "$@" ;;
    recover) shift; cmd_recover "$@" ;;
    import) shift; cmd_import "$@" ;;
    test) shift; cmd_test "$@" ;;
    up)   shift; cmd_up "$@" ;;
    down) shift; cmd_down "$@" ;;
    logs) shift; cmd_logs "$@" ;;
    doctor) shift; cmd_doctor "$@" ;;
    ''|-h|--help|help) usage ;;
    *) usage; die "unknown command: $1" ;;
esac
