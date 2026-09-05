// A small Discord REST client.
//
// No dependency: `fetch` is global in Node 22, and what a library would add
// here is the part this file is — retry on 429 with the bucket's own
// `retry_after`, and a typed error that says which route failed.
//
// The gateway is a different problem (identify/heartbeat/resume, zombie
// detection, sharding) and `docs/discord-bot.md` is right that it wants a
// library. Provisioning, slash commands over HTTP interactions, moderation and
// webhooks are all REST, so none of that machinery is needed for any of it.

const API = 'https://discord.com/api/v10'

export class DiscordError extends Error {
  // Plain fields rather than constructor parameter properties: Node's
  // strip-only TypeScript mode (which is how everything here runs, with no
  // build step) does not support them.
  readonly status: number
  readonly route: string
  readonly body: unknown

  constructor (status: number, route: string, body: unknown) {
    const detail = typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : ''
    super(`Discord ${status} on ${route}${detail ? `: ${detail}` : ''}`)
    this.name = 'DiscordError'
    this.status = status
    this.route = route
    this.body = body
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export interface RestOptions {
  token: string
  /** Overridable so tests can drive the client without a network. */
  fetchImpl?: typeof fetch
  /** Called with every request for the audit trail. */
  onRequest?: (method: string, route: string, status: number) => void
}

export class Rest {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly onRequest: RestOptions['onRequest']

  constructor (options: RestOptions) {
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
    this.onRequest = options.onRequest
  }

  async request<T> (method: string, route: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await this.fetchImpl(API + route, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
        // Discord asks for this and uses it to contact you before banning the
        // application rather than after.
        'User-Agent': 'YumeBot (https://github.com/Darknest-4/Hayase, 1.0)'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })

    this.onRequest?.(method, route, res.status)

    if (res.status === 429) {
      // Discord tells us exactly how long to wait; guessing is how an
      // application gets its token revoked for abuse.
      const payload = await res.json().catch(() => ({})) as { retry_after?: number }
      if (attempt >= 5) throw new DiscordError(429, route, payload)
      await sleep(Math.ceil((payload.retry_after ?? 1) * 1000) + 250)
      return this.request<T>(method, route, body, attempt + 1)
    }

    // 5xx is Discord having a bad minute, not us being wrong.
    if (res.status >= 500 && attempt < 3) {
      await sleep(1000 * (attempt + 1))
      return this.request<T>(method, route, body, attempt + 1)
    }

    if (res.status === 204) return undefined as T
    const payload = await res.json().catch(() => null)
    if (!res.ok) throw new DiscordError(res.status, route, payload)
    return payload as T
  }

  get<T> (route: string): Promise<T> { return this.request<T>('GET', route) }
  post<T> (route: string, body?: unknown): Promise<T> { return this.request<T>('POST', route, body) }
  patch<T> (route: string, body?: unknown): Promise<T> { return this.request<T>('PATCH', route, body) }
  put<T> (route: string, body?: unknown): Promise<T> { return this.request<T>('PUT', route, body) }
  delete<T> (route: string): Promise<T> { return this.request<T>('DELETE', route) }
}

// ---- the shapes this project actually reads ------------------------------

export interface Guild { id: string, name: string, owner_id: string }
export interface Role { id: string, name: string, position: number, permissions: string, color: number, managed?: boolean }
export interface Channel { id: string, name: string, type: number, parent_id?: string | null, position?: number, topic?: string | null }
export interface Webhook { id: string, name: string, url?: string, channel_id: string, token?: string }

/** Discord channel type numbers, named. */
export const CHANNEL_TYPES = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  forum: 15
} as const
