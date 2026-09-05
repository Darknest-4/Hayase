// The loop that keeps the managed messages true.
//
// Two kinds of message, one mechanism:
//
//   static   welcome / rules / faq — change when this repository changes
//   boards   status / video / blueprint — change when the system does
//
// Both go through `syncMessage`, so both are posted once and edited after. The
// loop runs on a timer and is *quiet by construction*: a tick where nothing
// moved makes one cheap API call to read the channel list and then stops,
// because every payload hashes to what is already stored.
//
// Deliberately not a cron: the interval is short (a minute by default) and a
// missed tick has no consequence — the next one renders current state, not a
// backlog. There is nothing to catch up on.

import { allChannels } from './blueprint.ts'
import { config } from './config.ts'
import type { Channel, Rest } from './discord/rest.ts'
import { CHANNEL_TYPES } from './discord/rest.ts'
import { STATIC_PAGES, blueprintBoard, staticPage, statusBoard, videoBoard, type ServiceState } from './content.ts'
import { syncMessage, type SyncOutcome } from './messages.ts'
import { yume } from './yume.ts'

/** blueprint key → Discord channel id, for the guild we are provisioning. */
export async function channelMap (rest: Rest, guildId: string): Promise<Map<string, string>> {
  const channels = await rest.get<Channel[]>(`/guilds/${guildId}/channels`)
  const categories = new Map(channels.filter(c => c.type === CHANNEL_TYPES.category).map(c => [c.id, c.name]))
  const map = new Map<string, string>()

  for (const { category, channel } of allChannels()) {
    const found = channels.find(c =>
      c.name === channel.name &&
      c.type !== CHANNEL_TYPES.category &&
      (c.parent_id ? categories.get(c.parent_id) === category.name : false))
    if (found) map.set(channel.key, found.id)
  }
  return map
}

/** What the API can tell us about itself, as board rows. */
export async function currentServices (): Promise<ServiceState[]> {
  const [health, ready] = await Promise.all([yume.health(), yume.ready()])
  if (!health.ok) {
    // The API being unreachable is itself the answer, and guessing at the
    // services behind it would be inventing data.
    return [
      { name: 'Website', status: 'down' },
      { name: 'API', status: 'down' },
      { name: 'Database', status: 'unknown' },
      { name: 'Discord', status: 'healthy' }
    ]
  }

  const services: ServiceState[] = [
    { name: 'Website', status: 'healthy' },
    { name: 'API', status: 'healthy' }
  ]
  for (const [name, value] of Object.entries((ready ?? {}) as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') continue
    const ok = value === true || value === 'ok' || value === 'up' || value === 'healthy'
    services.push({ name: name[0]!.toUpperCase() + name.slice(1), status: ok ? 'healthy' : 'down' })
  }
  services.push({ name: 'Discord', status: 'healthy' })
  return services
}

export interface SyncSummary { created: number, edited: number, unchanged: number, recreated: number, failed: number }

const blank = (): SyncSummary => ({ created: 0, edited: 0, unchanged: 0, recreated: 0, failed: 0 })

/**
 * One pass over every managed message.
 *
 * `staticOnly` is what provisioning runs: the pages need to exist before
 * anybody reads the server, while the boards want live data that may not be
 * available during setup.
 */
export async function syncAll (rest: Rest, guildId: string, options: { staticOnly?: boolean } = {}): Promise<SyncSummary> {
  const summary = blank()
  const count = (outcome: SyncOutcome): void => { summary[outcome === 'failed' ? 'failed' : outcome]++ }

  const channels = await channelMap(rest, guildId)
  const into = async (channelKey: string, messageKey: string, payload: Parameters<typeof syncMessage>[3]): Promise<void> => {
    const channelId = channels.get(channelKey)
    // A channel the blueprint declares but the server does not have yet is not
    // an error here: provisioning creates it, and the next pass fills it.
    if (!channelId) return
    count(await syncMessage(rest, messageKey, channelId, payload, guildId))
  }

  for (const page of STATIC_PAGES) await into(page, `static:${page}`, staticPage(page))
  await into('server_status', 'board:blueprint', blueprintBoard())

  if (!options.staticOnly) {
    await into('server_status', 'board:status', statusBoard(await currentServices()))
    await into('video_monitor', 'board:video', videoBoard(await providerStates()))
  }

  return summary
}

/**
 * Video provider health.
 *
 * The API has no endpoint for this yet — provider status lives in the client's
 * extension host, which the bot cannot see. Returning an empty list makes the
 * board say "no providers reporting" rather than invent green ticks, which is
 * the honest state until that endpoint exists.
 */
async function providerStates (): Promise<Array<{ name: string, status: 'healthy' | 'degraded' | 'down' | 'unknown', qualities?: string[], failures?: number }>> {
  return []
}

let timer: NodeJS.Timeout | null = null

/** Start the loop. Returns a stop function for a clean shutdown. */
export function startSyncLoop (rest: Rest, intervalMs = Number(process.env.SYNC_INTERVAL_MS ?? 60_000)): () => void {
  const guildId = config.guildId
  if (!guildId) {
    console.log('[yume-bot] DISCORD_GUILD_ID is not set — message sync is off')
    return () => {}
  }

  const tick = async (): Promise<void> => {
    try {
      const summary = await syncAll(rest, guildId)
      // Silence when nothing happened. A line per minute saying "nothing
      // happened" is how a log stops being read.
      if (summary.created || summary.edited || summary.recreated || summary.failed) {
        console.log(`[yume-bot] sync: ${summary.created} created, ${summary.edited} edited, ${summary.recreated} recreated, ${summary.unchanged} unchanged${summary.failed ? `, ${summary.failed} failed` : ''}`)
      }
    } catch (err) {
      console.warn('[yume-bot] sync pass failed:', (err as Error).message)
    }
  }

  void tick()
  timer = setInterval(() => { void tick() }, Math.max(15_000, intervalMs))
  // Do not hold the process open on its own account.
  timer.unref()
  console.log(`[yume-bot] message sync every ${Math.round(Math.max(15_000, intervalMs) / 1000)}s`)

  return () => { if (timer) clearInterval(timer); timer = null }
}
