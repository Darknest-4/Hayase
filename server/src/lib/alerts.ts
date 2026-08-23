// Alerting: turns per-cycle readings into sustained alerts.
//
// The point of this module is NOT to react to every bad reading — a single
// spike is normal on a busy VPS. A condition must hold for several consecutive
// collection cycles before it fires (debounce), a firing alert re-notifies at
// most once per cooldown window, and it must be healthy for a couple of cycles
// before it resolves (so a flapping service does not spam).
//
// The decision logic (`decide`) is a pure function of the reading, the stored
// row and the clock, which keeps the state machine unit-testable; `evaluate`
// applies those decisions to the database and emits webhooks.

import { query } from '../db.ts'
import { enqueue } from './queue.ts'
import { emitEvent } from './webhooks.ts'

export type Severity = 'warning' | 'critical'

/** One subject's health this cycle. `severity: null` means healthy. */
export interface Reading {
  subject: string                 // 'cpu.usage_pct' or 'service:postgres'
  kind: 'metric' | 'service'
  severity: Severity | null
  value?: number | null
  threshold?: number | null
  detail?: string | null
}

export interface AlertRow {
  id: string
  subject: string
  status: 'pending' | 'firing' | 'resolved'
  severity: Severity
  streak: number
  healthy_streak: number
  started_at: string
  notified_at: string | null
}

export interface AlertOptions {
  /** Consecutive unhealthy cycles before an alert fires. */
  debounceCycles: number
  /** Consecutive healthy cycles before a firing alert resolves. */
  recoveryCycles: number
  /** Minimum gap between notifications for the same alert. */
  cooldownMs: number
}

/** Module-local: the fallback the exported entry points apply. */
const DEFAULT_OPTIONS: AlertOptions = {
  // three cycles at the default 60s cadence = a problem must persist ~3 minutes
  debounceCycles: Number(process.env.ALERT_DEBOUNCE_CYCLES ?? 3),
  recoveryCycles: Number(process.env.ALERT_RECOVERY_CYCLES ?? 2),
  cooldownMs: Number(process.env.ALERT_COOLDOWN_MS ?? 30 * 60_000)
}

export type Decision =
  | { action: 'ignore' }                       // healthy, nothing open
  | { action: 'open' }                         // first unhealthy cycle → pending
  | { action: 'accumulate' }                   // still unhealthy, not yet at the threshold
  | { action: 'fire' }                         // debounce satisfied → notify
  | { action: 'renotify' }                     // still firing, cooldown elapsed (or it got worse)
  | { action: 'recovering' }                   // healthy again but not for long enough yet
  | { action: 'resolve', notify: boolean }     // healthy long enough → close

/**
 * Decide what to do with one subject this cycle. Pure: no I/O, no clock reads.
 */
export function decide (reading: Reading, row: AlertRow | undefined, options: AlertOptions, now: number): Decision {
  // ---- healthy ----
  if (reading.severity === null) {
    if (!row || row.status === 'resolved') return { action: 'ignore' }
    const healthyStreak = row.healthy_streak + 1
    if (healthyStreak < options.recoveryCycles) return { action: 'recovering' }
    // only announce recovery for alerts that actually fired; a pending alert
    // that never fired resolves silently
    return { action: 'resolve', notify: row.status === 'firing' }
  }

  // ---- unhealthy ----
  if (!row || row.status === 'resolved') return { action: 'open' }

  const streak = row.streak + 1
  if (row.status === 'pending') {
    return streak >= options.debounceCycles ? { action: 'fire' } : { action: 'accumulate' }
  }

  // already firing: re-notify when it escalates, or once the cooldown elapses
  const escalated = row.severity === 'warning' && reading.severity === 'critical'
  const cooledDown = !row.notified_at || now - new Date(row.notified_at).getTime() >= options.cooldownMs
  return escalated || cooledDown ? { action: 'renotify' } : { action: 'accumulate' }
}

