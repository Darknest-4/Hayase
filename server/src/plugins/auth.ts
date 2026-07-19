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

async function loadPermissions (userId: string): Promise<Set<string>> {
  const rows = await query<{ slug: string }>(
    `SELECT DISTINCT p.slug
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [userId]
  )
  return new Set(rows.map(row => row.slug))
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
