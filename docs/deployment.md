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
commit's own tag, so `:<sha>` stays a rollback target. Nothing here deploys:
freddy's next deploy pulls `:main` (or whatever `LIFEOS_IMAGE` names).

The image carries what a deploy runs inside it, and
`tests/unit/deployment.test.ts` fails if that stops being true:

- `scripts/migrate.mjs` and `migrations/` — freddy runs
  `docker compose run --rm lifeos-app node scripts/migrate.mjs` before the
  app restarts. The app never migrates itself.
- `scripts/export-data.mjs` and `scripts/restore-data.mjs` — see
  [`data-mobility.md`](data-mobility.md).

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
with `LIFEOS_STATE_DIR`), records it in `backup_runs`, and keeps 14 days.
`/api/health/ready` reports a backup older than 36 hours.

**Not wired up yet.** Since the move to freddy, nothing runs this: freddy's
own `scripts/backup.sh` covers Authentik and Nextcloud only, and its deploy
migrates without a backup first. Both belong in freddy — a daily timer, and a
`--pre-deploy` run before the migration step.

## Architecture

The published image covers `linux/amd64` and `linux/arm64`. A 32-bit
Raspberry Pi OS will pull an image it cannot run, and the failure looks like a
corrupt container rather than a mismatch.
