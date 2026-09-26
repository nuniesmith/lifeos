# LifeOS

A self-hosted replacement for a Notion "Life OS" workspace: SvelteKit and
PostgreSQL behind Nginx on a single host, reachable only over Tailscale.
Two users, private by default, no public ingress.

**[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) is the spec.** Its §13
breaks the work into phased tasks with per-phase gates, and the checkboxes
there record what is done, what is partly done (`[~]`), and what has not
started. Start there.

## Status

The application covers the workspace's day-to-day sections and most of its
feature packs, and the importer has been run against the household's real
Notion exports. What exists:

- **Accounts and privacy.** First-run bootstrap, sign-in with lockout,
  sessions, forced credential rotation, member administration and an audit
  view, household and per-record privacy enforced in the SQL of every
  repository, and a recovery CLI (`scripts/recover-admin.mjs`).
- **Daily use.** Today (agenda, habits, upcoming dates, and a weather card
  when coordinates are configured), quick capture from every page, inbox
  triage and brain dump, tasks with subtasks and dependencies, projects,
  goals, areas, topics, a calendar, habits with check-ins and targets, the
  journal, a review queue, full-text search, and one Archive page that lists
  and restores anything archived anywhere.
- **Feature packs.** Food (the week's meal plan, the shopping list, recipes,
  prep), the library with its reading list and knowledge hub, people and the
  wishlist, entertainment, bills and subscriptions, the yearly review and the
  wheel of life, and health: a symptom, mood, energy and activity vocabulary
  with how often each came up, and — linked from `/health` with a line of
  status each — medications with dose logging, measurements with charts, lab
  results against their reference ranges, and medical visits.
- **Import.** `./run.sh import` reads a Notion Markdown & CSV export, reports
  against the acceptance baseline below, compares its formula replacements
  with the values Notion rendered, and names every database it did not import
  and why. `scripts/import-covers.mjs` adds page covers from the HTML export,
  and `scripts/verify-import.mjs` checks imported values against the export.
- **Data mobility and backups.** A portable export and restore, and a verified
  database backup before every deploy and once a day. See below.
