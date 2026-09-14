# Yume — plain single-stage image. One container serves BOTH the API and the
# static web client on one port, so the whole app runs through Docker.
# Node 22 runs the TypeScript sources directly (--experimental-strip-types),
# so there is no build step. Build from the repo root (the context is the root,
# not this directory):
#   docker build -f infrastructure/docker/Dockerfile -t yume .
#   docker run --rm -p 4000:4000 -e DATABASE_URL=… -e JWT_SECRET=… yume
FROM node:22-alpine

WORKDIR /app

# Manifests first, so a source-only change does not reinstall the world.
#
# The install runs at the monorepo root because this is an npm workspace: the
# single lockfile lives here, dependencies hoist into /app/node_modules, and
# @yume/database is resolved through a symlink npm writes into it. Installing
# inside apps/api instead would resolve neither.
#
# Every workspace's package.json has to be present for `npm ci` to accept the
# lockfile, even the ones with no dependencies of their own.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
COPY packages/design-tokens/package.json packages/design-tokens/
RUN npm ci --omit=dev

# Application code, shared packages, SQL migrations and the static web client.
#
# The image mirrors the repository layout — /app/apps/api, /app/apps/web,
# /app/packages, /app/database — and that is load-bearing, not tidiness. Two
# paths are resolved relative to the source file at runtime:
#
#   src/infrastructure/migrations/migrate.ts  ../../../../../database/migrations
#   src/app.ts                                ../../web   (the WEB_ROOT default)
#
# and the workspace symlink /app/node_modules/@yume/database points at
# ../../packages/database. All three are correct in a checkout and in the image
# only because the two layouts are the same shape. Flatten one here and the
# container starts, then fails to find its migrations.
COPY apps/api/ apps/api/
COPY apps/web/ apps/web/
COPY packages/ packages/
COPY database/ database/

# The code audit, which the admin panel's Audit status page reads at runtime
# and is that page's only data source. One file, not the directory: docs/ is
# 15 MB of prose the image has no use for, so .dockerignore excludes it and
# re-includes this one path. Override the location with AUDIT_REPORT_PATH.
COPY docs/audit-2026-09.json docs/

WORKDIR /app/apps/api
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    WEB_ROOT=/app/apps/web

# Which commit this image was built from, for the Audit status page's "the code
# has changed since the audit ran" warning. Nothing sets it by default — .git
# is not in the build context — and the page says it cannot tell rather than
# implying the audit is current. Stamp it to get the warning:
#   docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) …
ARG GIT_COMMIT=""
ENV SOURCE_COMMIT=$GIT_COMMIT

EXPOSE 4000

# Run as the built-in unprivileged user.
USER node

# Apply pending migrations, then start the API.
#
# The publish step is idempotent and deliberately non-fatal: it skips quietly
# when no administrator account exists yet (a fresh install, before anyone has
# registered), and one bad package must not keep the whole app from booting.
CMD ["sh", "-c", "node --experimental-strip-types src/infrastructure/migrations/migrate.ts && node --experimental-strip-types src/index.ts"]
