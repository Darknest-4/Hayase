// WebSocket layer: authenticated socket at /ws multiplexing channels.
//   user:{userId}   — notifications (auto-subscribed on connect)
//   w2g:{code}      — watch-together playback sync + presence
//   chat:{chatId}   — live chat (messages persisted to the messages table)
//
// The hub is in-process; publish() is the single seam where a Redis
// pub/sub adapter slots in for multi-instance deployments.

import websocket from '@fastify/websocket'
import fp from 'fastify-plugin'

import { query, queryOne } from '../db.ts'

import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'

interface Client {
  socket: WebSocket
  userId: string
  username: string
  channels: Set<string>
  /** Token expiry (epoch seconds) — the socket is closed once it passes. */
  expiresAt: number
  /** Token-bucket state for message rate limiting. */
  tokens: number
  lastRefill: number
  /** Consecutive refusals; enough of them close the socket. */
  strikes: number
}

const channels = new Map<string, Set<Client>>()
const clients = new Set<Client>()

// ---- abuse limits ----
// The HTTP rate limiter never sees socket traffic, so before this a single
// authenticated client could stream `chat` frames and turn each one into an
// unbounded INSERT. These bound what one connection can cost.

/** Sustained messages per second, and how many may arrive back to back. */
const MSG_RATE = Number(process.env.WS_MSG_PER_SEC ?? 10)
const MSG_BURST = Number(process.env.WS_MSG_BURST ?? 25)
/** Frames larger than this are dropped before JSON.parse ever sees them. */
const MAX_FRAME_BYTES = Number(process.env.WS_MAX_FRAME_BYTES ?? 16_384)
/** One client cannot hold subscriptions open without limit. */
const MAX_CHANNELS = Number(process.env.WS_MAX_CHANNELS ?? 20)
/** Refusals tolerated before the connection is closed. */
const MAX_STRIKES = 20
/** How often every live socket is re-checked against the database. */
const REAUTH_INTERVAL_MS = Number(process.env.WS_REAUTH_INTERVAL_MS ?? 60_000)

const CLOSE_POLICY = 4403
const CLOSE_EXPIRED = 4401

/**
 * Token bucket. Returns false when the client is over budget; the caller
 * counts a strike and eventually closes the socket, so a client that ignores
 * the refusals cannot simply keep pushing.
 */
function allow (client: Client): boolean {
  const now = Date.now()
  client.tokens = Math.min(MSG_BURST, client.tokens + ((now - client.lastRefill) / 1000) * MSG_RATE)
  client.lastRefill = now
  if (client.tokens < 1) return false
  client.tokens -= 1
  return true
}

function subscribe (client: Client, channel: string): boolean {
  if (!client.channels.has(channel) && client.channels.size >= MAX_CHANNELS) return false
  client.channels.add(channel)
  if (!channels.has(channel)) channels.set(channel, new Set())
  channels.get(channel)!.add(client)
  return true
}

function unsubscribe (client: Client, channel: string): void {
  client.channels.delete(channel)
  const set = channels.get(channel)
  if (!set) return
  set.delete(client)
  if (!set.size) channels.delete(channel)
}

/** Broadcast a payload to every subscriber of a channel. */
export function publish (channel: string, payload: Record<string, unknown>, except?: Client): void {
  const message = JSON.stringify({ channel, ...payload })
  for (const client of channels.get(channel) ?? []) {
    if (client === except) continue
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(message)
  }
}

export function presence (channel: string): number {
  return channels.get(channel)?.size ?? 0
}

