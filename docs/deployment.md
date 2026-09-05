# Deployment

Same shape on a Raspberry Pi and on a Linode: a 64-bit host running Docker,
reached only over Tailscale, serving a loopback Nginx through Tailscale Serve.
The application is never built on the server — CI publishes a multi-arch image
(`linux/amd64` + `linux/arm64`) and the server pulls it.

## One-time server setup

```sh
sudo tailscale up --ssh
git clone https://github.com/nuniesmith/lifeos.git ~/lifeos
cd ~/lifeos && sudo ./scripts/setup-server.sh
```

`setup-server.sh` installs Docker, creates `/srv/lifeos`, and generates a
root-owned `/srv/lifeos/.env` with a random `POSTGRES_PASSWORD`. The password
is generated on the server and never travels through a CI runner.

Then expose it and record the address:

```sh
sudo tailscale serve --bg --https=443 8080
tailscale status                      # note the 100.x address
```

Put that 100.x address in the `LIFEOS_TAILSCALE_IP` repository secret, and set
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

| Secret                                                 | Purpose                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `LIFEOS_TAILSCALE_IP`                                  | The server's 100.x address. **Load-bearing** — `tailscale-connect` logs out before name resolution would run. |
| `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_SECRET` | Joins the runner to the tailnet as `tag:ci`.                                                                  |
| `SSH_USER` / `SSH_KEY` / `SSH_PORT`                    | Deploy account. The private key is generated off-server.                                                      |
| `GHCR_USERNAME` / `GHCR_READ_TOKEN`                    | Pull credential for the private image. `read:packages` only.                                                  |
| `DISCORD_WEBHOOK_ACTIONS`                              | Deploy notifications.                                                                                         |

`POSTGRES_PASSWORD` is deliberately **not** a repository secret. It is
generated on the server into `/srv/lifeos/.env`, so a runner compromise does
not expose the database.

## Architecture

The published image covers `linux/amd64` and `linux/arm64`. A 32-bit
Raspberry Pi OS will pull an image it cannot run, and the failure looks like a
corrupt container rather than a mismatch — `setup-server.sh` checks `uname -m`
and refuses early.
