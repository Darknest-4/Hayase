# Yume — plain single-stage image. One container serves BOTH the API and the
# static web client on one port, so the whole app runs through Docker.
# Node 22 runs the TypeScript sources directly (--experimental-strip-types),
# so there is no build step. Build from the repo root:
#   docker build -t yume .
#   docker run --rm -p 4000:4000 -e DATABASE_URL=… -e JWT_SECRET=… yume
FROM node:22-alpine

WORKDIR /app/server

# Install production dependencies first (better layer caching).
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Application code, SQL migrations and the static web client.
# migrate.ts resolves ../../../db/migrations, so keep the server/ + db/ layout;
# the API serves WEB_ROOT (the web/ client) from the same origin.
COPY server/ ./
COPY db/ /app/db/
COPY web/ /app/web/
# The extensions that ship with the project. They are source folders, not store
# rows, so scripts/publish-extensions.ts registers them on boot — without this
# copy the store is empty on every deployment.
COPY extensions/ /app/extensions/

# Extension packages are stored on disk, outside the database. Creating the
# directory here (owned by the runtime user) means a fresh named volume mounted
# over it inherits that ownership instead of coming up root-owned and unwritable.
RUN mkdir -p /app/packages && chown node:node /app/packages

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    WEB_ROOT=/app/web \
    PACKAGE_DIR=/app/packages
EXPOSE 4000

# Run as the built-in unprivileged user.
USER node

# Apply pending migrations, publish the bundled extensions, then start the API.
#
# The publish step is idempotent and deliberately non-fatal: it skips quietly
# when no administrator account exists yet (a fresh install, before anyone has
# registered), and one bad package must not keep the whole app from booting.
CMD ["sh", "-c", "node --experimental-strip-types src/lib/migrate.ts && { node --experimental-strip-types scripts/publish-extensions.ts || echo 'publish-extensions: skipped, see the log above'; } && node --experimental-strip-types src/index.ts"]
