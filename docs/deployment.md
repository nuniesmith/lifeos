# Deployment

Production runs on freddy, and the [`nuniesmith/freddy`](https://github.com/nuniesmith/freddy)
repo owns it: the `lifeos-db`, `lifeos-app` and `lifeos-nginx` services in
its `docker-compose.yml`, the Nginx site in `services/lifeos/nginx.conf`, the
secrets, and the CI/CD that deploys them. This repo builds the image.

## What this repo provides

CI (`.github/workflows/ci.yml`) publishes a `linux/amd64` + `linux/arm64`
image to GHCR from every push to `main`, tagged with the commit and with
`main`, and scans it. A weekly refresh rebuilds `main` on fresh base images
and publishes it as `refresh-<run id>` and `main`; it does not move the
commit's own tag, so `:<sha>` stays a rollback target. A push to `main` also
asks freddy to roll that commit out (freddy's `update-service.yml` migrates,
recreates `lifeos-app` and checks it runs that revision), and freddy's own
deploys pull `:main` (or whatever `LIFEOS_IMAGE` names).

The image carries what a deploy runs inside it, and
`tests/unit/deployment.test.ts` fails if that stops being true:

- `scripts/migrate.mjs` and `migrations/` — freddy runs
  `docker compose run --rm lifeos-app node scripts/migrate.mjs` before the
  app restarts. The app never migrates itself.
- `scripts/export-data.mjs` and `scripts/restore-data.mjs` — see
  [`data-mobility.md`](data-mobility.md).

## Settings

The app gets only the variables freddy's `docker-compose.yml` lists for
`lifeos-app`. Their values come from freddy's `.env`, which its deploy writes
from that repo's GitHub secrets
([its list](https://github.com/nuniesmith/freddy/blob/main/docs/GITHUB_SECRETS.md)),
keeping what is already there. A new setting needs a line in that compose
file; one set in any other file never reaches the app. `.env.example` is for
development.

## Rollback

Point `LIFEOS_IMAGE` in freddy's `.env` at `ghcr.io/nuniesmith/lifeos:<sha>`
and redeploy. Rolling back the image does not roll back the database; if a
migration must be reversed, that is a restore, not a deploy.

## Backups

`scripts/backup.sh` runs on the host against freddy's stack:

```sh
LIFEOS_COMPOSE_FILE=/home/actions/freddy/docker-compose.yml \
LIFEOS_ENV_FILE=/home/actions/freddy/.env \
LIFEOS_DB_SERVICE=lifeos-db \
  ./scripts/backup.sh --scheduled
```

It writes a verified custom-format dump to `/srv/lifeos/backups` (override
with `LIFEOS_STATE_DIR`) with two files beside it — `.sha256`, its checksum,
and `.counts`, the row count of every table — records it in `backup_runs`,
and keeps 14 days. `/api/health/ready` reports a backup older than 36 hours.
Until something runs it, freddy's compose file sets `LIFEOS_BACKUP_CHECK=off`
(a freddy secret of `on` turns the check back on): otherwise readiness stays
degraded forever, and an uptime monitor that is always down can't report a
real outage.
Copy all three files when moving a backup anywhere.

**Not wired up yet.** Since the move to freddy, nothing runs this: freddy's
own `scripts/backup.sh` covers Authentik and Nextcloud only, and its deploy
migrates without a backup first. Both belong in freddy — a daily timer, and a
`--pre-deploy` run before the migration step.

## Restoring a backup

`scripts/restore-backup.sh` takes the same three variables, plus
`LIFEOS_APP_SERVICE=lifeos-app`:

```sh
./scripts/restore-backup.sh /srv/lifeos/backups/lifeos-scheduled-….dump          # check only
./scripts/restore-backup.sh /srv/lifeos/backups/lifeos-scheduled-….dump --apply  # and switch
```

It never restores over the live database. The dump goes into a staging
database, which must match the checksum and every table's row count (a
difference in `sessions`, `auth_audit` or `backup_runs` only warns: those can
move in the seconds between the dump and the count). Without `--apply` it
stops there and drops the staging database.

With `--apply` it backs up the live database, stops the app, swaps the two
databases' names in one transaction, deletes every session so everyone signs
in again, and starts the app. If the app does not report its database and
migrations ready within a minute, the names swap back and the app starts on
the database it had. The replaced database is kept as
`<db>_pre_restore_<stamp>`; the script prints the `dropdb` for it.

A dump with no `.sha256` and `.counts` (one taken before they existed) needs
`--without-manifest` and is restored unchecked. Uploads are not in the dump,
so this restores the database only.

## Architecture

The published image covers `linux/amd64` and `linux/arm64`. A 32-bit
Raspberry Pi OS will pull an image it cannot run, and the failure looks like a
corrupt container rather than a mismatch.
