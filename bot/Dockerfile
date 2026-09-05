# The Discord bot, as its own image.
#
# Not the root image: that one installs the API's dependencies and copies web/
# and db/, none of which the bot needs. This one has no runtime dependencies at
# all — Node 22 provides fetch, WebSocket and Ed25519 — so there is nothing to
# install and the image is the base plus a few files.
FROM node:22-alpine

WORKDIR /app/bot
COPY package.json ./
# No lockfile step: dependencies is empty, and `npm ci` would fail without one.
# If a dependency is ever added (the gateway phase wants discord.js), this
# becomes `COPY package*.json ./` + `RUN npm ci --omit=dev`.
COPY src/ ./src/

ENV NODE_ENV=production \
    BOT_PORT=4100
EXPOSE 4100

USER node

# Node 22 runs the TypeScript directly, the same as the API image.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
