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
}

const channels = new Map<string, Set<Client>>()

function subscribe (client: Client, channel: string): void {
  client.channels.add(channel)
  if (!channels.has(channel)) channels.set(channel, new Set())
  channels.get(channel)!.add(client)
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
        subscribe(client, channel)
        publish(channel, { type: 'presence', count: presence(channel), joined: client.username })
      } else if (channel.startsWith('chat:')) {
        const chatId = channel.slice(5)
        const member = await queryOne('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, client.userId])
        if (!member) return client.socket.send(JSON.stringify({ error: 'not a member', channel }))
        subscribe(client, channel)
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

    // watch-together sync: relay play/pause/seek/position to the room
    case 'w2g': {
      const channel = String(msg.channel ?? '')
      if (!client.channels.has(channel)) return
      const action = String(msg.action ?? '')
      if (!['play', 'pause', 'seek', 'position', 'episode'].includes(action)) return
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

export default fp(async (app: FastifyInstance) => {
  await app.register(websocket)

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

    const client: Client = { socket, userId: payload.sub, username: payload.username, channels: new Set() }
    subscribe(client, `user:${client.userId}`)
    socket.send(JSON.stringify({ type: 'hello', username: client.username }))

    socket.on('message', (raw: Buffer) => {
      handleMessage(app, client, raw.toString()).catch(err => {
        app.log.error(err, 'ws message error')
      })
    })

    socket.on('close', () => {
      for (const channel of [...client.channels]) {
        unsubscribe(client, channel)
        if (channel.startsWith('w2g:')) publish(channel, { type: 'presence', count: presence(channel), left: client.username })
      }
    })
  })
})
