// /v1/admin — user management, moderation queue and platform analytics.
// Every route is permission-gated and every mutation is written to
// moderation_actions / audit_logs.

import { query, queryOne, transaction } from '../db.ts'
import { auditTrail } from '../lib/audit.ts'
import { errorGroups, errorOccurrences, setErrorGroupStatus } from '../lib/errors.ts'
import { recomputeRatingForReview } from '../lib/extension-rating.ts'
import { emitEvent } from '../lib/webhooks.ts'
import { invalidatePermissions } from '../plugins/auth.ts'

import type { FastifyPluginAsync } from 'fastify'

// which table's hidden_at a report subject maps to
const HIDEABLE: Record<string, string> = {
  comment: 'comments', post: 'posts', review: 'reviews', extension_review: 'extension_reviews'
}

const routes: FastifyPluginAsync = async fastify => {
  // ---------- users ----------

  fastify.get('/users', {
    preHandler: fastify.requirePermission('admin.users.manage', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 100 },
          status: { enum: ['active', 'suspended', 'banned', 'deleted'] },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async request => {
    const { query: search, status, limit } = request.query as { query?: string, status?: string, limit?: number }
    const where: string[] = []
    const params: unknown[] = []
    if (search) {
      params.push(`%${search}%`)
      where.push(`(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length})`)
    }
    if (status) {
      params.push(status)
      where.push(`u.status = $${params.length}`)
    }
    params.push(limit ?? 50)

    const data = await query(
      `SELECT u.id, u.username, u.email, u.status, u.created_at, u.last_login_at,
              coalesce(array_agg(r.slug) FILTER (WHERE r.slug IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $${params.length}`,
      params
    )
    return { data }
  })

  fastify.post('/users/:id/status', {
    preHandler: fastify.requirePermission('admin.users.manage', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['status', 'reason'],
        properties: {
          status: { enum: ['active', 'suspended', 'banned'] },
          reason: { type: 'string', minLength: 3, maxLength: 500 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { status, reason } = request.body as { status: string, reason: string }

    if (id === request.user.sub) {
      return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'You cannot change your own status' })
    }

    const before = await queryOne<{ status: string }>('SELECT status FROM users WHERE id = $1', [id])
    if (!before) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    await transaction(async client => {
      await client.query('UPDATE users SET status = $2 WHERE id = $1', [id, status])
      if (status !== 'active') {
        // kill all sessions on suspend/ban
        await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
        // Revoking the refresh token alone left the access token valid until
        // it expired, so a banned account kept working for up to its lifetime.
        // Bumping the version invalidates every outstanding one, atomically
        // with the ban itself.
        await client.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [id])
      }
      const action = status === 'active' ? 'restore' : status === 'banned' ? 'ban' : 'suspend'
      await client.query(
        `INSERT INTO moderation_actions (moderator_id, action, subject_type, subject_id, reason) VALUES ($1, $2, 'user', $3, $4)`,
        [request.user.sub, action, id, reason]
      )
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after) VALUES ($1, 'user.status', 'user', $2, $3, $4)`,
        [request.user.sub, id, { status: before.status }, { status }]
      )
    })
    // Drop the cached version/permissions so the change takes effect now
    // rather than at the end of the cache TTL.
    invalidatePermissions(id)

    const actor = await queryOne<{ username: string }>('SELECT username FROM users WHERE id = $1', [id])
    await emitEvent('user.moderated', { username: actor?.username, action: status === 'active' ? 'restore' : status, reason })
    return { id, status }
  })

  // ---------- moderation queue ----------

  fastify.get('/reports', {
    preHandler: fastify.requirePermission('community.moderate', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { enum: ['open', 'reviewing', 'resolved', 'dismissed'], default: 'open' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async request => {
    const { status, limit } = request.query as { status?: string, limit?: number }
    const data = await query(
      `SELECT r.id, r.subject_type, r.subject_id, r.reason, r.details, r.status, r.created_at,
              u.username AS reporter,
              CASE WHEN r.subject_type = 'comment' THEN (SELECT left(c.body, 200) FROM comments c WHERE c.id = r.subject_id)
                   WHEN r.subject_type = 'review'  THEN (SELECT left(v.body, 200) FROM reviews v WHERE v.id = r.subject_id)
                   WHEN r.subject_type = 'post'    THEN (SELECT left(p.body, 200) FROM posts p WHERE p.id = r.subject_id)
                   WHEN r.subject_type = 'user'    THEN (SELECT uu.username FROM users uu WHERE uu.id = r.subject_id)
                   WHEN r.subject_type = 'extension_review'
                     THEN (SELECT left(coalesce(er.body, '(' || er.rating || '/5, no text)'), 200) FROM extension_reviews er WHERE er.id = r.subject_id)
              END AS excerpt
       FROM reports r
       JOIN users u ON u.id = r.reporter_id
       WHERE r.status = $1
       ORDER BY r.created_at
       LIMIT $2`,
      [status ?? 'open', limit ?? 50]
    )
    return { data }
  })

  fastify.post('/reports/:id/resolve', {
    preHandler: fastify.requirePermission('community.moderate', { hide: true }),
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
      // The store's rating is derived and excludes hidden reviews, so hiding
      // one has to move the average too — otherwise moderation removes the
      // text and leaves the score it was brigading with.
      if (report.subject_type === 'extension_review' && action !== 'dismiss') {
        await recomputeRatingForReview(client, report.subject_id)
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

  // ---------- analytics ----------

  fastify.get('/analytics/overview', {
    preHandler: fastify.requirePermission('admin.analytics.view', { hide: true })
  }, async () => {
    const [users, content, watch, top, jobs, errors] = await Promise.all([
      queryOne(`SELECT count(*) AS total,
                       count(*) FILTER (WHERE created_at > now() - interval '7 days') AS new_7d,
                       count(*) FILTER (WHERE last_login_at > now() - interval '1 day') AS active_1d
                FROM users WHERE deleted_at IS NULL`),
      queryOne(`SELECT (SELECT count(*) FROM comments WHERE hidden_at IS NULL) AS comments,
                       (SELECT count(*) FROM reviews WHERE hidden_at IS NULL) AS reviews,
                       (SELECT count(*) FROM anime) AS anime,
                       (SELECT count(*) FROM reports WHERE status = 'open') AS open_reports`),
      queryOne(`SELECT coalesce(sum(minutes_watched), 0) AS minutes_7d,
                       coalesce(sum(unique_viewers), 0) AS viewer_days_7d,
                       coalesce(sum(completions), 0) AS completions_7d
                FROM watch_stats_daily WHERE day > current_date - 7`),
      query(`SELECT canonical_title, trending FROM anime WHERE trending > 0 ORDER BY trending DESC LIMIT 5`),
      queryOne(`SELECT count(*) FILTER (WHERE done_at IS NULL) AS pending,
                       count(*) FILTER (WHERE done_at IS NULL AND attempts >= max_attempts) AS dead,
                       count(*) FILTER (WHERE last_error IS NOT NULL AND created_at > now() - interval '1 day') AS failed_1d
                FROM jobs`),
      query(`SELECT title, event_count, last_seen FROM error_groups WHERE status = 'open' ORDER BY last_seen DESC LIMIT 5`)
    ])
    return { users, content, watch, trending: top, jobs, errorGroups: errors }
  })

  // ---------- error triage ----------
  //
  // The analytics overview already showed group titles and counts. There was
  // no way to open one and read its stack, and no way to mark one resolved —
  // errorGroups(), errorOccurrences() and setErrorGroupStatus() were all
  // written and none of them had a caller.
  //
  // The gap was quietly circular: recordError reopens a group whose status is
  // 'resolved', because a bug that comes back is news, but nothing could ever
  // set a status to 'resolved', so that branch was unreachable.

  fastify.get('/errors', {
    preHandler: fastify.requirePermission('admin.analytics.view', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { enum: ['open', 'resolved', 'ignored', 'all'], default: 'open' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
        }
      }
    }
  }, async request => {
    const { status, limit } = request.query as { status?: string, limit?: number }
    return { data: await errorGroups(status ?? 'open', limit ?? 50) }
  })

  fastify.get('/errors/:id', {
    preHandler: fastify.requirePermission('admin.analytics.view', { hide: true }),
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { limit } = request.query as { limit?: number }

    const group = await queryOne(
      `SELECT id, fingerprint, title, status, event_count, first_seen, last_seen
         FROM error_groups WHERE id = $1`,
      [id]
    )
    if (!group) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    return { group, occurrences: await errorOccurrences(id, limit ?? 20) }
  })

  fastify.patch('/errors/:id', {
    preHandler: fastify.requirePermission('admin.analytics.view', { hide: true }),
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['status'],
        properties: { status: { enum: ['open', 'resolved', 'ignored'] } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { status } = request.body as { status: 'open' | 'resolved' | 'ignored' }

    if (!await setErrorGroupStatus(id, status)) {
      return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }
    return { id, status }
  })

  // ---------- audit trail ----------
  //
  // audit_logs is partitioned by month and actively written; auditTrail() read
  // it and had no caller, and no route exposed it. An audit log nobody can
  // read is storage, not accountability — and it is the first thing anyone
  // asks for after an incident.

  fastify.get('/audit', {
    preHandler: fastify.requirePermission('admin.users.manage', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        properties: {
          subjectType: { enum: ['user', 'role', 'anime', 'episode', 'config', 'webhook', 'extension'] },
          subjectId: { type: 'string', format: 'uuid' },
          actorId: { type: 'string', format: 'uuid' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
        }
      }
    }
  }, async request => {
    const { subjectType, subjectId, actorId, limit } = request.query as {
      subjectType?: string, subjectId?: string, actorId?: string, limit?: number
    }
    // exactOptionalPropertyTypes: only pass the filters that were supplied
    const filter: { subjectType?: string, subjectId?: string, actorId?: string, limit?: number } = {}
    if (subjectType) filter.subjectType = subjectType
    if (subjectId) filter.subjectId = subjectId
    if (actorId) filter.actorId = actorId
    if (limit) filter.limit = limit

    return { data: await auditTrail(filter) }
  })
}

export default routes
