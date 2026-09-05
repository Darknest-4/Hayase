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

import { query } from '../db.ts'

export type AuditAction =
  | 'user.status'
  | 'role.permission.grant' | 'role.permission.revoke'
  | 'anime.create' | 'anime.edit' | 'anime.delete' | 'anime.merge' | 'anime.unlock'
  | 'episode.create' | 'episode.edit' | 'episode.delete'
  // Publishing is its own act, separate from editing an episode's text: it is
  // the one that decides whether viewers can reach the thing at all.
  | 'episode.visibility' | 'anime.visibility'
  // Catalogue text a viewer reads, written by hand. Recorded because
  // "who changed this description and to what" is asked afterwards.
  | 'anime.translation.create' | 'anime.translation.update' | 'anime.translation.delete'
  | 'config.flag' | 'config.setting'
  | 'webhook.create' | 'webhook.update' | 'webhook.delete'
  | 'extension.review'
  // Adopting somebody else's code into this store. Worth recording on its own:
  // the operator who imported a repository is the person answerable for what
  // came in with it.
  | 'extension.imported'
  // Moderation performed through Discord slash commands. In this trail rather
  // than a second one, because a moderation system with two audit trails has
  // none — "who banned this account" must have one answer.
  | 'discord.warn' | 'discord.timeout' | 'discord.kick' | 'discord.ban'
  | 'discord.purge' | 'discord.slowmode'
  // Server provisioning: each role, channel and webhook the blueprint creates.
  | 'discord.role.create' | 'discord.role.update' | 'discord.category.create'
  | 'discord.channel.create' | 'discord.channel.update' | 'discord.webhook.create'

export type SubjectType = 'user' | 'role' | 'anime' | 'episode' | 'config' | 'webhook' | 'extension' | 'discord'

/**
 * Record one administrative action.
 *
 * `before`/`after` carry the values that changed, not whole rows — an audit
 * trail should say what moved, and copying entire records into it is how audit
 * tables end up holding a second, stale copy of the database.
 */
export async function audit (
  // Null for an actor with no Yume account — a system job, or the Discord bot
  // acting on a Discord user who has never linked one. `actor_id` is a uuid
  // referencing `users`, so a Discord id cannot go in it; it travels in the
  // payload instead, labelled.
  actorId: string | null,
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

export async function auditTrail (
  filter: { subjectType?: string, subjectId?: string, actorId?: string, limit?: number } = {}
): Promise<unknown[]> {
  const where: string[] = []
  const params: unknown[] = []
  const add = (clause: string, value: unknown): void => { params.push(value); where.push(clause.replace('?', `$${params.length}`)) }
  if (filter.subjectType) add('a.subject_type = ?', filter.subjectType)
  if (filter.subjectId) add('a.subject_id = ?', filter.subjectId)
  if (filter.actorId) add('a.actor_id = ?', filter.actorId)
  params.push(Math.min(200, filter.limit ?? 50))

  return query(
    `SELECT a.id, a.action, a.subject_type, a.subject_id, a.before, a.after, a.created_at,
            u.username AS actor
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.created_at DESC
      LIMIT $${params.length}`,
    params
  )
}
