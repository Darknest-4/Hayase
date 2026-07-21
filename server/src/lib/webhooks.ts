// Outbound webhook system.
//   emitEvent(type, data)  — called from routes/workers; enqueues one
//                            delivery job per subscribed, enabled webhook
//   handleWebhookJob       — delivers: Discord embeds for discord format,
//                            HMAC-signed JSON for generic endpoints
// Every event type is individually subscribable per webhook.

import { createHmac } from 'node:crypto'

import { query, queryOne } from '../db.ts'
import { enqueue } from './queue.ts'

import type { Job } from './queue.ts'

// ---- event catalog (docs/api.md lists these too) ----
export const WEBHOOK_EVENTS = [
  'user.registered',        // new account
  'user.moderated',         // suspend/ban/restore
  'comment.created',        // new top-level comment or reply
  'report.created',         // content reported
  'report.resolved',        // moderation decision
  'extension.submitted',    // new version entered review
  'extension.reviewed',     // review outcome (approved/flagged/rejected)
  'extension.installed',    // install/uninstall
  'w2g.room_created',       // watch-together room opened
  'stats.daily',            // daily rollup digest
  'stats.trending',         // trending refresh (top titles)
  'catalogue.imported',     // importer finished
  'job.failed',             // background job exhausted retries
  'config.changed',         // a feature flag or site setting was changed
  'webhook.test'            // manual test fire from the admin UI
] as const

export type WebhookEvent = typeof WEBHOOK_EVENTS[number]

/** Fan out an event to every enabled webhook subscribed to it. */
export async function emitEvent (event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  const hooks = await query<{ id: string }>(
    'SELECT id FROM webhooks WHERE enabled AND $1 = ANY(events)',
    [event]
  )
  for (const hook of hooks) {
    await enqueue('webhook', { webhookId: hook.id, event, data, at: new Date().toISOString() })
  }
}

// ---- Discord embed rendering ----

const COLORS = {
  info: 0x5865f2,     // blurple
  success: 0x57f287,  // green
  warn: 0xfee75c,     // yellow
  danger: 0xed4245,   // red
  rose: 0xe91e63      // yume accent
}

interface Embed {
  title: string
  description?: string
  color: number
  fields?: Array<{ name: string, value: string, inline?: boolean }>
}

const field = (name: string, value: unknown, inline = true) =>
  ({ name, value: String(value ?? '—').slice(0, 1024), inline })