async function handleMessage (app: FastifyInstance, client: Client, raw: string): Promise<void> {
  let msg: { type: string, channel?: string, [k: string]: unknown }
  try {
    msg = JSON.parse(raw)
  } catch {
    return client.socket.send(JSON.stringify({ error: 'invalid json' }))
  }

  switch (msg.type) {
    case 'join': {
      const channel = String(msg.channel ?? '')
      if (channel.startsWith('w2g:')) {
        const code = channel.slice(4)
        const room = await queryOne<{ id: string }>('SELECT id FROM watch_together_rooms WHERE code = $1 AND closed_at IS NULL', [code])
        if (!room) return client.socket.send(JSON.stringify({ error: 'room not found', channel }))
        if (!subscribe(client, channel)) return client.socket.send(JSON.stringify({ error: 'too many channels', channel }))
        publish(channel, { type: 'presence', count: presence(channel), joined: client.username })
      } else if (channel.startsWith('chat:')) {
        const chatId = channel.slice(5)
        const member = await queryOne('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, client.userId])
        if (!member) return client.socket.send(JSON.stringify({ error: 'not a member', channel }))
        if (!subscribe(client, channel)) return client.socket.send(JSON.stringify({ error: 'too many channels', channel }))
      } else {
        return client.socket.send(JSON.stringify({ error: 'unknown channel', channel }))
      }
      client.socket.send(JSON.stringify({ type: 'joined', channel, count: presence(channel) }))
      break
    }

    case 'leave': {
      const channel = String(msg.channel ?? '')
      unsubscribe(client, channel)
      if (channel.startsWith('w2g:')) publish(channel, { type: 'presence', count: presence(channel), left: client.username })
      break
    }

    // watch-together sync: relay play/pause/seek/position to the room.
    // Only the host drives playback — previously any participant could seek
    // or switch episode under everyone else.
    case 'w2g': {
      const channel = String(msg.channel ?? '')
      if (!client.channels.has(channel)) return
      const action = String(msg.action ?? '')
      if (!['play', 'pause', 'seek', 'position', 'episode'].includes(action)) return

      const host = await queryOne<{ id: string }>(
        `SELECT p.user_id AS id FROM watch_together_rooms r
         JOIN user_profiles p ON p.id = r.host_profile
         WHERE r.code = $1 AND r.closed_at IS NULL`,
        [channel.slice(4)]
      )
      if (host && host.id !== client.userId) {
        return client.socket.send(JSON.stringify({ error: 'only the host controls playback', channel }))
      }
      publish(channel, { type: 'w2g', action, position: Number(msg.position) || 0, episode: msg.episode, from: client.username }, client)
      break
    }

    // chat: persist then broadcast
    case 'chat': {
      const channel = `chat:${String(msg.chatId ?? '')}`
      if (!client.channels.has(channel)) return
      const body = String(msg.body ?? '').trim().slice(0, 4000)
      if (!body) return
      const rows = await query<{ id: string, created_at: string }>(
        'INSERT INTO messages (chat_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, created_at',
        [msg.chatId, client.userId, body]
      )
      publish(channel, { type: 'chat', id: rows[0]!.id, body, author: client.username, createdAt: rows[0]!.created_at })
      break
    }

    case 'ping':
      client.socket.send(JSON.stringify({ type: 'pong' }))
      break
  }
}

/**
 * Re-check every live socket.
 *
 * Authentication used to happen once, at connect, and never again: a token
 * could expire, the user could sign out, or an administrator could ban the
 * account, and the socket carried on regardless. On HTTP that window is the
 * 15-minute token lifetime; on a socket it was unbounded.
 *
 * One sweep, one query for all connected users — not one per client.
 */
async function reauthenticate (app: FastifyInstance): Promise<void> {
  if (!clients.size) return
  const now = Math.floor(Date.now() / 1000)

  for (const client of [...clients]) {
    if (client.expiresAt && client.expiresAt <= now) {
      client.socket.close(CLOSE_EXPIRED, 'token expired')
      clients.delete(client)
    }
  }
  if (!clients.size) return

  const userIds = [...new Set([...clients].map(client => client.userId))]
  const active = await query<{ id: string }>(
    "SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'active' AND deleted_at IS NULL",
    [userIds]
  )
  const allowed = new Set(active.map(row => row.id))

  for (const client of [...clients]) {
    if (!allowed.has(client.userId)) {
      app.log.info({ userId: client.userId }, 'closing socket: account no longer active')
      client.socket.close(CLOSE_POLICY, 'account is no longer active')
      clients.delete(client)
    }
  }
}

export default fp(async (app: FastifyInstance) => {
  await app.register(websocket)

  const sweep = setInterval(() => {
    void reauthenticate(app).catch(err => app.log.error(err, 'ws reauth sweep failed'))
  }, REAUTH_INTERVAL_MS)
  sweep.unref()
  app.addHook('onClose', async () => clearInterval(sweep))

  app.get('/ws', { websocket: true }, (socket, req) => {
    // auth: ?token=<access JWT>
    let payload: { sub: string, username: string }
    try {
      const token = (req.query as { token?: string }).token ?? ''
      payload = app.jwt.verify(token)
    } catch {
      socket.close(4401, 'unauthorized')
      return
    }

    const client: Client = {
      socket,
      userId: payload.sub,
      username: payload.username,
      channels: new Set(),
      expiresAt: Number((payload as { exp?: number }).exp ?? 0),
      tokens: MSG_BURST,
      lastRefill: Date.now(),
      strikes: 0
    }
    clients.add(client)
    subscribe(client, `user:${client.userId}`)
    socket.send(JSON.stringify({ type: 'hello', username: client.username }))

    socket.on('message', (raw: Buffer) => {
      // Size is checked on the buffer, before any parsing, so an oversized
      // frame costs nothing beyond the bytes already received.
      if (raw.length > MAX_FRAME_BYTES) {
        socket.send(JSON.stringify({ error: 'message too large' }))
        if (++client.strikes >= MAX_STRIKES) socket.close(CLOSE_POLICY, 'too many refused messages')
        return
      }
      if (!allow(client)) {
        socket.send(JSON.stringify({ error: 'rate limited' }))
        if (++client.strikes >= MAX_STRIKES) socket.close(CLOSE_POLICY, 'rate limit exceeded')
        return
      }
      client.strikes = 0
      handleMessage(app, client, raw.toString()).catch(err => {
        app.log.error(err, 'ws message error')
      })
    })

    socket.on('close', () => {
      clients.delete(client)
      for (const channel of [...client.channels]) {
        unsubscribe(client, channel)
        if (channel.startsWith('w2g:')) publish(channel, { type: 'presence', count: presence(channel), left: client.username })
      }
    })
  })
})
