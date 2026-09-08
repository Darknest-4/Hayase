// /v1/admin/reports — the moderation queue.
//
// The other half of this module is modules/moderation/routes.ts, which is
// where a report is *made*. This is where one is answered: listing what is
// waiting, and resolving it — optionally hiding the subject in the same
// transaction that records the decision.
//
// Split out of modules/admin/routes.ts; the URLs are unchanged.

import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'
import { emitEvent } from '../webhooks/delivery.ts'

import type { FastifyPluginAsync } from 'fastify'

// which table's hidden_at a report subject maps to
const HIDEABLE: Record<string, string> = {
  comment: 'comments', post: 'posts', review: 'reviews'
}

const routes: FastifyPluginAsync = async fastify => {
  fastify.get('/reports', {
    onRequest: fastify.requirePermission('community.moderate', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { enum: ['open', 'reviewing', 'resolved', 'dismissed', 'all'], default: 'open' },
          subjectType: { type: 'string', maxLength: 40 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 }
        }
      }
    }
  }, async request => {
    const { status, subjectType, limit, offset } =
      request.query as { status?: string, subjectType?: string, limit?: number, offset?: number }

    const where: string[] = []
    const params: unknown[] = []
    // 'all' is a real choice: a queue you can only see the open end of hides
    // what was decided and by whom, which is exactly what somebody checks when
    // a decision is questioned.
    if (status && status !== 'all') { params.push(status); where.push(`r.status = $${params.length}`) }
    if (subjectType) { params.push(subjectType); where.push(`r.subject_type = $${params.length}`) }
    const filter = where.length ? 'WHERE ' + where.join(' AND ') : ''

    // Counted per status over the whole table, not the filtered page: the
    // number an operator wants is "how much is waiting", and it must not
    // change when they click through to the resolved ones.
    const totals = await queryOne<Record<string, number>>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'reviewing')::int AS reviewing,
              count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
              count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
         FROM reports`
    )

    params.push(limit ?? 50, offset ?? 0)
    const data = await query(
      `SELECT r.id, r.subject_type, r.subject_id, r.reason, r.details, r.status,
              r.created_at, r.resolved_at,
              u.username AS reporter,
              res.username AS resolver,
              CASE WHEN r.subject_type = 'comment' THEN (SELECT left(c.body, 200) FROM comments c WHERE c.id = r.subject_id)
                   WHEN r.subject_type = 'review'  THEN (SELECT left(v.body, 200) FROM reviews v WHERE v.id = r.subject_id)
                   WHEN r.subject_type = 'post'    THEN (SELECT left(p.body, 200) FROM posts p WHERE p.id = r.subject_id)
                   WHEN r.subject_type = 'user'    THEN (SELECT uu.username FROM users uu WHERE uu.id = r.subject_id)
              END AS excerpt,
              -- Context that decides most of these without opening anything
              -- else. A first report from somebody who has never filed one
              -- reads very differently from the ninth from a reporter whose
              -- last eight were dismissed, and the same is true of a subject
              -- that several different people have reported.
              (SELECT count(*)::int FROM reports r2 WHERE r2.reporter_id = r.reporter_id) AS reporter_total,
              (SELECT count(*)::int FROM reports r2
                WHERE r2.reporter_id = r.reporter_id AND r2.status = 'dismissed') AS reporter_dismissed,
              (SELECT count(*)::int FROM reports r3
                WHERE r3.subject_type = r.subject_type AND r3.subject_id = r.subject_id) AS subject_reports
       FROM reports r
       JOIN users u ON u.id = r.reporter_id
       LEFT JOIN users res ON res.id = r.resolved_by
       ${filter}
       ORDER BY r.created_at
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    return { data, totals }
  })

  fastify.post('/reports/:id/resolve', {
    onRequest: fastify.requirePermission('community.moderate', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['action', 'reason'],
        properties: {
          action: { enum: ['hide', 'restore', 'dismiss'] },
          reason: { type: 'string', minLength: 3, maxLength: 500 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { action, reason } = request.body as { action: string, reason: string }

    const report = await queryOne<{ subject_type: string, subject_id: string }>(
      `SELECT subject_type, subject_id FROM reports WHERE id = $1 AND status IN ('open', 'reviewing')`,
      [id]
    )
    if (!report) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const table = HIDEABLE[report.subject_type]
    if (action !== 'dismiss' && !table) {
      return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: `Cannot ${action} a ${report.subject_type}; use user status for accounts` })
    }

    await transaction(async client => {
      if (action === 'hide') {
        await client.query(`UPDATE ${table} SET hidden_at = now() WHERE id = $1`, [report.subject_id])
      } else if (action === 'restore') {
        await client.query(`UPDATE ${table} SET hidden_at = NULL WHERE id = $1`, [report.subject_id])
      }
      await client.query(
        `UPDATE reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`,
        [id, action === 'dismiss' ? 'dismissed' : 'resolved', request.user.sub]
      )
      await client.query(
        `INSERT INTO moderation_actions (moderator_id, action, subject_type, subject_id, report_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [request.user.sub, action === 'dismiss' ? 'dismiss_report' : action, report.subject_type, report.subject_id, id, reason]
      )
    })
    await emitEvent('report.resolved', { action, moderator: request.user.username, reason })
    return { id, action }
  })
}

export default routes
