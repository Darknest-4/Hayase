// Authentication + RBAC plugin.
//  - registers @fastify/jwt for access tokens
//  - decorates fastify.authenticate (route preHandler)
//  - decorates fastify.requirePermission(slug) — resolves the user's
//    permission set (users → user_roles → role_permissions) with a
//    per-request memo; Redis caching slots in here later without touching
//    call sites.

import fastifyJwt from '@fastify/jwt'
import fp from 'fastify-plugin'

import { config } from '../config.ts'
import { query } from '../db.ts'

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface AccessTokenPayload {
  sub: string       // user id
  username: string
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload
    user: AccessTokenPayload
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: preHandlerHookHandler
    requirePermission: (slug: string) => preHandlerHookHandler
  }
}

/**
 * Permission-set cache.
 *
 * Every privileged request ran a three-table join, with no cache anywhere —
 * the comment above promised a per-request memo that was never written. An
 * admin page load meant a dozen of those against a small connection pool.
 *
 * In-process and short-lived on purpose: correct for a single instance, and
 * bounded staleness (a revoked role takes effect within the TTL) rather than
 * an invalidation protocol nothing yet needs. When a second app instance
 * appears this is one of the two places Redis takes over — see docs/redis.md.
 */
const PERMISSION_TTL_MS = Number(process.env.PERMISSION_CACHE_TTL_MS ?? 30_000)
const permissionCache = new Map<string, { permissions: Set<string>, expires: number }>()

/** Drop a user's cached set — called whenever their roles change. */
export function invalidatePermissions (userId?: string): void {
  if (userId) permissionCache.delete(userId)
  else permissionCache.clear()
}

async function loadPermissions (userId: string): Promise<Set<string>> {
  const hit = permissionCache.get(userId)
  if (hit && hit.expires > Date.now()) return hit.permissions

  const rows = await query<{ slug: string }>(
    `SELECT DISTINCT p.slug
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [userId]
  )
  const permissions = new Set(rows.map(row => row.slug))
  permissionCache.set(userId, { permissions, expires: Date.now() + PERMISSION_TTL_MS })

  // The cache is keyed per user and entries expire, but a long-lived process
  // with many users would still grow — so it is swept when it gets large.
  if (permissionCache.size > 5_000) {
    const now = Date.now()
    for (const [key, entry] of permissionCache) if (entry.expires <= now) permissionCache.delete(key)
  }
  return permissions
}

export default fp(async fastify => {
  await fastify.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.accessTokenTtl }
  })

  fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify()
    } catch {
      await reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401 })
    }
  })

  fastify.decorate('requirePermission', (slug: string) =>
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify()
      } catch {
        return reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401 })
      }
      const permissions = await loadPermissions(request.user.sub)
      if (!permissions.has(slug)) {
        return reply.code(403).send({ type: 'about:blank', title: 'Forbidden', status: 403, detail: `Missing permission: ${slug}` })
      }
    })
})
