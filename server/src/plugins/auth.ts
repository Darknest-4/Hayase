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
  /**
   * The user's token_version at mint time. Signing out everywhere, a ban or a
   * password change bumps that column, which invalidates every outstanding
   * token at once — no blocklist to store, expire and consult per request.
   */
  tv?: number
  /**
   * The session this token was minted under. Revoking that one row kills this
   * token and leaves the account's other devices alone, which is what signing
   * out of one device means. Without it, logout revoked the refresh token and
   * the access token kept working for the rest of its lifetime.
   *
   * Optional so that tokens minted before this existed keep working until they
   * expire — a deploy must not sign everyone out.
   */
  sid?: string
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

/**
 * Cached token_version per user, sharing the permission cache's TTL: a
 * revocation takes effect within it, and the common case costs no query.
 *
 * The entry remembers which sessions were seen live, so a token whose session
 * was revoked is not accepted from cache. A logged-out token must stop working
 * immediately — a bounded delay is fine for a role change and not for a
 * sign-out.
 */
const versionCache = new Map<string, { version: number, expires: number, liveSessions: Set<string> }>()

/**
 * True when the token is still the one the account and the session agree on.
 *
 * Two checks, one query:
 *   * the account exists, is active, and its token_version still matches
 *   * the session the token names has not been revoked or expired
 */
export async function tokenIsCurrent (payload: AccessTokenPayload): Promise<boolean> {
  const claimed = payload.tv ?? 0
  const hit = versionCache.get(payload.sub)

  // A cache hit may only ever ACCEPT. Rejecting on a stale entry would turn a
  // freshly issued token into a 401 — a much worse failure than briefly
  // honouring a revoked one — and the cache goes stale whenever the version
  // changes outside this process (another instance, a manual fix).
  //
  // A token carrying a session id must also find that session in the cached
  // live set: revoking a session removes it, so a logged-out token misses and
  // falls through to the query below rather than being waved past.
  if (hit && hit.expires > Date.now() && hit.version === claimed) {
    if (!payload.sid || hit.liveSessions.has(payload.sid)) return true
  }

  const rows = await query<{ token_version: number, session_live: boolean }>(
    `SELECT u.token_version,
            ($2::uuid IS NULL OR EXISTS (
               SELECT 1 FROM sessions s
                WHERE s.id = $2::uuid AND s.revoked_at IS NULL AND s.expires_at > now()
             )) AS session_live
       FROM users u
      WHERE u.id = $1 AND u.status = 'active' AND u.deleted_at IS NULL`,
    [payload.sub, payload.sid ?? null]
  )
  if (!rows[0]) return false // gone, banned or suspended
  if (!rows[0].session_live) return false // signed out on this device

  const live = hit && hit.expires > Date.now() ? hit.liveSessions : new Set<string>()
  if (payload.sid) live.add(payload.sid)
  versionCache.set(payload.sub, {
    version: rows[0].token_version,
    expires: Date.now() + PERMISSION_TTL_MS,
    liveSessions: live
  })
  return rows[0].token_version === claimed
}

/**
 * Forget a revoked session, so its access token stops being accepted from
 * cache rather than at the end of the cache TTL.
 */
export function invalidateSession (userId: string, sessionId?: string): void {
  const hit = versionCache.get(userId)
  if (!hit) return
  if (sessionId) hit.liveSessions.delete(sessionId)
  else versionCache.delete(userId)
}

/**
 * Invalidate every outstanding access token for one user, on every device.
 *
 * The heavy lever: a ban, a password change, or an explicit "sign out
 * everywhere". Signing out of one device revokes that session instead — see
 * invalidateSession.
 */
export async function revokeTokens (userId: string): Promise<void> {
  await query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId])
  versionCache.delete(userId)
  permissionCache.delete(userId)
}

/** Drop a user's cached set — called whenever their roles change. */
export function invalidatePermissions (userId?: string): void {
  if (userId) { permissionCache.delete(userId); versionCache.delete(userId) }
  else { permissionCache.clear(); versionCache.clear() }
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

  /**
   * Verify the signature, then confirm the token has not been revoked.
   *
   * The version check is one indexed lookup and rides the same cache as the
   * permission set, so it costs nothing on the hot path — but without it a
   * banned user keeps API access until their token expires.
   */
  async function verify (request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    try {
      await request.jwtVerify()
    } catch {
      await reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401 })
      return false
    }
    if (!await tokenIsCurrent(request.user)) {
      await reply.code(401).send({
        type: 'about:blank', title: 'Unauthorized', status: 401,
        detail: 'This session has been revoked — sign in again'
      })
      return false
    }
    return true
  }

  fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    await verify(request, reply)
  })

  fastify.decorate('requirePermission', (slug: string) =>
    async function (request: FastifyRequest, reply: FastifyReply) {
      if (!await verify(request, reply)) return
      const permissions = await loadPermissions(request.user.sub)
      if (!permissions.has(slug)) {
        return reply.code(403).send({ type: 'about:blank', title: 'Forbidden', status: 403, detail: `Missing permission: ${slug}` })
      }
    })
})
