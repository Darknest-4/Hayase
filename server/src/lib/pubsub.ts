// Cross-instance message fan-out for the WebSocket layer.
//
// The hub kept its subscriptions in a process-local Map, which is correct for
// one instance and quietly wrong for two: notifications reach only the clients
// attached to the instance that produced them, watch-together rooms split in
// half, and chat messages vanish for everyone connected elsewhere. Nothing
// errors — it simply half-works, which is the worst failure mode to ship.
//
// This is deliberately built on **Postgres LISTEN/NOTIFY rather than Redis**.
// Redis was the obvious answer and it is the wrong one here: Postgres is
// already a hard dependency, LISTEN/NOTIFY needs no new package, no new
// container and no second thing to keep alive, and at this message volume the
// difference is unmeasurable. Redis would have bought a dependency and an
// operational burden to solve a problem the existing database already solves.
//
// Two constraints shape the implementation:
//
//   * LISTEN needs its own connection — a pooled one would be handed back and
//     stop listening — so this holds a dedicated client outside the pool.
//   * NOTIFY payloads are capped at 8000 bytes by Postgres (verified). Chat
//     bodies can exceed that, so an oversized message is sent by reference and
//     the receiving instance reads the row it already persisted.

import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { config } from '../config.ts'
import { query } from '../db.ts'

/** One Postgres notification channel carries everything; the app channel is inside. */
const NOTIFY_CHANNEL = 'yume_ws'

/** Postgres refuses a NOTIFY payload over 8000 bytes; stay clear of the edge. */
const MAX_PAYLOAD_BYTES = Number(process.env.PUBSUB_MAX_PAYLOAD_BYTES ?? 7_500)

/** Identifies this process, so a notification we sent is not delivered twice. */
export const INSTANCE_ID = randomUUID()

type Deliver = (channel: string, payload: Record<string, unknown>) => void

let client: pg.Client | undefined
let deliverLocally: Deliver | undefined
let stopped = false
let retryDelay = 1_000
let reconnectTimer: NodeJS.Timeout | undefined

/** Whether cross-instance delivery is currently working. */
export function connected (): boolean {
  return client !== undefined
}

async function connect (log: (message: string, error?: unknown) => void): Promise<void> {
  if (stopped) return
  const next = new pg.Client({ connectionString: config.databaseUrl })

  next.on('notification', message => {
    if (message.channel !== NOTIFY_CHANNEL || !message.payload) return
    try {
      const envelope = JSON.parse(message.payload) as {
        from: string
        channel: string
        payload?: Record<string, unknown>
        ref?: { table: 'messages', id: string }
      }
      // Our own notification: the local subscribers already have it.
      if (envelope.from === INSTANCE_ID) return

      if (envelope.payload) {
        deliverLocally?.(envelope.channel, envelope.payload)
      } else if (envelope.ref) {
        void rehydrate(envelope.channel, envelope.ref).catch(err => log('rehydrate failed', err))
      }
    } catch (err) {
      log('malformed notification', err)
    }
  })

  // A dropped listener is silent data loss, so reconnect rather than give up.
  next.on('error', err => {
    log('pubsub connection lost, reconnecting', err)
    client = undefined
    next.end().catch(() => {})
    scheduleReconnect(log)
  })

  try {
    await next.connect()
    await next.query(`LISTEN ${NOTIFY_CHANNEL}`)

    // stop() may have run while this connect was in flight. Without this
    // check the client is installed after shutdown and never closed — a
    // leaked connection that keeps the process alive and, in a server that
    // restarts under load, accumulates one per cycle.
    if (stopped) { await next.end().catch(() => {}); return }

    client = next
    retryDelay = 1_000
  } catch (err) {
    log('pubsub connect failed, retrying', err)
    await next.end().catch(() => {})
    scheduleReconnect(log)
  }
}

/**
 * Retry with backoff. The timer is unref'd so a pending reconnect can never be
 * the reason a process refuses to exit.
 */
function scheduleReconnect (log: (message: string, error?: unknown) => void): void {
  if (stopped) return
  retryDelay = Math.min(retryDelay * 2, 30_000)
  reconnectTimer = setTimeout(() => { void connect(log) }, retryDelay)
  reconnectTimer.unref()
}

/**
 * Fetch a message that was too large to travel inside a notification.
 *
 * Only chat can exceed the cap, and a chat message is always persisted before
 * it is broadcast — so the row is guaranteed to be there.
 */
async function rehydrate (channel: string, ref: { table: 'messages', id: string }): Promise<void> {
  if (ref.table !== 'messages') return
  const rows = await query<{ id: string, body: string, created_at: string, author: string }>(
    `SELECT m.id, m.body, m.created_at, u.username AS author
       FROM messages m JOIN users u ON u.id = m.author_id
      WHERE m.id = $1`,
    [ref.id]
  )
  const row = rows[0]
  if (row) {
    deliverLocally?.(channel, { type: 'chat', id: row.id, body: row.body, author: row.author, createdAt: row.created_at })
  }
}

/** Start listening. `deliver` hands a remote message to the local hub. */
export async function start (
  deliver: Deliver,
  log: (message: string, error?: unknown) => void = () => {}
): Promise<void> {
  deliverLocally = deliver
  stopped = false
  await connect(log)
}

export async function stop (): Promise<void> {
  stopped = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
  const current = client
  client = undefined
  await current?.end().catch(() => {})
}

/**
 * Announce a message to the other instances.
 *
 * Local delivery is the caller's job and happens first — this instance must
 * never wait on the database to serve its own connected clients.
 *
 * Best effort: a failed NOTIFY degrades to single-instance behaviour, which is
 * exactly where the system was before, rather than failing the message.
 */
export function broadcast (channel: string, payload: Record<string, unknown>, ref?: { table: 'messages', id: string }): void {
  if (!client) return // not connected: local delivery already happened

  let body = JSON.stringify({ from: INSTANCE_ID, channel, payload })
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
    // Too large to inline. Send the reference instead so the other instances
    // can read the row rather than dropping the message.
    if (!ref) return
    body = JSON.stringify({ from: INSTANCE_ID, channel, ref })
  }

  client.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, body]).catch(() => {})
}
