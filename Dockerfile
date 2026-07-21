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

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    WEB_ROOT=/app/web
EXPOSE 4000

# Run as the built-in unprivileged user.
USER node

# Apply pending migrations, then start the API.
CMD ["sh", "-c", "node --experimental-strip-types src/lib/migrate.ts && node --experimental-strip-types src/index.ts"]
