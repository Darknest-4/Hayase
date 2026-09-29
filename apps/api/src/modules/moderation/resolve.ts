// Resolving a report — one implementation, two clients.
//
// The moderation queue in the admin panel and the moderator channel on
// Discord make the same decision, so they share this: the subject is hidden
// or restored in the same transaction that records the decision and the
// moderation action, and the webhook event goes out after it commits.
//
// The claim is part of the transaction. The report is taken only while it is
// still open (`status IN ('open', 'reviewing')` on the UPDATE itself), so two
// moderators deciding the same report at once — one in the panel, one on
// Discord — cannot both succeed: the second finds nothing to claim and is
// told so, instead of silently overwriting the first decision.

import { queryOne, transaction } from '../../infrastructure/database/index.ts'
import { emitEvent } from '../webhooks/delivery.ts'

/** Which table's hidden_at a report subject maps to. */
export const HIDEABLE: Record<string, string> = {
  comment: 'comments', post: 'posts', review: 'reviews'
}

export type ResolveAction = 'hide' | 'restore' | 'dismiss'

export type ResolveOutcome =
  | { ok: true }
  | { ok: false, reason: 'not_found' | 'not_hideable', subjectType?: string }

export async function resolveReport (
  id: string,
  action: ResolveAction,
  reason: string,
  moderator: { id: string, username: string }
): Promise<ResolveOutcome> {
  const report = await queryOne<{ subject_type: string, subject_id: string }>(
    `SELECT subject_type, subject_id FROM reports WHERE id = $1 AND status IN ('open', 'reviewing')`, [id])
  if (!report) return { ok: false, reason: 'not_found' }

  const table = HIDEABLE[report.subject_type]
  if (action !== 'dismiss' && !table) return { ok: false, reason: 'not_hideable', subjectType: report.subject_type }

  const claimed = await transaction(async client => {
    const taken = await client.query(
      `UPDATE reports SET status = $2, resolved_by = $3, resolved_at = now()
        WHERE id = $1 AND status IN ('open', 'reviewing')
        RETURNING 1`,
      [id, action === 'dismiss' ? 'dismissed' : 'resolved', moderator.id])
    if (!taken.rowCount) return false
    if (action === 'hide') {
      await client.query(`UPDATE ${table} SET hidden_at = now() WHERE id = $1`, [report.subject_id])
    } else if (action === 'restore') {
      await client.query(`UPDATE ${table} SET hidden_at = NULL WHERE id = $1`, [report.subject_id])
    }
    await client.query(
      `INSERT INTO moderation_actions (moderator_id, action, subject_type, subject_id, report_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [moderator.id, action === 'dismiss' ? 'dismiss_report' : action, report.subject_type, report.subject_id, id, reason])
    return true
  })
  if (!claimed) return { ok: false, reason: 'not_found' }

  await emitEvent('report.resolved', { action, moderator: moderator.username, reason })
  return { ok: true }
}
