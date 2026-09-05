# Deployment

Same shape on a Raspberry Pi and on a Linode: a 64-bit host running Docker,
reached only over Tailscale, serving a loopback Nginx through Tailscale Serve.
The application is never built on the server — CI publishes a multi-arch image
(`linux/amd64` + `linux/arm64`) and the server pulls it.

## One-time server setup

Create the `actions` deploy account and its SSH key with the canonical setup
scripts first. The generator downloads `setup-prod-server.sh` automatically
when that account is missing:

```sh
curl -fL https://raw.githubusercontent.com/nuniesmith/scripts/main/scripts/setup/generate-secrets.sh \
  -o /tmp/generate-secrets.sh
sudo bash /tmp/generate-secrets.sh --no-confirm --env prod
```

Copy the generated `PROD_SSH_*` and `PROD_TAILSCALE_IP` values into the LifeOS
repository's Actions secrets. Then prepare the application directory:

```sh
git clone https://github.com/nuniesmith/lifeos.git ~/lifeos
cd ~/lifeos && sudo ./scripts/setup-server.sh
```

If Tailscale is not connected yet, run `sudo tailscale up` before recording the
server address below. `setup-server.sh` expects the `actions` account created by
the canonical generator and repairs its state-directory permissions safely on
re-runs.

`setup-server.sh` installs Docker, creates `/srv/lifeos`, and generates
`/srv/lifeos/.env` with a random `POSTGRES_PASSWORD`. The file is owned by the
`actions` deploy account and remains on the server; the password never travels
through a CI runner.

Then expose it and record the address:

```sh
sudo tailscale serve --bg --https=443 8080
tailscale status                      # note the 100.x address
```

Put that 100.x address in the `PROD_TAILSCALE_IP` repository secret, and set
`ORIGIN` in `/srv/lifeos/.env` to the `https://…ts.net` name Serve printed.
`ORIGIN` must match exactly or every form post is rejected as cross-site.

Funnel stays off. This host is reachable from the tailnet only.

## Deploying

Push to `main`. CI runs, publishes the image, and the Deploy workflow follows
it. `workflow_dispatch` also accepts an explicit image reference for rollback.

`scripts/deploy.sh` runs on the server and is the whole sequence:

1. preflight — refuse below 2 GB free, take a `flock` so two deploys cannot
   interleave;
2. pull the image first, so a bad reference fails before anything stops;
3. bring PostgreSQL up and wait for it;
4. back up before migrating;
5. stop the app, migrate as a one-shot, so no request meets a half-migrated
   schema;
6. start the app and Nginx, with PostgreSQL up throughout;
7. gate on `/api/health/live`, rolling the **application** back on failure —
   never the database, because a migration may already have committed;
8. prune images, keeping the last three so a rollback target survives.

## Rollback

```sh
gh workflow run deploy.yml -f image=ghcr.io/nuniesmith/lifeos:<sha>
```

The previous digest is in `/srv/lifeos/releases/history`. Rolling back the
image does not roll back the database; if a migration must be reversed, that
is a restore, not a deploy.

## Required secrets

| Secret                                                 | Purpose                                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `PROD_TAILSCALE_IP`                                    | The server's 100.x address. The legacy `LIFEOS_TAILSCALE_IP` name is accepted as a fallback.             |
| `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_SECRET` | Joins the runner to the tailnet as `tag:ci`.                                                             |
| `PROD_SSH_USER` / `PROD_SSH_KEY` / `PROD_SSH_PORT`     | Deploy account. The private key is generated off-server; old unprefixed names are accepted as fallbacks. |
| `GHCR_USERNAME` / `GHCR_READ_TOKEN`                    | Pull credential for the private image. `read:packages` only.                                             |
| `DISCORD_WEBHOOK_ACTIONS`                              | Deploy notifications.                                                                                    |

`POSTGRES_PASSWORD` is deliberately **not** a repository secret. It is
generated on the server into `/srv/lifeos/.env`, so a runner compromise does
not expose the database.

## Architecture

The published image covers `linux/amd64` and `linux/arm64`. A 32-bit
Raspberry Pi OS will pull an image it cannot run, and the failure looks like a
corrupt container rather than a mismatch — `setup-server.sh` checks `uname -m`
and refuses early.
