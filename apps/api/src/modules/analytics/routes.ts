// /v1/admin/analytics, /errors and /audit — what the platform did, and what
// went wrong while it did it.
//
// Three readers over three different ledgers, grouped because they are the
// same job: an operator working out what happened. None of them writes
// anything except an error group's triage status.
//
// Split out of modules/admin/routes.ts; the URLs are unchanged.

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { overview } from '../system/dashboard.ts'
import { auditTrail } from '../audit/audit.ts'
import { errorGroups, errorOccurrences, setErrorGroupStatus } from '../../errors/reporting.ts'

import type { AuditFilter } from '../audit/audit.ts'
import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  /**
   * The counts the section rail puts on its own items.
   *
   * Its own route because the rail is drawn before any section loads, and
   * because each figure is gated by the permission that owns it: an account
   * that may moderate but not read analytics gets the report count and a null
   * for the errors. `authenticate` rather than a permission, so the route
   * answers for anyone already in the panel and decides figure by figure.
   */
  fastify.get('/badges', { onRequest: fastify.authenticate }, async request => {
    const held = await query<{ slug: string }>(
      `SELECT DISTINCT p.slug
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1`,
      [request.user.sub]
    )
    const slugs = new Set(held.map(row => row.slug))

    const [errors, reports] = await Promise.all([
      slugs.has('admin.analytics.view')
        ? queryOne<{ n: string }>("SELECT count(*) AS n FROM error_groups WHERE status = 'open'")
        : null,
      slugs.has('community.moderate')
        ? queryOne<{ n: string }>("SELECT count(*) AS n FROM reports WHERE status IN ('open', 'reviewing')")
        : null
    ])
    return {
      errors: errors ? Number(errors.n) : null,
      reports: reports ? Number(reports.n) : null
    }
  })

  /**
   * The overview screen, in one round trip.
   *
   * `?days` sets the comparison window for every figure that has one, so the
   * captions on the cards are all true of the same period — a dashboard whose
   * cards compare against different spans is a set of numbers that cannot be
   * read together.
   */
  fastify.get('/analytics/dashboard', {
    onRequest: fastify.requirePermission('admin.analytics.view', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } }
      }
    }
  }, async request => {
    const { days } = request.query as { days?: number }
    return await overview(days ?? 7)
  })

  // The older, narrower shape. Kept because it is the documented one and
  // something outside this repository may read it.
  fastify.get('/analytics/overview', {
    onRequest: fastify.requirePermission('admin.analytics.view', { hide: true })
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
    onRequest: fastify.requirePermission('admin.analytics.view', { hide: true }),
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

  /**
   * Find the failure a user is quoting.
   *
   * A 500 tells the caller "Request <id> failed — quote this id when reporting
   * it". This is where they quote it to. Without this route that sentence sent
   * people to an operator who had no way to look the number up: it reached the
   * response body and the log line, and the stored occurrence — the only thing
   * searchable — did not carry it.
   *
   * Returns the occurrence *and* its group, because the two answer different
   * halves: the occurrence is what happened to that person at that moment, the
   * group is whether it is happening to everybody.
   */
  fastify.get('/errors/by-request/:requestId', {
    onRequest: fastify.requirePermission('admin.analytics.view', { hide: true }),
    schema: {
      params: {
        type: 'object',
        required: ['requestId'],
        // Fastify's ids are uuids by default, but a deployment behind a proxy
        // may pass its own through, so this is a loose shape rather than a
        // uuid format — an id that cannot match simply finds nothing.
        properties: { requestId: { type: 'string', minLength: 4, maxLength: 200 } }
      }
    }
  }, async (request, reply) => {
    const { requestId } = request.params as { requestId: string }

    const occurrence = await queryOne(
      `SELECT e.id, e.source, e.message, e.stack, e.context, e.created_at, e.group_id
         FROM error_logs e
        WHERE e.context->>'requestId' = $1
        ORDER BY e.created_at DESC
        LIMIT 1`,
      [requestId]
    )
    if (!occurrence) {
      return reply.code(404).send({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No recorded failure carries that request id'
      })
    }

    const group = await queryOne(
      `SELECT id, fingerprint, title, status, event_count, first_seen, last_seen
         FROM error_groups WHERE id = $1`,
      [(occurrence as { group_id: string }).group_id]
    )
    return { occurrence, group }
  })

  fastify.get('/errors/:id', {
    onRequest: fastify.requirePermission('admin.analytics.view', { hide: true }),
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
    onRequest: fastify.requirePermission('admin.analytics.view', { hide: true }),
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
    onRequest: fastify.requirePermission('admin.users.manage', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        properties: {
          subjectType: { enum: ['user', 'role', 'anime', 'episode', 'config', 'webhook', 'theme', 'metadata_run'] },
          subjectId: { type: 'string', format: 'uuid' },
          actorId: { type: 'string', format: 'uuid' },
          actor: { type: 'string', maxLength: 60 },
          action: { type: 'string', maxLength: 60, pattern: '^[a-z0-9._]+$' },
          since: { type: 'string', format: 'date-time' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 }
        }
      }
    }
  }, async request => {
    const q = request.query as Record<string, string | number | undefined>
    // exactOptionalPropertyTypes: only pass the filters that were supplied,
    // so an absent one stays absent rather than becoming `undefined`.
    const filter: AuditFilter = {}
    for (const key of ['subjectType', 'subjectId', 'actorId', 'actor', 'action', 'since'] as const) {
      if (q[key]) filter[key] = String(q[key])
    }
    if (q.limit) filter.limit = Number(q.limit)
    if (q.offset) filter.offset = Number(q.offset)

    // The distinct actions present, so the screen's action filter offers what
    // this instance has actually recorded instead of a hardcoded list that
    // drifts from the AuditAction union every time somebody adds one.
    const [trail, actions] = await Promise.all([
      auditTrail(filter),
      query<{ action: string, n: number }>(
        `SELECT action, count(*)::int AS n FROM audit_logs
          WHERE created_at > now() - interval '90 days'
          GROUP BY action ORDER BY action`)
    ])

    return { data: trail.data, total: trail.total, actions }
  })
}

export default routes