/** Human-readable duration for notification payloads. */
export function humanDuration (fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

const openAlerts = async (): Promise<Map<string, AlertRow>> => {
  const rows = await query<AlertRow>(
    `SELECT id, subject, status, severity, streak, healthy_streak, started_at, notified_at
     FROM monitor_alerts WHERE status <> 'resolved'`
  )
  return new Map(rows.map(row => [row.subject, row]))
}

/**
 * Apply one cycle of readings: update alert state and emit notifications.
 * Returns what changed, which the worker logs and the tests assert on.
 */
/**
 * In-app fallback for a firing alert.
 *
 * Alerts only ever left the system through a webhook, so an install with none
 * configured — or one whose webhook auto-disabled after 20 consecutive
 * failures — lost critical alerts silently. This writes to the inbox of
 * everyone who can see metrics, which needs no configuration to work.
 *
 * Best effort: an alert that cannot be delivered must never break the
 * monitoring cycle that produced it.
 */
async function notifyOperators (reading: Reading): Promise<void> {
  const operators = await query<{ user_id: string }>(
    `SELECT DISTINCT ur.user_id
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       JOIN users u ON u.id = ur.user_id
      WHERE p.slug = 'system.metrics.view' AND u.status = 'active' AND u.deleted_at IS NULL`
  )
  for (const operator of operators) {
    await enqueue('notify', {
      userId: operator.user_id,
      type: 'monitor.alert',
      data: { subject: reading.subject, severity: reading.severity ?? 'unknown', value: reading.value ?? reading.detail ?? null },
      // one inbox entry per operator per subject, not one per collection cycle
      dedupe: `alert:${operator.user_id}:${reading.subject}`
    })
  }
}

export async function evaluate (
  readings: Reading[],
  options: AlertOptions = DEFAULT_OPTIONS,
  now = Date.now()
): Promise<{ fired: string[], resolved: string[], pending: string[] }> {
  const open = await openAlerts()
  const fired: string[] = []
  const resolved: string[] = []
  const pending: string[] = []

  for (const reading of readings) {
    const row = open.get(reading.subject)
    const decision = decide(reading, row, options, now)

    switch (decision.action) {
      case 'ignore':
        break

      case 'open':
        await query(
          `INSERT INTO monitor_alerts (subject, kind, severity, status, value, threshold, detail)
           VALUES ($1, $2, $3, 'pending', $4, $5, $6)
           ON CONFLICT (subject) WHERE status <> 'resolved' DO NOTHING`,
          [reading.subject, reading.kind, reading.severity, reading.value ?? null, reading.threshold ?? null, reading.detail ?? null]
        )
        pending.push(reading.subject)
        break

      case 'accumulate':
        await query(
          `UPDATE monitor_alerts
           SET streak = streak + 1, healthy_streak = 0, severity = $2,
               value = $3, threshold = $4, detail = $5, last_seen_at = now()
           WHERE id = $1`,
          [row!.id, reading.severity, reading.value ?? null, reading.threshold ?? null, reading.detail ?? null]
        )
        pending.push(reading.subject)
        break

      case 'fire':
      case 'renotify': {
        await query(
          `UPDATE monitor_alerts
           SET status = 'firing', streak = streak + 1, healthy_streak = 0, severity = $2,
               value = $3, threshold = $4, detail = $5, last_seen_at = now(), notified_at = now()
           WHERE id = $1`,
          [row!.id, reading.severity, reading.value ?? null, reading.threshold ?? null, reading.detail ?? null]
        )
        void emitEvent('monitor.alert', {
          severity: reading.severity,
          subject: reading.subject,
          value: reading.value ?? reading.detail ?? '—',
          threshold: reading.threshold ?? '—',
          duration: humanDuration(row!.started_at, now)
        }).catch(() => {})
        void notifyOperators(reading).catch(() => {})
        fired.push(reading.subject)
        break
      }

      case 'recovering':
        await query('UPDATE monitor_alerts SET healthy_streak = healthy_streak + 1, last_seen_at = now() WHERE id = $1', [row!.id])
        break

      case 'resolve':
        await query(
          `UPDATE monitor_alerts SET status = 'resolved', resolved_at = now(), healthy_streak = healthy_streak + 1 WHERE id = $1`,
          [row!.id]
        )
        if (decision.notify) {
          void emitEvent('monitor.recovered', {
            subject: reading.subject,
            value: reading.value ?? 'healthy',
            duration: humanDuration(row!.started_at, now)
          }).catch(() => {})
          resolved.push(reading.subject)
        }
        break
    }
  }

  return { fired, resolved, pending }
}

/** Currently firing alerts, newest first — for the dashboard. */
export const activeAlerts = () =>
  query(`SELECT id, subject, kind, severity, value, threshold, detail, started_at, notified_at
         FROM monitor_alerts WHERE status = 'firing' ORDER BY severity DESC, started_at`)

/** Recent alert history including resolved ones. */
export const alertHistory = (limit = 50) =>
  query(`SELECT id, subject, kind, severity, status, value, threshold, detail, started_at, resolved_at
         FROM monitor_alerts ORDER BY started_at DESC LIMIT $1`, [limit])

/** Housekeeping: alert history is small, but not unbounded. */
export const pruneResolvedAlerts = async (days = 90): Promise<void> => {
  await query(`DELETE FROM monitor_alerts WHERE status = 'resolved' AND resolved_at < now() - make_interval(days => $1)`, [days])
}
