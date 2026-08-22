// Error tracking.
//
// error_logs and error_groups were created in 0007 and never written to, while
// the admin analytics dashboard read error_groups — so the panel showed an
// empty list whether the service was healthy or on fire. In practice that
// meant a 500 was only ever noticed because a user complained.
//
// Errors are grouped by fingerprint so a thousand occurrences of one bug are
// one row to act on rather than a thousand rows to scroll past.

import { createHash } from 'node:crypto'

import { query, queryOne } from '../db.ts'

export type ErrorSource = 'api' | 'worker' | 'web' | 'desktop' | 'mobile' | 'extension'

export interface ErrorContext {
  route?: string | undefined
  method?: string | undefined
  statusCode?: number | undefined
  queue?: string | undefined
  jobId?: string | undefined
  userId?: string | undefined
}

/**
 * Values that vary between occurrences of the same bug. Stripping them is what
 * makes grouping work: without it every uuid, id and quoted value produces its
 * own "unique" error.
 */
function normaliseMessage (message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{4,}\b/g, '<n>')
    // Both quote styles collapse to the SAME placeholder — otherwise the same
    // fault reported with '…' and "…" would land in two separate groups.
    .replace(/"[^"]*"|'[^']*'/g, '<str>')
    .slice(0, 300)
}

/**
 * Identity of a bug, not of an occurrence: source, normalised message, and the
 * first application stack frame. Route is deliberately excluded so the same
 * fault reached through two routes stays one group.
 */
export function fingerprint (source: ErrorSource, message: string, stack?: string): string {
  const frame = stack
    ?.split('\n')
    .find(line => line.includes('/src/') && !line.includes('node_modules'))
    ?.trim()
    .replace(/:\d+:\d+/g, '') ?? ''
  return createHash('sha256').update(`${source}\n${normaliseMessage(message)}\n${frame}`).digest('hex').slice(0, 32)
}

/**
 * Record one error occurrence.
 *
 * Best effort by design: this is called from an error handler, and a failure
 * to record must never replace the original error with a logging error. The
 * caller always still gets its response.
 */
export async function recordError (
  source: ErrorSource,
  error: Error,
  context: ErrorContext = {}
): Promise<string | undefined> {
  try {
    const message = String(error.message ?? error).slice(0, 2000)
    const stack = error.stack?.slice(0, 8000)
    const print = fingerprint(source, message, stack)
    const title = `${source}: ${normaliseMessage(message)}`.slice(0, 300)

    // A previously resolved group that reappears is reopened — a bug that
    // comes back is news, and silently keeping it closed would hide that.
    const group = await queryOne<{ id: string }>(
      `INSERT INTO error_groups (fingerprint, title, event_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (fingerprint) DO UPDATE
         SET event_count = error_groups.event_count + 1,
             last_seen = now(),
             status = CASE WHEN error_groups.status = 'resolved' THEN 'open' ELSE error_groups.status END
       RETURNING id`,
      [print, title]
    )
    if (!group) return undefined

    await query(
      'INSERT INTO error_logs (group_id, source, message, stack, context) VALUES ($1, $2, $3, $4, $5)',
      [group.id, source, message, stack ?? null, context]
    )
    return group.id
  } catch (err) {
    // Never let telemetry mask the error it was describing — but never fail
    // silently either. A swallowed exception here means the error view is
    // empty for a reason nobody can see, which is worse than no error view.
    console.error('error tracking failed:', (err as Error).message)
    return undefined
  }
}

export interface ErrorGroupRow {
  id: string
  fingerprint: string
  title: string
  status: string
  event_count: string
  first_seen: string
  last_seen: string
}

export async function errorGroups (status = 'open', limit = 50): Promise<ErrorGroupRow[]> {
  return query<ErrorGroupRow>(
    `SELECT id, fingerprint, title, status, event_count, first_seen, last_seen
       FROM error_groups
      WHERE ($1 = 'all' OR status = $1)
      ORDER BY last_seen DESC
      LIMIT $2`,
    [status, Math.min(200, limit)]
  )
}

export async function errorOccurrences (groupId: string, limit = 20): Promise<unknown[]> {
  return query(
    `SELECT id, source, message, stack, context, created_at
       FROM error_logs WHERE group_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [groupId, Math.min(100, limit)]
  )
}

export async function setErrorGroupStatus (groupId: string, status: 'open' | 'resolved' | 'ignored'): Promise<boolean> {
  const rows = await query('UPDATE error_groups SET status = $2 WHERE id = $1 RETURNING id', [groupId, status])
  return rows.length > 0
}
