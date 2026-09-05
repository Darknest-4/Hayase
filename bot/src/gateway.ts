// A gateway connection, for the one thing HTTP interactions cannot do.
//
// ---------------------------------------------------------------------------
// Why this exists at all
// ---------------------------------------------------------------------------
// Slash commands arrive as HTTP callbacks, which is why the rest of this bot
// needs no socket. But nobody *sends* a request when a member joins — Discord
// pushes that over the gateway or not at all. A welcome message therefore
// needs a connection, and this is the smallest one that works.
//
// `docs/discord-bot.md` argues for discord.js and is right about a full
// client: sharding, per-route rate-limit buckets, a bounded cache, every event
// type. This subscribes to one intent and handles one event, so what is left
// is identify, heartbeat, resume, and knowing when the connection has died
// without saying so. That is this file, and it is small enough to read.
//
// ---------------------------------------------------------------------------
// The privileged intent
// ---------------------------------------------------------------------------
// GUILD_MEMBERS is privileged: Discord will not send member events unless the
// application has "Server Members Intent" switched on in the developer portal.
// Without it the socket connects, everything looks healthy, and no welcome
// ever fires. So a failure to identify is reported loudly rather than retried
// quietly — see the 4014 case below.

import { config } from './config.ts'
import type { Rest } from './discord/rest.ts'

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

/** GUILD_MEMBERS only. Every intent not asked for is data we never receive. */
const INTENTS = 1 << 1

const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11
} as const

export interface GatewayMember {
  guildId: string
  userId: string
  username: string
  bot: boolean
}

export interface GatewayOptions {
  token: string
  rest: Rest
  onMemberJoin: (member: GatewayMember) => Promise<void>
  /** Injected in tests; defaults to the real gateway. */
  url?: string
}

/**
 * Connect, stay connected, and call `onMemberJoin` for each new member.
 *
 * Returns a stop function. Everything about reconnection is deliberate:
 *
 *   - **Resume before re-identify.** A dropped socket with a session id and a
 *     sequence number resumes and replays what was missed. Re-identifying
 *     instead loses those events and burns one of the daily identify budget.
 *   - **Zombie detection.** A TCP connection can stay open while the other end
 *     is gone. If a heartbeat is not acknowledged before the next one is due,
 *     the socket is closed deliberately rather than trusted.
 *   - **Backoff.** Reconnect attempts grow to a minute. A bot that reconnects
 *     in a tight loop is how an application gets rate limited off the gateway.
 */
export function startGateway (options: GatewayOptions): () => void {
  let socket: WebSocket | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let sequence: number | null = null
  let sessionId: string | null = null
  let resumeUrl: string | null = null
  let acked = true
  let attempts = 0
  let stopped = false

  const clearHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  const connect = (): void => {
    if (stopped) return
    const url = sessionId && resumeUrl ? `${resumeUrl}/?v=10&encoding=json` : (options.url ?? GATEWAY_URL)
    const ws = new WebSocket(url)
    socket = ws

    ws.addEventListener('open', () => { attempts = 0 })

    ws.addEventListener('message', event => {
      let payload: { op: number, d?: unknown, s?: number | null, t?: string | null }
      try {
        payload = JSON.parse(String(event.data)) as typeof payload
      } catch { return }

      if (payload.s != null) sequence = payload.s

      switch (payload.op) {
        case OP.hello: {
          const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval
          acked = true
          clearHeartbeat()
          heartbeat = setInterval(() => {
            if (!acked) {
              // The other end stopped answering. Closing with 4000 asks for a
              // resumable session rather than a fresh one.
              console.warn('[yume-bot] gateway heartbeat not acknowledged — reconnecting')
              try { ws.close(4000, 'heartbeat timeout') } catch { /* already gone */ }
              return
            }
            acked = false
            ws.send(JSON.stringify({ op: OP.heartbeat, d: sequence }))
          }, interval)

          if (sessionId && sequence != null) {
            ws.send(JSON.stringify({ op: OP.resume, d: { token: options.token, session_id: sessionId, seq: sequence } }))
          } else {
            ws.send(JSON.stringify({
              op: OP.identify,
              d: {
                token: options.token,
                intents: INTENTS,
                properties: { os: 'linux', browser: 'yume-bot', device: 'yume-bot' }
              }
            }))
          }
          break
        }

        case OP.heartbeatAck:
          acked = true
          break

        case OP.reconnect:
          try { ws.close(4000, 'server asked') } catch { /* already gone */ }
          break

        case OP.invalidSession:
          // Not resumable: forget the session so the next hello identifies.
          sessionId = null
          sequence = null
          try { ws.close(4000, 'invalid session') } catch { /* already gone */ }
          break

        case OP.dispatch: {
          if (payload.t === 'READY') {
            const ready = payload.d as { session_id: string, resume_gateway_url?: string }
            sessionId = ready.session_id
            resumeUrl = ready.resume_gateway_url ?? null
            console.log('[yume-bot] gateway ready — watching for new members')
          } else if (payload.t === 'RESUMED') {
            console.log('[yume-bot] gateway resumed')
          } else if (payload.t === 'GUILD_MEMBER_ADD') {
            const member = payload.d as { guild_id: string, user?: { id: string, username: string, bot?: boolean } }
            if (!member.user) break
            void options.onMemberJoin({
              guildId: member.guild_id,
              userId: member.user.id,
              username: member.user.username,
              bot: member.user.bot === true
            }).catch(err => console.warn('[yume-bot] welcome failed:', (err as Error).message))
          }
          break
        }
      }
    })

    ws.addEventListener('close', event => {
      clearHeartbeat()
      socket = null
      if (stopped) return

      // 4014 is "you asked for an intent you were not granted". Retrying that
      // forever would look like a network problem and never be one.
      if (event.code === 4014) {
        console.error('[yume-bot] gateway refused: the Server Members Intent is not enabled for this application.')
        console.error('[yume-bot] Enable it at https://discord.com/developers/applications → Bot → Privileged Gateway Intents.')
        stopped = true
        return
      }
      // 4004 is a bad token. Also not a network problem.
      if (event.code === 4004) {
        console.error('[yume-bot] gateway refused: DISCORD_BOT_TOKEN is not valid.')
        stopped = true
        return
      }
      // These say the session cannot be resumed; drop it before reconnecting.
      if ([4007, 4009, 4990].includes(event.code)) { sessionId = null; sequence = null }

      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts++, 6))
      console.warn(`[yume-bot] gateway closed (${event.code}) — reconnecting in ${Math.round(delay / 1000)}s`)
      setTimeout(connect, delay).unref?.()
    })

    ws.addEventListener('error', () => {
      // 'close' always follows, and reconnection is handled there. Logging
      // both would double every transient blip in the log.
    })
  }

  connect()

  return () => {
    stopped = true
    clearHeartbeat()
    try { socket?.close(1000, 'shutting down') } catch { /* already gone */ }
  }
}

/** Is there enough configuration to open a gateway connection? */
export const gatewayConfigured = (): boolean => Boolean(config.token && config.guildId)
