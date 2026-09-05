# LifeOS

A self-hosted replacement for a Notion "Life OS" workspace: SvelteKit + PostgreSQL
behind loopback Nginx, served over Tailscale on a single $5 Linode Nanode.
Two users, private by default, no public ingress.

**[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) is the spec** — 83 tasks
across 8 phases, with per-phase gates. Start there.

## Status

Phases 1 and 2 complete. The application skeleton, container, CI, database
schema, and the whole authentication and account layer are in place and
verified end to end: first-run bootstrap, sign-in with lockout, sessions,
forced credential rotation, account administration, household and privacy
authorization, and a recovery CLI.

CI is green across static checks, 55 unit tests, 23 integration tests, 10
end-to-end tests, a first-run check against the built artifact, a dependency
audit, and a scanned image published to GHCR.

Phase 3 (core domain model) is next. No product features exist yet.

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

Both export formats are kept because they carry different things: CSV has
canonical rows and rendered values, HTML has stable page IDs and typed
properties, Markdown has readable body content. See §7 _Source precedence_.

Before writing any importer, read §7 _Verified source-format hazards_ — nine
confirmed traps in this specific export, including BOM headers, newlines inside
cells, commas inside titles, and ten duplicate-title groups that make titles
unusable as keys.

## Layout

```
migrations/   ordered SQL              scripts/    backup, restore, deploy, doctor
src/lib/server/  auth db import repositories services storage
tests/        fixtures integration e2e  provision/  cloud-init
infrastructure/nginx/                   var/        gitignored runtime data
```

## Deployment

CI/CD reuses the shared composites in [`nuniesmith/actions`](https://github.com/nuniesmith/actions),
pinned to reviewed SHAs, adapted from the Princess pipeline. The one inherited
quirk — `tailscale-connect` logging out inside the composite, which makes the
`LIFEOS_TAILSCALE_IP` override load-bearing rather than optional — is documented
in §4 and must not be "fixed" in the shared action without re-testing Princess.

## Getting started

```sh
cp .env.example .env    # fill in POSTGRES_PASSWORD and DATABASE_URL
```

Nothing runs yet. Phase 1 sets up the SvelteKit skeleton, Docker, and CI.
