// /v1/admin/users — the account surface of the administration panel.
//
// Split out of one 779-line modules/admin/routes.ts that also held the
// moderation queue, platform analytics, error triage and the audit trail.
// Four unrelated reasons to change one file, and the reason "where is the
// account suspension written" had no answer shorter than a scroll.
//
// The URLs are unchanged: modules/admin/routes.ts still composes this under
// the same /v1/admin prefix, so nothing the client calls moved.

import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'
import { emitEvent } from '../webhooks/delivery.ts'
import { invalidatePermissions } from '../../middleware/auth.ts'

import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  fastify.get('/users', {
    onRequest: fastify.requirePermission('admin.users.manage', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 100 },
          status: { enum: ['active', 'suspended', 'banned', 'deleted'] },
          role: { type: 'string', maxLength: 40 },
          sort: { enum: ['newest', 'oldest', 'active', 'name'], default: 'newest' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 }
        }
      }
    }
  }, async request => {
    const { query: search, status, role, sort, limit, offset } =
      request.query as { query?: string, status?: string, role?: string, sort?: string, limit?: number, offset?: number }
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
    if (role) {
      params.push(role)
      where.push(`EXISTS (SELECT 1 FROM user_roles ur2 JOIN roles r2 ON r2.id = ur2.role_id
                           WHERE ur2.user_id = u.id AND r2.slug = $${params.length})`)
    }
    const filter = where.length ? 'WHERE ' + where.join(' AND ') : ''

    // A fixed list, never the parameter itself — the sort key reaches SQL as
    // an identifier and cannot be parameterised.
    const ORDER: Record<string, string> = {
      newest: 'u.created_at DESC',
      oldest: 'u.created_at ASC',
      active: 'u.last_login_at DESC NULLS LAST',
      name: 'u.username ASC'
    }
    const order = ORDER[sort ?? 'newest'] ?? ORDER.newest

    // Counted before the page is cut, so the screen can say "50 of 812"
    // instead of leaving an operator to guess whether there is more.
    const totals = await queryOne<{ total: number, active: number, suspended: number, banned: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE u.status = 'active')::int AS active,
              count(*) FILTER (WHERE u.status = 'suspended')::int AS suspended,
              count(*) FILTER (WHERE u.status = 'banned')::int AS banned
         FROM users u ${filter}`,
      params
    )

    params.push(limit ?? 50, offset ?? 0)
    const data = await query(
      `SELECT u.id, u.username, u.email, u.status, u.created_at, u.last_login_at,
              u.email_verified_at,
              coalesce(array_agg(r.slug) FILTER (WHERE r.slug IS NOT NULL), '{}') AS roles,
              -- Cheap per-row counts, each an index lookup on a column the
              -- table is already indexed by. They are what turns a list of
              -- names into something an operator can triage from: an account
              -- with no library and one comment is a different problem from
              -- one with four hundred.
              (SELECT count(*)::int FROM sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
              (SELECT count(*)::int FROM comments c WHERE c.author_id = u.id) AS comments,
              (SELECT count(*)::int FROM reports rp WHERE rp.subject_type = 'user' AND rp.subject_id = u.id) AS reports_against
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       ${filter}
       GROUP BY u.id
       ORDER BY ${order}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    return { data, totals }
  })

  fastify.post('/users/:id/status', {
    onRequest: fastify.requirePermission('admin.users.manage', { hide: true }),
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

    const revoked = await transaction(async client => {
      await client.query('UPDATE users SET status = $2 WHERE id = $1', [id, status])
      let ended = 0
      if (status !== 'active') {
        // kill all sessions on suspend/ban
        const { rows } = await client.query(
          'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [id])
        ended = rows.length
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
      return ended
    })
    // Drop the cached version/permissions so the change takes effect now
    // rather than at the end of the cache TTL.
    invalidatePermissions(id)

    // The moderated account, with enough context that the message is worth
    // reading on its own: who did it, how long the account has been here, and
    // how many sessions the decision just ended. A bare username and "banned"
    // left every one of those to be looked up by hand.
    const actor = await queryOne<{ username: string, created_at: Date }>(
      'SELECT username, created_at FROM users WHERE id = $1', [id])
    await emitEvent('user.moderated', {
      username: actor?.username,
      userId: id,
      action: status === 'active' ? 'restore' : status,
      previousStatus: before.status,
      memberSince: actor?.created_at?.toISOString().slice(0, 10) ?? null,
      sessionsRevoked: revoked,
      by: request.user.username,
      reason
    })
    return { id, status, sessionsRevoked: revoked }
  })

  /**
   * Everything known about one account, on one screen.
   *
   * The list answers "who is this" and nothing else, which meant every real
   * question — is this a spammer, is this a long-standing member with one bad
   * comment, has anyone acted on this before — was answered by writing SQL.
   * All of it is already recorded; none of it was reachable.
   *
   * Deliberately absent: IP addresses and user agents. `sessions` and
   * `security_logs` hold both, and an operator deciding on a ban does not need
   * them — counts and timestamps answer the same questions without putting a
   * person's location on a screen. If a future case genuinely needs them it
   * should be its own permission, not a field that leaks into this one.
   */
  fastify.get('/users/:id', {
    onRequest: fastify.requirePermission('admin.users.manage', { hide: true }),
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const account = await queryOne(
      `SELECT u.id, u.username, u.email, u.status, u.created_at, u.updated_at,
              u.last_login_at, u.email_verified_at, u.deleted_at, u.token_version,
              (u.password_hash IS NOT NULL) AS has_password,
              (u.mfa_secret IS NOT NULL) AS mfa_enabled
         FROM users u WHERE u.id = $1`,
      [id]
    )
    if (!account) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // Each of these is a small indexed lookup, run together rather than in
    // sequence — the screen is one request and should cost one round trip's
    // worth of latency, not nine.
    const [roles, allRoles, profiles, sessions, moderation, security, audit, activity] = await Promise.all([
      query(
        `SELECT r.id, r.slug, r.name, ur.granted_at
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1 ORDER BY r.slug`, [id]),
      query('SELECT id, slug, name FROM roles ORDER BY slug'),
      query(
        `SELECT p.id, p.display_name, p.is_default, p.created_at,
                (SELECT count(*)::int FROM library_entries le WHERE le.profile_id = p.id) AS library_entries,
                (SELECT count(*)::int FROM reviews rv WHERE rv.profile_id = p.id) AS reviews
           FROM user_profiles p WHERE p.user_id = $1 ORDER BY p.created_at`, [id]),
      queryOne(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS active,
                max(created_at) AS newest,
                count(DISTINCT device_id) FILTER (WHERE device_id IS NOT NULL)::int AS devices
           FROM sessions WHERE user_id = $1`, [id]),
      query(
        `SELECT m.action, m.reason, m.created_at, mu.username AS moderator
           FROM moderation_actions m
           LEFT JOIN users mu ON mu.id = m.moderator_id
          WHERE m.subject_type = 'user' AND m.subject_id = $1
          ORDER BY m.created_at DESC LIMIT 20`, [id]),
      query(
        `SELECT event, count(*)::int AS n, max(created_at) AS last_at
           FROM security_logs WHERE user_id = $1
          GROUP BY event ORDER BY max(created_at) DESC`, [id]),
      query(
        `SELECT a.action, a.before, a.after, a.created_at, au.username AS actor
           FROM audit_logs a
           LEFT JOIN users au ON au.id = a.actor_id
          WHERE a.subject_type = 'user' AND a.subject_id = $1
          ORDER BY a.created_at DESC LIMIT 20`, [id]),
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM comments c WHERE c.author_id = $1) AS comments,
           (SELECT count(*)::int FROM reports r WHERE r.reporter_id = $1) AS reports_filed,
           (SELECT count(*)::int FROM reports r WHERE r.subject_type = 'user' AND r.subject_id = $1) AS reports_against,
           (SELECT coalesce(sum(w.watched_sec), 0)::bigint FROM watch_history w
              JOIN user_profiles p ON p.id = w.profile_id WHERE p.user_id = $1) AS watched_sec,
           (SELECT count(*)::int FROM watch_history w
              JOIN user_profiles p ON p.id = w.profile_id WHERE p.user_id = $1 AND w.finished) AS episodes_finished,
           (SELECT max(w.started_at) FROM watch_history w
              JOIN user_profiles p ON p.id = w.profile_id WHERE p.user_id = $1) AS last_watched_at`,
        [id])
    ])

    return { account, roles, allRoles, profiles, sessions, moderation, security, audit, activity }
  })

  /**
   * Grant or revoke one role on one account.
   *
   * There was no way to do this at all. The Roles screen edits what a role may
   * do; nothing anywhere said who holds it, so promoting a moderator meant an
   * INSERT into user_roles by hand — unaudited, and easy to get wrong in the
   * direction that matters.
   *
   * Two refusals, both about not locking everybody out:
   *   * you cannot change your own roles, for the same reason you cannot ban
   *     yourself two routes above;
   *   * the last administrator cannot be demoted. The registration bootstrap
   *     only fires on an instance with *no* administrator and every account
   *     already exists by then, so an instance that demotes its last one is
   *     not recoverable through any screen.
   */
  fastify.post('/users/:id/roles', {
    onRequest: fastify.requirePermission('role.assign', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['role', 'granted'],
        properties: {
          role: { type: 'string', minLength: 1, maxLength: 40 },
          granted: { type: 'boolean' },
          reason: { type: 'string', maxLength: 500 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { role, granted, reason } = request.body as { role: string, granted: boolean, reason?: string }
    const bad = (detail: string): unknown =>
      reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail })

    if (id === request.user.sub) return bad('You cannot change your own roles')

    const target = await queryOne<{ username: string }>('SELECT username FROM users WHERE id = $1', [id])
    if (!target) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const roleRow = await queryOne<{ id: string, slug: string }>('SELECT id, slug FROM roles WHERE slug = $1', [role])
    if (!roleRow) return bad(`No role named "${role}"`)

    if (!granted && roleRow.slug === 'admin') {
      const others = await queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE r.slug = 'admin' AND ur.user_id <> $1`, [id])
      if (Number(others?.n ?? 0) === 0) return bad('This is the last administrator — promote somebody else first')
    }

    const held = await queryOne<{ n: number }>(
      'SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1 AND role_id = $2', [id, roleRow.id])
    if ((Number(held?.n ?? 0) > 0) === granted) return { id, role: roleRow.slug, granted, changed: false }

    await transaction(async client => {
      if (granted) {
        await client.query(
          'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, roleRow.id])
      } else {
        await client.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [id, roleRow.id])
      }
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1, $2, 'user', $3, $4, $5)`,
        // `before` and `after` are the same shape so the trail reads as a
        // change rather than as two unrelated objects: the screen lines them
        // up key by key, and a key that appears on only one side is shown as a
        // note, not as a value that moved.
        [request.user.sub, granted ? 'user.role.grant' : 'user.role.revoke', id,
          { role: roleRow.slug, granted: !granted },
          { role: roleRow.slug, granted, reason: reason ?? null }]
      )
      // Deliberately not written to moderation_actions. That table's `action`
      // is a closed set — hide, delete, warn, mute, suspend, ban, restore,
      // dismiss_report — and it means "something was done about misconduct".
      // Promoting a moderator is an administrative act, not a disciplinary
      // one, and widening the vocabulary to fit it would make the moderation
      // history a worse answer to the question it exists for. The audit log
      // is where "who changed what" lives, and the account panel reads it.
    })
    // The permission set is cached per user; without this the change takes
    // effect whenever the entry happens to expire.
    invalidatePermissions(id)

    const by = await queryOne<{ username: string }>('SELECT username FROM users WHERE id = $1', [request.user.sub])
    await emitEvent('user.roles.changed', {
      username: target.username,
      userId: id,
      role: roleRow.slug,
      granted,
      reason: reason ?? null,
      by: by?.username ?? 'system'
    })
    return { id, role: roleRow.slug, granted, changed: true }
  })

  /**
   * Sign an account out of everywhere.
   *
   * Revoking the refresh tokens alone leaves the access tokens valid until
   * they expire, so the version is bumped in the same transaction — the same
   * pairing the ban path uses, and for the same reason.
   *
   * Separate from suspending: a shared password or a lost laptop is not
   * misconduct, and the only tool for it used to be a ban.
   */
  fastify.post('/users/:id/sessions/revoke', {
    onRequest: fastify.requirePermission('session.revoke', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { reason } = request.body as { reason: string }

    const target = await queryOne<{ username: string }>('SELECT username FROM users WHERE id = $1', [id])
    if (!target) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const revoked = await transaction(async client => {
      const { rows } = await client.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [id])
      await client.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [id])
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1, 'user.sessions.revoke', 'user', $2, $3, $4)`,
        [request.user.sub, id, { sessions: rows.length }, { sessions: 0, reason }]
      )
      return rows.length
    })
    invalidatePermissions(id)

    return { id, revoked }
  })
}

export default routes
