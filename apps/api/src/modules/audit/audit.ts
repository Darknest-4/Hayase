// Audit logging.
//
// audit_logs existed from 0001 but had exactly one writer: the user-status
// route. Role grants, catalogue edits, merges, deletions and configuration
// changes all went unrecorded — so on a system with 387 permissions there was
// no way to answer "who gave this account admin, and when".
//
// Best effort at the call site, like every other telemetry path here: an audit
// write failing must not fail the action the operator just performed. It is
// awaited rather than fired and forgotten, so the row lands before the
// response, but a failure only logs.

import { query } from '../../infrastructure/database/index.ts'

export type AuditAction =
  | 'user.status'
  // Who may do what. A role grant hands somebody every permission that role
  // carries, which makes it the most consequential thing that can be done to
  // an account short of banning it — and until now the only way to do it was
  // an INSERT by hand, which left no record at all.
  | 'user.role.grant' | 'user.role.revoke'
  // Ending every session an account has. Recorded because it is indeed
  // visible to the person it happens to, and "who signed me out" is a fair
  // question.
  | 'user.sessions.revoke'
  | 'role.permission.grant' | 'role.permission.revoke'
  | 'anime.create' | 'anime.edit' | 'anime.delete' | 'anime.merge' | 'anime.unlock'
  | 'episode.create' | 'episode.edit' | 'episode.delete'
  // Where an episode can be played from. Recorded because a source is the one
  // catalogue field that decides whether a viewer sees anything at all, and
  // "who put this link here" is the question when one turns out to be wrong.
  | 'episode.source.add' | 'episode.source.edit' | 'episode.source.remove'
  // Publishing is its own act, separate from editing an episode's text: it is
  // the one that decides whether viewers can reach the thing at all.
  | 'episode.visibility' | 'anime.visibility'
  // Catalogue text a viewer reads, written by hand. Recorded because
  // "who changed this description and to what" is asked afterwards.
  | 'anime.translation.create' | 'anime.translation.update' | 'anime.translation.delete'
  | 'config.flag' | 'config.setting'
  | 'webhook.create' | 'webhook.update' | 'webhook.delete'
  // Starting a catalogue-wide metadata pull. Recorded because it rewrites
  // fields across the whole catalogue and the question afterwards is who
  // asked for it.
  | 'metadata.sync'
  // What the whole site looks like. One row decides the colours every viewer
  // who has not chosen otherwise sees.
  | 'theme.create' | 'theme.update' | 'theme.delete'

export type SubjectType = 'user' | 'role' | 'anime' | 'episode' | 'config' | 'webhook' | 'metadata_run' | 'theme'

/**
 * Record one administrative action.
 *
 * `before`/`after` carry the values that changed, not whole rows — an audit
 * trail should say what moved, and copying entire records into it is how audit
 * tables end up holding a second, stale copy of the database.
 */
export async function audit (
  actorId: string,
  action: AuditAction,
  subjectType: SubjectType,
  subjectId: string | null,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorId, action, subjectType, subjectId, before ?? {}, after ?? {}]
    )
  } catch (err) {
    console.error('audit write failed:', (err as Error).message)
  }
}

export interface AuditFilter {
  subjectType?: string | undefined
  subjectId?: string | undefined
  actorId?: string | undefined
  /** Match on the actor's name instead of their id — what somebody actually knows. */
  actor?: string | undefined
  /** One action, or a prefix with a trailing dot: `anime.` matches every anime action. */
  action?: string | undefined
  /** ISO timestamp; nothing older is returned. */
  since?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}

/**
 * Read the trail.
 *
 * Filtering used to be by subject type alone, which is the least useful of
 * the three things somebody arrives knowing. The question is nearly always
 * one of "what did this person do", "what happened to this thing" or "what
 * happened on the day it broke", and only the second was answerable.
 *
 * The count is of the whole filtered set rather than the page, so the screen
 * can say how much there is instead of stopping at a limit and leaving an
 * operator to wonder whether that was all of it.
 */
export async function auditTrail (
  filter: AuditFilter = {}
): Promise<{ data: unknown[], total: number }> {
  const where: string[] = []
  const params: unknown[] = []
  const add = (clause: string, value: unknown): void => { params.push(value); where.push(clause.replace('?', `$${params.length}`)) }
  if (filter.subjectType) add('a.subject_type = ?', filter.subjectType)
  if (filter.subjectId) add('a.subject_id = ?', filter.subjectId)
  if (filter.actorId) add('a.actor_id = ?', filter.actorId)
  if (filter.actor) add('u.username ILIKE ?', `%${filter.actor}%`)
  // A trailing dot means "this family of actions" — `anime.` is how somebody
  // asks what has been done to the catalogue without listing eight actions.
  if (filter.action) {
    if (filter.action.endsWith('.')) add('a.action LIKE ?', filter.action + '%')
    else add('a.action = ?', filter.action)
  }
  if (filter.since) add('a.created_at >= ?', filter.since)

  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''

  const counted = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ${clause}`,
    params
  )

  params.push(Math.min(200, filter.limit ?? 50), filter.offset ?? 0)
  const data = await query(
    `SELECT a.id, a.action, a.subject_type, a.subject_id, a.before, a.after, a.created_at,
            u.username AS actor, a.actor_type
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
     ${clause}
      ORDER BY a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return { data, total: Number(counted[0]?.n ?? 0) }
}