- **Delivery.** CI, a deploy workflow, and a local rehearsal of the deploy and
  its rollback. See [Deployment](#deployment).

The schema is the ordered SQL in `migrations/`; `./run.sh migrate --status`
lists what is applied.

Not done yet (§13 has the detail): copying backups off the host and a scripted
restore of them; the Notion formula definitions that still have to be captured
from the live workspace; finance beyond bills; adding library entries, recipes
and meals from the app, and logging symptoms against a day there; and the
final cutover from Notion.

## Getting started

Needs Node 22 and Docker with the Compose plugin. PostgreSQL runs in Docker;
the app runs on the host.

```sh
./run.sh init       # var/ dirs, .env from .env.example, npm ci, PostgreSQL on 127.0.0.1:5433
export DATABASE_URL=postgresql://lifeos_app:devpassword@localhost:5433/lifeos   # as in .env
./run.sh migrate    # apply migrations/
./run.sh dev        # http://localhost:5173
./run.sh doctor     # if something above failed: toolchain, .env, database, credentials
```

The `export` line is needed. Neither the dev server nor the scripts read
`.env`; they read the environment, and without `DATABASE_URL` the first page
fails with "DATABASE_URL is required". Everything else has a development
default. Exporting all of `.env` works too, but only after its empty
`LIFEOS_BOOTSTRAP_PASSWORD=` line is removed or given at least 12 characters —
an empty value is rejected.

On an empty database the server creates the household and an `admin` account
as it starts (the dev server loads its hooks on the first request, so there it
happens then). The password is printed once to the server's terminal, unless
`LIFEOS_BOOTSTRAP_PASSWORD` is set. Signing in forces a new username and
password.

To load a Notion export, start the app once so the household exists, then run
`./run.sh import --root <export dir>`. That is a dry run that prints the
report; add `--commit` to keep the result. Keep exports in `data/`, which is
gitignored.

### Tests

```sh
./run.sh test unit   # no database needed
./run.sh test        # svelte-check, then the unit tests
```

The integration tests delete everything in their database, and the
end-to-end suite drops and recreates its own. Never point either at the
database in `.env`; give each its own:

```sh
docker compose exec db createdb -U lifeos_app lifeos_test
DATABASE_URL=postgresql://lifeos_app:devpassword@localhost:5433/lifeos_test ./run.sh migrate
DATABASE_URL=postgresql://lifeos_app:devpassword@localhost:5433/lifeos_test ./run.sh test integration
E2E_DATABASE_URL=postgresql://lifeos_app:devpassword@localhost:5433/lifeos_e2e ./run.sh test e2e
```

The end-to-end suite falls back to `DATABASE_URL` when `E2E_DATABASE_URL` is
unset, so with the development URL exported it would drop that database. It
builds the app first and needs a Playwright browser
(`npx playwright install chromium`).

## Source data

The exports live in `data/` and are **deliberately untracked** — 416 MB across
1,829 files, containing medical, income, and spending records. The repo is
private, but the reason to keep them out is that Git history is permanent.

`docs/source-catalog.md` is the tracked record of their shape:

|                                 |           |
| ------------------------------- | --------: |
| Databases (`_all.csv`)          |        36 |
| Canonical rows                  |       436 |
| Markdown pages                  |       504 |
| Image files / unique by SHA-256 | 525 / 298 |

Those four figures are the import acceptance baseline. They are verified to
match the plan's gate exactly.

They describe the export the plan was written against. The workspace has kept
changing since: later exports add databases (health measurements, lab results,
bills) and rename others. The importer therefore recognises a database by its
Notion ID rather than its name, and its report lists renames, columns that
have left the export, and any database it has no mapper for, instead of
dropping them quietly.

Both export formats are kept because they carry different things: CSV has
canonical rows and rendered values, HTML has stable page IDs and typed
properties, Markdown has readable body content. See §7 _Source precedence_.

Before changing the importer, read §7 _Verified source-format hazards_ — the
traps confirmed in this specific export, including BOM headers, newlines
inside cells, commas inside titles, and ten duplicate-title groups that make
titles unusable as keys.

## Layout

```
migrations/            ordered SQL, applied by scripts/migrate.mjs
src/routes/            (app) pages, (auth) sign-in, api/ health, media, quick-add
src/lib/server/        auth db health import repositories, env logger storage
src/lib/components/    shared UI components
scripts/               migrate, import, export/restore, backup, deploy, server setup, recovery
tests/                 unit integration e2e fixtures
deploy/systemd/        the daily backup timer
infrastructure/nginx/  the one Nginx site
docs/                  deployment, data mobility, source catalog
var/                   gitignored runtime data
```

## Deployment

Production is one 64-bit Docker host on the household's tailnet, running the
three containers in `compose.prod.yml`: PostgreSQL, the app, and Nginx. The
app is never built on the server.

- **CI** (`.github/workflows/ci.yml`) runs svelte-check, lint, the unit,
  integration and end-to-end tests, a first-run check against the built
  server, and `npm audit`. On `main` it publishes a `linux/amd64` +
  `linux/arm64` image to GHCR tagged with the commit, and scans it. A push to
  `main` that changes the deploy or backup scripts, `compose.prod.yml`, the
  Dockerfile or the CI workflow also rehearses a deploy and a rollback against
  a throwaway stack (`scripts/rehearse-deploy.sh`).
- **Deploy** (`.github/workflows/deploy.yml`) follows a green `main` run, or
  takes an explicit image for a rollback. It joins the runner to the tailnet
  and runs `scripts/deploy.sh` on the host over SSH: pull, back up, migrate
  with the app stopped, start the app and Nginx, and roll the app — never the
  database — back if it fails its health check. The shared composites from
  [`nuniesmith/actions`](https://github.com/nuniesmith/actions) are pinned to
  one reviewed commit.

The plan was written for a Linode Nanode with Tailscale Serve in front of a
loopback Nginx. Production has since moved to a home server shared with other
services, reached through a reverse proxy on another tailnet machine. What
differs between hosts is configuration, not code. The host's
`/srv/lifeos/.env`, written once by `scripts/setup-server.sh`, decides:

- `LIFEOS_BIND_ADDR` and `LIFEOS_BIND_PORT` — where Nginx is published. The
  default, `127.0.0.1:8080`, suits Tailscale Serve on the same host; a host
  whose proxy is elsewhere sets its own Tailscale address. Never `0.0.0.0` or
  a routable address. The deploy's health gate polls the same address.
- `ORIGIN` — the exact HTTPS origin people use. If it does not match, every
  form post is rejected as cross-site.

Deploys log in to GHCR under a Docker config of their own (`DOCKER_CONFIG` set
to `~/.docker-lifeos`), so a deploy account shared with other services keeps
its default Docker login untouched. Repository secrets use the unprefixed
names (`LIFEOS_TAILSCALE_IP`, `SSH_USER`, `SSH_KEY`, `SSH_PORT`); the
`PROD_`-prefixed names that `nuniesmith/scripts` generates are accepted as
fallbacks.

[`docs/deployment.md`](docs/deployment.md) has server setup, the full deploy
sequence, rollback, and the secrets table.

## Data mobility and backups

Two separate tools, kept apart on purpose:

- **Portable export and restore** — `npm run data:export` and
  `npm run data:restore` (`scripts/export-data.mjs`, `scripts/restore-data.mjs`).
  They move a household's records, relationships, import provenance and media
  between installations without credentials or sessions. A restore only
  validates unless given `--apply`. See
  [`docs/data-mobility.md`](docs/data-mobility.md).
- **Operational backup** — `scripts/backup.sh` on the server: a custom-format
  `pg_dump`, read back with `pg_restore --list` and recorded with its checksum
  and row counts. `scripts/deploy.sh` runs it before every migration, and the
  systemd timer that `setup-server.sh` installs runs it daily. Dumps stay on
  the host for 14 days by default. Nothing copies them off the host yet, and
  there is no scripted restore; both are still open in §13 (BKP-001, BKP-003).
