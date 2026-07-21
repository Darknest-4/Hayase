# Yume API — plain single-stage image.
# Node 22 runs the TypeScript sources directly (--experimental-strip-types),
# so there is no build step. Build from the repo root:
#   docker build -t yume-api .
#   docker run --rm -p 4000:4000 -e DATABASE_URL=… -e JWT_SECRET=… yume-api
FROM node:22-alpine

WORKDIR /app/server

# Install production dependencies first (better layer caching).
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Application code + SQL migrations.
# migrate.ts resolves ../../../db/migrations, so keep the server/ + db/ layout.
COPY server/ ./
COPY db/ /app/db/

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0
EXPOSE 4000

# Run as the built-in unprivileged user.
USER node

# Apply pending migrations, then start the API.
CMD ["sh", "-c", "node --experimental-strip-types src/lib/migrate.ts && node --experimental-strip-types src/index.ts"]
