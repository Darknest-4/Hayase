// /v1/admin/users — the account surface of the administration panel.
//
// Split out of one 779-line modules/admin/routes.ts that also held the
// moderation queue, platform analytics, error triage and the audit trail.
// Four unrelated reasons to change one file, and the reason "where is the
// account suspension written" had no answer shorter than a scroll.
//
// The URLs are unchanged: modules/admin/routes.ts still composes this under
// the same /v1/admin prefix, so nothing the client calls moved.

import { UserRepository, userRepository as accounts } from './repository.ts'
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
      where.push(UserRepository.roleFilter(params.length))
    }
    const filter = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const order = UserRepository.orderBy(sort)

    // Counted before the page is cut, so the screen can say "50 of 812"
    // instead of leaving an operator to guess whether there is more.
    const totals = await accounts.totals(filter, params)

    params.push(limit ?? 50, offset ?? 0)
    const data = await accounts.list(filter, order, params)
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

    const before = await accounts.statusOf(id)
    if (!before) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // Sessions and the token version move with the status, in one unit — see
    // the repository for why they cannot be two statements.
    const revoked = await accounts.setStatus({
      userId: id,
      status,
      previousStatus: before.status,
      reason,
      actorId: request.user.sub
    })
    // Drop the cached version/permissions so the change takes effect now
    // rather than at the end of the cache TTL.
    invalidatePermissions(id)

    // The moderated account, with enough context that the message is worth
    // reading on its own: who did it, how long the account has been here, and
    // how many sessions the decision just ended. A bare username and "banned"
    // left every one of those to be looked up by hand.
    const actor = await accounts.identityOf(id)
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

    const account = await accounts.account(id)
    if (!account) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // Each of these is a small indexed lookup, run together rather than in
    // sequence — the screen is one request and should cost one round trip's
    // worth of latency, not nine.
    // One request, one round trip's worth of latency — see the repository.
    const [roles, allRoles, profiles, sessions, moderation, security, audit, activity] =
      await accounts.panel(id)

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

    const target = await accounts.usernameOf(id)
    if (!target) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const roleRow = await accounts.roleBySlug(role)
    if (!roleRow) return bad(`No role named "${role}"`)

    if (!granted && roleRow.slug === 'admin' && await accounts.otherAdmins(id) === 0) {
      return bad('This is the last administrator — promote somebody else first')
    }

    if (await accounts.holdsRole(id, roleRow.id) === granted) {
      return { id, role: roleRow.slug, granted, changed: false }
    }

    await accounts.setRole({
      userId: id,
      roleId: roleRow.id,
      slug: roleRow.slug,
      granted,
      reason: reason ?? null,
      actorId: request.user.sub
    })
    // The permission set is cached per user; without this the change takes
    // effect whenever the entry happens to expire.
    invalidatePermissions(id)

    const by = await accounts.usernameOf(request.user.sub)
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

    if (!await accounts.usernameOf(id)) {
      return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }

    const revoked = await accounts.revokeAllSessions(id, request.user.sub, reason)
    invalidatePermissions(id)

    return { id, revoked }
  })
}

export default routes
