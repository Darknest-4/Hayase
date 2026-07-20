// /v1/w2g — watch-together room registry. Live sync runs over /ws
// (channel w2g:{code}); these routes create/find/close rooms.

import { randomBytes } from 'node:crypto'

import { query, queryOne } from '../db.ts'
import { presence } from '../lib/ws.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  fastify.post('/', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          episodeId: { type: 'string', format: 'uuid' },
          isPublic: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const { episodeId, isPublic } = (request.body ?? {}) as { episodeId?: string, isPublic?: boolean }

    const profile = await queryOne<{ id: string }>(
      'SELECT id FROM user_profiles WHERE user_id = $1 ORDER BY is_default DESC LIMIT 1',
      [request.user.sub]
    )
    if (!profile) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Account has no profile' })

    const code = randomBytes(4).toString('hex')
    const room = await queryOne(
      `INSERT INTO watch_together_rooms (code, host_profile, episode_id, is_public)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, episode_id, is_public, created_at`,
      [code, profile.id, episodeId ?? null, isPublic ?? false]
    )
    await emitEvent('w2g.room_created', { code, host: profile.id })
    return reply.code(201).send(room)
  })

  fastify.get('/:code', async (request, reply) => {
    const { code } = request.params as { code: string }
    const room = await queryOne(
      `SELECT r.id, r.code, r.episode_id, r.is_public, r.created_at,
              p.display_name AS host
       FROM watch_together_rooms r
       JOIN user_profiles p ON p.id = r.host_profile
       WHERE r.code = $1 AND r.closed_at IS NULL`,
      [code]
    )
    if (!room) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return { ...room, viewers: presence(`w2g:${code}`) }
  })

  fastify.delete('/:code', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { code } = request.params as { code: string }
    await query(
      `UPDATE watch_together_rooms r SET closed_at = now()
       FROM user_profiles p
       WHERE r.code = $1 AND r.closed_at IS NULL AND p.id = r.host_profile AND p.user_id = $2`,
      [code, request.user.sub]
    )
    return reply.code(204).send()
  })
}

export default routes
