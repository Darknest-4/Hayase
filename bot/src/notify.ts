// Outbound Discord webhooks, and the redaction that guards them.
//
// A webhook URL is a bearer credential: anyone holding it can post into that
// channel forever. They live in the environment, never in the database, and
// are never echoed back — not into a log line, not into an embed, not into an
// admin panel.

const WEBHOOK_ENV: Record<string, string> = {
  security: 'DISCORD_SECURITY_WEBHOOK',
  system: 'DISCORD_SYSTEM_WEBHOOK',
  release: 'DISCORD_RELEASE_WEBHOOK',
  video: 'DISCORD_VIDEO_WEBHOOK',
  analytics: 'DISCORD_ANALYTICS_WEBHOOK',
  content: 'DISCORD_CONTENT_WEBHOOK'
}

/**
 * Field names whose values must never reach Discord.
 *
 * A security alert is exactly the message most likely to be carrying the thing
 * it is warning about — a failed-login event that helpfully includes the
 * password attempted, a rate-limit alert with the API key that hit it. Discord
 * messages are readable by every staff member, retained indefinitely, and
 * outside our control entirely.
 *
 * Matched as substrings and case-insensitively, so `resetToken`,
 * `X-API-Key` and `session_token` are all caught by their stem.
 */
const FORBIDDEN = [
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'authorization',
  'cookie', 'session', 'credential', 'privatekey', 'private_key', 'jwt', 'hash',
  'otp', 'mfa', 'signature'
]

const isForbidden = (key: string): boolean => {
  const flat = key.toLowerCase().replace(/[^a-z]/g, '')
  return FORBIDDEN.some(word => flat.includes(word.replace(/[^a-z]/g, '')))
}

/** An IP is identifying. Kept only as a stable prefix, so patterns still read. */
export function maskIp (value: string): string {
  const v6 = value.includes(':')
  if (v6) return value.split(':').slice(0, 2).join(':') + ':…'
  const parts = value.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : value
}

const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

/**
 * Strip anything secret from an event before it is sent.
 *
 * Whole values are removed rather than truncated: half a token is still a
 * clue, and the field's *presence* is the useful part of the signal anyway.
 */
export function redact (value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (typeof value === 'string') return value.replace(IP_PATTERN, m => maskIp(m)).slice(0, 1000)
  if (Array.isArray(value)) return value.slice(0, 25).map(v => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (isForbidden(key)) { out[key] = '[redacted]'; continue }
      if (/^ip$|ip_?address|remote_?addr/i.test(key) && typeof inner === 'string') { out[key] = maskIp(inner); continue }
      out[key] = redact(inner, depth + 1)
    }
    return out
  }
  return value
}

/** Post to one of the configured webhooks. Returns false when it is not configured. */
export async function sendWebhook (kind: string, payload: { content?: string | undefined, embeds?: unknown[] | undefined }): Promise<boolean> {
  const env = WEBHOOK_ENV[kind]
  const url = env ? process.env[env] : undefined
  if (!url) return false

  const body = redact({ ...payload, username: 'Yume' }) as Record<string, unknown>
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    })
    // The URL must not appear in the log: it is the credential.
    if (!res.ok) console.warn(`[yume-bot] ${kind} webhook → ${res.status}`)
    return res.ok
  } catch (err) {
    console.warn(`[yume-bot] ${kind} webhook failed: ${(err as Error).message}`)
    return false
  }
}

export { WEBHOOK_ENV }
