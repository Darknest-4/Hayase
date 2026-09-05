// Yume → Discord.
//
// The site's own events reach Discord through the bot service rather than
// through the `webhooks` table, for one reason: a Discord webhook URL is a
// bearer credential, and the brief for this integration is explicit that it
// must not sit in the database in plaintext. So the URLs live in the bot's
// environment, the bot owns delivery, and the API only says what happened.
//
// The generic `webhooks` table stays exactly as it is for everything else —
// this is an additional path, not a replacement.
//
// Every call here is best effort. A release is published whether or not
// Discord hears about it, and an API request must never fail because a chat
// server was slow.

const BOT_URL = process.env.YUME_BOT_URL ?? 'http://bot:4100'
const SERVICE_TOKEN = process.env.YUME_SERVICE_TOKEN ?? ''

export type DiscordChannel = 'security' | 'system' | 'release' | 'video' | 'analytics' | 'content'

export interface DiscordEmbed {
  title?: string
  description?: string
  color?: number
  url?: string
  fields?: Array<{ name: string, value: string, inline?: boolean }>
  footer?: { text: string }
  timestamp?: string
}

export const COLORS = {
  ok: 0x57F287,
  warn: 0xFEE75C,
  danger: 0xED4245,
  info: 0x5865F2,
  brand: 0xE91E63
} as const

/** True when there is a bot to talk to. Callers use it to skip work entirely. */
export const discordEnabled = (): boolean => Boolean(SERVICE_TOKEN)

/**
 * Hand one event to the bot.
 *
 * Never throws and never blocks a request for long: three seconds, then give
 * up. The bot redacts again on its side — this is not the only guard, because
 * a single point of redaction is one edit away from being no redaction.
 */
export async function notifyDiscord (channel: DiscordChannel, embed: DiscordEmbed): Promise<boolean> {
  if (!discordEnabled()) return false
  try {
    const res = await fetch(`${BOT_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': SERVICE_TOKEN },
      body: JSON.stringify({ kind: channel, embed: { timestamp: new Date().toISOString(), ...embed } }),
      signal: AbortSignal.timeout(3000)
    })
    return res.ok
  } catch {
    return false
  }
}

/** A new episode is available. The button points at the player. */
export async function announceRelease (release: {
  title: string
  episode: number | string
  season?: string | null
  quality?: string | null
  subtitles?: string | null
  status?: string | null
  url: string
  coverUrl?: string | null
}): Promise<boolean> {
  return notifyDiscord('release', {
    title: '🎬 NEW RELEASE',
    description: `**[${release.title}](${release.url})**`,
    color: COLORS.brand,
    url: release.url,
    fields: [
      { name: 'Episode', value: String(release.episode), inline: true },
      ...(release.season ? [{ name: 'Season', value: release.season, inline: true }] : []),
      ...(release.quality ? [{ name: 'Quality', value: release.quality, inline: true }] : []),
      ...(release.subtitles ? [{ name: 'Subtitles', value: release.subtitles, inline: true }] : []),
      ...(release.status ? [{ name: 'Status', value: release.status, inline: true }] : [])
    ]
  })
}

/**
 * A security event.
 *
 * The caller passes a short kind and a few facts. It must not pass the thing
 * that went wrong — the password tried, the token presented — and the bot
 * strips those field names again on the way out. An IP is masked to its first
 * two octets, which keeps "the same network again" readable without keeping
 * the address.
 */
export async function announceSecurity (event: {
  kind: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  summary: string
  facts?: Record<string, string | number>
}): Promise<boolean> {
  const colour = event.severity === 'critical' || event.severity === 'high' ? COLORS.danger
    : event.severity === 'medium' ? COLORS.warn
      : COLORS.info
  return notifyDiscord('security', {
    title: `🚨 ${event.kind.toUpperCase()}`,
    description: event.summary,
    color: colour,
    fields: [
      { name: 'Severity', value: event.severity, inline: true },
      ...Object.entries(event.facts ?? {}).slice(0, 8).map(([name, value]) => ({ name, value: String(value), inline: true }))
    ]
  })
}

/** A service changed state. */
export async function announceService (service: string, status: 'healthy' | 'degraded' | 'down', detail?: string): Promise<boolean> {
  const icon = status === 'healthy' ? '🟢' : status === 'degraded' ? '🟡' : '🔴'
  return notifyDiscord('system', {
    title: `${icon} ${service} — ${status}`,
    ...(detail ? { description: detail } : {}),
    color: status === 'healthy' ? COLORS.ok : status === 'degraded' ? COLORS.warn : COLORS.danger
  })
}

/** A video provider went down or came back. */
export async function announceVideoProvider (provider: string, status: 'down' | 'recovered', detail?: {
  affectedQuality?: string
  failureCount?: number
  lastSuccess?: string
}): Promise<boolean> {
  return notifyDiscord('video', {
    title: status === 'down' ? '🔴 VIDEO PROVIDER DOWN' : '🟢 VIDEO PROVIDER RECOVERED',
    color: status === 'down' ? COLORS.danger : COLORS.ok,
    fields: [
      { name: 'Provider', value: provider, inline: true },
      { name: 'Status', value: status, inline: true },
      ...(detail?.affectedQuality ? [{ name: 'Affected quality', value: detail.affectedQuality, inline: true }] : []),
      ...(detail?.failureCount !== undefined ? [{ name: 'Failures', value: String(detail.failureCount), inline: true }] : []),
      ...(detail?.lastSuccess ? [{ name: 'Last success', value: detail.lastSuccess, inline: true }] : [])
    ]
  })
}

/** A deployment finished. */
export async function announceDeployment (result: {
  ok: boolean
  version?: string
  commit?: string
  services?: string
  durationSeconds?: number
  error?: string
}): Promise<boolean> {
  return notifyDiscord('system', {
    title: result.ok ? '🚀 DEPLOYMENT SUCCESS' : '🚨 DEPLOYMENT FAILED',
    color: result.ok ? COLORS.ok : COLORS.danger,
    fields: [
      ...(result.version ? [{ name: 'Version', value: result.version, inline: true }] : []),
      ...(result.commit ? [{ name: 'Commit', value: result.commit.slice(0, 12), inline: true }] : []),
      ...(result.services ? [{ name: 'Services', value: result.services, inline: true }] : []),
      ...(result.durationSeconds !== undefined ? [{ name: 'Duration', value: `${result.durationSeconds}s`, inline: true }] : []),
      ...(result.error ? [{ name: 'Error', value: result.error.slice(0, 1000) }] : [])
    ]
  })
}
