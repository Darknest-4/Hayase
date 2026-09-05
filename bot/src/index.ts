// The bot as a service.
//
// One HTTP server, two jobs:
//
//   POST /interactions   Discord's slash-command callbacks (signature-verified)
//   POST /notify         Yume's own events, on the compose network only
//   GET  /health         liveness, for compose
//
// `node:http` rather than Fastify: this listens on the internal network for
// two routes, and pulling the API's whole framework into a second image to
// serve them would be a cost with nothing on the other side.
//
// No published port. Discord reaches /interactions through the same reverse
// proxy that fronts the site (see docs/discord-telepites.md); /notify is
// reachable only as http://bot:4100 inside the compose network.

import { createServer } from 'node:http'

import { config, configured } from './config.ts'
import { Rest } from './discord/rest.ts'
import { handlers } from './handlers.ts'
import { InteractionType, ResponseType, verifySignature, type Interaction } from './interactions.ts'
import { sendWebhook } from './notify.ts'
import { syncMessage } from './messages.ts'
import { channelMap, startSyncLoop } from './sync.ts'
import { gatewayConfigured, startGateway } from './gateway.ts'
import { onMemberJoin } from './welcome.ts'
import { releaseEmbed } from './content.ts'

if (!configured()) {
  console.error('[yume-bot] DISCORD_BOT_TOKEN and DISCORD_APP_ID are required. See docs/discord-telepites.md.')
  process.exit(78)
}

const rest = new Rest({
  token: config.token,
  onRequest: (method, route, status) => {
    // Failures only: a line per successful REST call would bury the log during
    // provisioning, which makes ~100 of them.
    if (status >= 400) console.warn(`[yume-bot] ${method} ${route} → ${status}`)
  }
})

const readBody = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += (chunk as Buffer).length
    // An interaction is small; anything large is not one.
    if (size > 256 * 1024) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer((req, res) => {
  void (async () => {
    const json = (status: number, payload: unknown): void => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    }

    try {
      if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok', uptime: process.uptime() })

      // ---- Discord interactions ------------------------------------------
      if (req.method === 'POST' && req.url === '/interactions') {
        const signature = String(req.headers['x-signature-ed25519'] ?? '')
        const timestamp = String(req.headers['x-signature-timestamp'] ?? '')
        const body = await readBody(req)

        // Verified before parsing. An unverified endpoint would let anyone who
        // learns the URL post a fabricated moderation command.
        if (!verifySignature(config.publicKey, signature, timestamp, body)) {
          res.writeHead(401).end('invalid request signature')
          return
        }

        const interaction = JSON.parse(body) as Interaction
        if (interaction.type === InteractionType.Ping) return json(200, { type: ResponseType.Pong })

        const name = interaction.data?.name ?? ''
        const handler = handlers[name]
        if (!handler) return json(200, { type: ResponseType.ChannelMessage, data: { content: `Unknown command: ${name}`, flags: 1 << 6 } })

        try {
          return json(200, await handler(interaction, rest))
        } catch (err) {
          // The user gets a sentence; the operator gets the message. Discord
          // internals never reach the channel.
          console.error(`[yume-bot] /${name} failed:`, (err as Error).message)
          return json(200, { type: ResponseType.ChannelMessage, data: { content: 'That did not work. The error is in the bot log.', flags: 1 << 6 } })
        }
      }

      // ---- events from the Yume API ---------------------------------------
      if (req.method === 'POST' && req.url === '/notify') {
        // Shared secret, and only reachable on the compose network. Constant
        // time is not required for a value the attacker cannot probe without
        // already being inside the network, but it costs nothing to be steady.
        const presented = String(req.headers['x-service-token'] ?? '')
        if (!config.serviceToken || presented !== config.serviceToken) {
          res.writeHead(401).end('unauthorized')
          return
        }
        const payload = JSON.parse(await readBody(req)) as {
          kind?: string, embed?: unknown, content?: string
          /*
           * When present, the message is *managed*: posted the first time and
           * edited every time after. That is what makes a release that gains a
           * 1080p encode update in place instead of appearing twice, with no
           * way to tell which one is current.
           */
          key?: string, channel?: string, release?: Parameters<typeof releaseEmbed>[0]
        }
        if (!payload.kind) return json(400, { error: 'kind is required' })

        if (payload.key) {
          const guildId = config.guildId
          if (!guildId) return json(503, { error: 'DISCORD_GUILD_ID is not set; managed messages need it' })
          const channels = await channelMap(rest, guildId)
          const channelId = channels.get(payload.channel ?? 'new_releases')
          if (!channelId) return json(404, { error: `no channel for ${payload.channel ?? 'new_releases'}` })
          const body = payload.release
            ? releaseEmbed(payload.release)
            : { ...(payload.content ? { content: payload.content } : {}), ...(payload.embed ? { embeds: [payload.embed] } : {}) }
          const outcome = await syncMessage(rest, payload.key, channelId, body, guildId)
          return json(outcome === 'failed' ? 502 : 202, { outcome })
        }

        const delivered = await sendWebhook(payload.kind, { embeds: payload.embed ? [payload.embed] : undefined, content: payload.content })
        return json(delivered ? 202 : 503, { delivered })
      }

      res.writeHead(404).end('not found')
    } catch (err) {
      console.error('[yume-bot] request failed:', (err as Error).message)
      if (!res.headersSent) res.writeHead(500).end('error')
    }
  })()
})

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[yume-bot] listening on :${config.port} — interactions and notifications`)
})

// Static pages and live boards, posted once and edited thereafter. Started
// after listen so a slow first pass cannot delay the health check.
const stopSync = startSyncLoop(rest)

// The gateway exists for one event: a member joining. Everything else this bot
// does arrives over HTTP. Off unless DISCORD_WELCOME is on, because a bot that
// starts greeting strangers the moment it is installed is not a good first
// impression — and because the intent it needs must be granted deliberately.
const stopGateway = process.env.DISCORD_WELCOME === 'true' && gatewayConfigured()
  ? startGateway({ token: config.token, rest, onMemberJoin: member => onMemberJoin(rest, member) })
  : (() => {
      if (process.env.DISCORD_WELCOME === 'true') console.warn('[yume-bot] DISCORD_WELCOME is on but DISCORD_GUILD_ID is not set — welcome is off')
      return () => {}
    })()

// Compose sends SIGTERM on `down` and on a redeploy. Finishing in-flight
// requests keeps a deploy from showing up as failed interactions.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[yume-bot] ${signal} — shutting down`)
    stopSync()
    stopGateway()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
