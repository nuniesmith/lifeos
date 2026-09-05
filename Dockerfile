# syntax=docker/dockerfile:1.7

# ─── deps: production node_modules only ────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev is safe here only because this project has no `prepare` script.
# A prepare script would run on install and reach for devDependencies that
# are not present, failing the image build while CI (which installs devDeps)
# stays green.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts \
 && npm rebuild sharp

# ─── build: needs devDependencies ──────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
# No secrets are passed here. Server modules guard their environment
# validation with `building` precisely so the image can be built without
# production configuration. See src/lib/server/env.ts.
RUN npm run build

# ─── runtime ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--max-old-space-size=384

# dumb-init reaps zombies and forwards signals, so container stop is a clean
# SIGTERM to node rather than a 10s timeout kill.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init curl \
 && rm -rf /var/lib/apt/lists/* \
 # The runtime runs `node build/index.js` and never installs anything, but
 # the base image ships npm, whose bundled dependencies (tar, pacote,
 # sigstore, ip-address, brace-expansion, picomatch) carry CVEs that no
 # change to this project's dependencies can fix. Removing npm drops that
 # entire class from the image and takes away the ability to fetch code
 # into a running production container.
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

WORKDIR /app
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json

# The deploy runs migrations inside this image, before starting the app, so
# the runner and the SQL have to be here. Leaving them out was invisible
# locally, where migrate.mjs runs from a checkout — it only failed on the
# server, at the one step that must not fail half-way.
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/scripts/migrate.mjs ./scripts/migrate.mjs

USER node
EXPOSE 3000

# Liveness only — deliberately not readiness. Docker restarts an unhealthy
# container, and restarting the app cannot fix an unreachable database.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health/live || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "build/index.js"]
