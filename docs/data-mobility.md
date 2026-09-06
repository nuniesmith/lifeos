# LifeOS data mobility

LifeOS has two different recovery tools. Keep them separate:

- `scripts/export-data.mjs` creates a portable household export. It contains
  application records, relationships, imported source provenance, and
  content-addressed media. It deliberately leaves out password hashes,
  sessions, invites, audit IPs, change history, settings, and server secrets.
- `scripts/backup.sh` creates the operational PostgreSQL custom archive used
  before deploys and by the server backup schedule. That is the tool for
  recovering the exact production database and account state.

## Portable export and restore

Run these commands from a checked-out LifeOS release with `DATABASE_URL` (or
`MIGRATION_DATABASE_URL`) set:

```sh
node scripts/export-data.mjs \
  --output var/exports/lifeos-$(date -u +%Y%m%dT%H%M%SZ)

# Validate without changing the target database.
node scripts/restore-data.mjs \
  --input var/exports/lifeos-YYYYMMDDTHHMMSSZ \
  --owner-user admin \
  --dry-run

# Apply after reviewing the validation output.
node scripts/restore-data.mjs \
  --input var/exports/lifeos-YYYYMMDDTHHMMSSZ \
  --owner-user admin \
  --apply
```

The target must already have migrations applied and a household/account from
the normal first-run bootstrap. `--owner-user` is required because portable
exports never carry credentials; it explicitly maps imported private records
to the chosen target account. Existing rows are merged by stable ID by
default. Use `--collision skip` to leave existing IDs untouched. Destructive
replacement is intentionally not available in this command.

An export with more than one household member is rejected by default because
portable restore does not recreate user accounts. If deliberately consolidating
all source members into the selected owner is acceptable, add
`--collapse-users` to both the dry run and apply commands. Use an operational
database restore instead when separate account identities must be preserved.

The export is a directory so it can be streamed or copied without loading a
large media archive into memory. Preserve the whole directory, including
`manifest.json`, `data/`, `csv/`, `content/`, and `media/`. The manifest stores
SHA-256 checksums for every payload file, and restore refuses a mismatch.

On the production host, run the commands inside the app container because the
server does not need a separate Node installation:

```sh
container=$(docker compose -f compose.prod.yml ps -q app)
docker compose -f compose.prod.yml exec -T app \
  node scripts/export-data.mjs --output /tmp/lifeos-export
docker cp "$container:/tmp/lifeos-export" ./lifeos-export

# Copy an export directory into the running app container before validating or
# applying it on a fresh installation.
docker cp ./lifeos-export "$container:/tmp/lifeos-export"
docker compose -f compose.prod.yml exec -T app \
  node scripts/restore-data.mjs --input /tmp/lifeos-export \
  --owner-user admin --dry-run
```

Add `--apply` only after the dry run is reviewed. Keep the copied export
outside the application repository and remove temporary container copies after
the transfer has been verified.

## Operational restore boundary

`backup.sh` remains the production backup path because a portable export does
not include auth/session state or server settings. A full PostgreSQL restore
must be performed as an operator CLI procedure on a stopped application, then
all restored sessions must be invalidated with:

```sh
node scripts/recover-admin.mjs --invalidate-sessions
```

Do not restore a custom-format archive directly over a live production volume
without preserving the current database and uploads first. The deploy backup
is a safety net, not proof that a fresh-host restore drill has passed.