function renderEmbed (event: WebhookEvent, d: Record<string, unknown>): Embed {
  switch (event) {
    case 'user.registered':
      return { title: '👤 New user registered', color: COLORS.success, fields: [field('Username', d.username)] }
    case 'user.moderated':
      return {
        title: `🔨 User ${d.action}`,
        color: d.action === 'restore' ? COLORS.success : COLORS.danger,
        fields: [field('User', d.username), field('Action', d.action), field('Reason', d.reason, false)]
      }
    case 'comment.created':
      return {
        title: '💬 New comment',
        description: String(d.preview ?? '').slice(0, 300),
        color: COLORS.info,
        fields: [field('By', d.author), field('On', d.subject)]
      }
    case 'report.created':
      return {
        title: '🚩 Content reported',
        color: COLORS.warn,
        fields: [field('Type', d.subjectType), field('Reason', d.reason), field('Reporter', d.reporter), field('Excerpt', d.excerpt, false)]
      }
    case 'report.resolved':
      return {
        title: '✅ Report resolved',
        color: COLORS.success,
        fields: [field('Action', d.action), field('Moderator', d.moderator), field('Reason', d.reason, false)]
      }
    case 'extension.submitted':
      return {
        title: '📦 Extension version submitted',
        color: COLORS.info,
        fields: [field('Extension', d.slug), field('Version', d.version), field('Developer', d.developer)]
      }
    case 'extension.reviewed':
      return {
        title: `📦 Extension review: ${d.decision}`,
        color: d.decision === 'approved' ? COLORS.success : d.decision === 'rejected' ? COLORS.danger : COLORS.warn,
        fields: [field('Extension', d.slug), field('Version', d.version), field('Notes', d.notes, false)]
      }
    case 'extension.installed':
      return {
        title: d.action === 'uninstall' ? '📦 Extension uninstalled' : '📦 Extension installed',
        color: COLORS.info,
        fields: [field('Extension', d.slug), field('Installs now', d.installCount)]
      }
    case 'w2g.room_created':
      return { title: '🎬 Watch Together room opened', color: COLORS.rose, fields: [field('Code', d.code), field('Host', d.host)] }
    case 'stats.daily':
      return {
        title: `📊 Daily stats — ${d.day}`,
        color: COLORS.rose,
        fields: [
          field('Users', d.users), field('New (7d)', d.newUsers7d), field('Active (24h)', d.active1d),
          field('Watched', `${d.minutesWatched} min`), field('Episodes finished', d.completions), field('Comments', d.comments)
        ]
      }
    case 'stats.trending':
      return {
        title: '🔥 Trending refreshed',
        description: (d.top as string[] ?? []).map((t, i) => `**${i + 1}.** ${t}`).join('\n') || 'No trending activity yet.',
        color: COLORS.rose
      }
    case 'catalogue.imported':
      return {
        title: '📚 Catalogue import finished',
        color: COLORS.success,
        fields: [field('Inserted', d.inserted), field('Updated', d.updated), field('Skipped', d.skipped), field('Relations', d.relations)]
      }
    case 'webhook.test':
      return { title: '🔔 Webhook test', description: 'Your Yume webhook is configured correctly!', color: COLORS.success, fields: [field('Webhook', d.name)] }
    case 'job.failed':
      return {
        title: '⚠️ Background job failed permanently',
        color: COLORS.danger,
        fields: [field('Queue', d.queue), field('Job', d.jobId), field('Error', d.error, false)]
      }
    case 'config.changed':
      return {
        title: '⚙️ Site configuration changed',
        color: COLORS.rose,
        fields: [field('Setting', d.key), field('New value', d.value), field('Changed by', d.by)]
      }
  }
}

// ---- delivery ----

export async function deliver (webhookId: string, event: WebhookEvent, data: Record<string, unknown>, at: string): Promise<void> {
  const hook = await queryOne<{ id: string, url: string, format: string, secret: string | null, enabled: boolean, failure_count: number }>(
    'SELECT id, url, format, secret, enabled, failure_count FROM webhooks WHERE id = $1',
    [webhookId]
  )
  if (!hook?.enabled) return

  let body: string
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (hook.format === 'discord') {
    body = JSON.stringify({
      username: 'Yume',
      embeds: [{ ...renderEmbed(event, data), timestamp: at, footer: { text: event } }]
    })
  } else {
    body = JSON.stringify({ event, data, at })
    if (hook.secret) {
      headers['X-Yume-Signature'] = 'sha256=' + createHmac('sha256', hook.secret).update(body).digest('hex')
    }
    headers['X-Yume-Event'] = event
  }

  const started = Date.now()
  let statusCode: number | null = null
  let error: string | null = null

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(hook.url, { method: 'POST', headers, body, signal: controller.signal })
    clearTimeout(timer)
    statusCode = res.status
    if (!res.ok) error = `HTTP ${res.status}`
  } catch (err) {
    error = (err as Error).message.slice(0, 500)
  }

  await query(
    `INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hook.id, event, { event, data, at }, statusCode, error, Date.now() - started]
  )

  if (error) {
    // consecutive failures auto-disable at 20 so dead endpoints stop burning retries
    await query(
      `UPDATE webhooks SET failure_count = failure_count + 1, last_error = $2,
         enabled = (failure_count + 1) < 20
       WHERE id = $1`,
      [hook.id, error]
    )
    throw new Error(`webhook ${hook.id}: ${error}`)
  }

  await query('UPDATE webhooks SET failure_count = 0, last_error = NULL, last_success_at = now() WHERE id = $1', [hook.id])
}

export async function handleWebhookJob (job: Job): Promise<void> {
  const { webhookId, event, data, at } = job.payload as { webhookId: string, event: WebhookEvent, data: Record<string, unknown>, at: string }
  await deliver(webhookId, event, data ?? {}, at ?? new Date().toISOString())
}
