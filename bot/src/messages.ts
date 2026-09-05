// Post once, edit thereafter.
//
// ---------------------------------------------------------------------------
// The problem
// ---------------------------------------------------------------------------
// A bot that can only post turns every refresh into a new message. #server-status
// fills with a thousand near-identical embeds a day, the rules get re-posted
// each time somebody fixes a typo in them, and a release that gains a 1080p
// encode appears twice with no way to tell which is current.
//
// What every one of those wants is the same thing: a message with an
// *identity*, updated in place.
//
// ---------------------------------------------------------------------------
// The four cases, and why the third one matters most
// ---------------------------------------------------------------------------
//   no record            → post it, remember the id            'created'
//   record, same hash    → do nothing at all                   'unchanged'
//   record, new hash     → edit that message                   'edited'
//   record, message gone → post again, remember the new id     'recreated'
//
// The `unchanged` case is the one that makes this usable. The boards re-render
// on a timer and most ticks change nothing; without the hash check every tick
// would be an API call and every message would wear a permanent `(edited)`
// marker. With it, a quiet hour is zero requests to Discord.
//
// Recreation exists because a moderator deleting a message is normal, and the
// bot noticing on the next tick and quietly replacing it is better than the
// board being gone until somebody re-runs setup.

import { createHash } from 'node:crypto'

import { config } from './config.ts'
import { DiscordError, type Rest } from './discord/rest.ts'

export type SyncOutcome = 'created' | 'unchanged' | 'edited' | 'recreated' | 'failed'

export interface MessagePayload {
  content?: string
  embeds?: unknown[]
  components?: unknown[]
}

interface StoredMessage {
  key: string
  guild_id: string
  channel_id: string
  message_id: string
  content_hash: string
}

/**
 * The hash the whole mechanism turns on.
 *
 * Over the rendered payload, so any visible difference changes it and nothing
 * invisible does. Timestamps are the trap here: an embed that carries
 * `new Date()` hashes differently every second and would rewrite itself
 * forever, so the boards below never put a clock in their body — the message's
 * own edit time already says when it last moved.
 */
export function hashPayload (payload: MessagePayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

async function readRecord (key: string): Promise<StoredMessage | null> {
  if (!config.serviceToken) return null
  try {
    const res = await fetch(`${config.apiUrl}/v1/integrations/discord/messages/${encodeURIComponent(key)}`, {
      headers: { 'X-Service-Token': config.serviceToken },
      signal: AbortSignal.timeout(5000)
    })
    if (res.status === 404) return null
    if (!res.ok) return null
    return await res.json() as StoredMessage
  } catch {
    return null
  }
}

async function writeRecord (key: string, record: { guildId: string, channelId: string, messageId: string, contentHash: string, edited: boolean }): Promise<void> {
  if (!config.serviceToken) return
  await fetch(`${config.apiUrl}/v1/integrations/discord/messages/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': config.serviceToken },
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(5000)
  }).catch(() => {})
}

/**
 * Put `payload` in `channelId` under `key`, creating or editing as needed.
 *
 * Without a service token there is nowhere to remember the id, so this falls
 * back to posting — a bot that cannot remember is still better than a bot that
 * says nothing, and the log says which mode it is in.
 */
export async function syncMessage (
  rest: Rest,
  key: string,
  channelId: string,
  payload: MessagePayload,
  guildId = config.guildId
): Promise<SyncOutcome> {
  const contentHash = hashPayload(payload)
  const existing = await readRecord(key)

  const create = async (outcome: 'created' | 'recreated'): Promise<SyncOutcome> => {
    const message = await rest.post<{ id: string }>(`/channels/${channelId}/messages`, payload)
    await writeRecord(key, { guildId, channelId, messageId: message.id, contentHash, edited: false })
    return outcome
  }

  try {
    if (!existing) return await create('created')

    // Nothing to say. This is the common case by a wide margin.
    if (existing.content_hash === contentHash && existing.channel_id === channelId) return 'unchanged'

    // The channel moved (re-provisioned into a new one): the old message is
    // not ours to edit any more, so start again where it belongs now.
    if (existing.channel_id !== channelId) return await create('recreated')

    try {
      await rest.patch(`/channels/${channelId}/messages/${existing.message_id}`, payload)
      await writeRecord(key, { guildId, channelId, messageId: existing.message_id, contentHash, edited: true })
      return 'edited'
    } catch (err) {
      // 404: somebody deleted it. 403: we lost access. Either way the record is
      // stale, and replacing it is more useful than reporting a failure.
      if (err instanceof DiscordError && (err.status === 404 || err.status === 403)) return await create('recreated')
      throw err
    }
  } catch (err) {
    console.warn(`[yume-bot] sync ${key} failed: ${(err as Error).message}`)
    return 'failed'
  }
}

/** Forget a key, so the next sync posts a fresh message. */
export async function forgetMessage (key: string): Promise<void> {
  if (!config.serviceToken) return
  await fetch(`${config.apiUrl}/v1/integrations/discord/messages/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { 'X-Service-Token': config.serviceToken },
    signal: AbortSignal.timeout(5000)
  }).catch(() => {})
}
