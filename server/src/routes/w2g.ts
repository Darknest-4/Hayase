// /v1/w2g — watch-together room registry. Live sync runs over /ws
// (channel w2g:{code}); these routes create/find/close rooms.

import { randomBytes } from 'node:crypto'

import { query, queryOne } from '../db.ts'
import { presence } from '../lib/ws.ts'
import { emitEvent } from '../lib/webhooks.ts'

import { retryOnCollision } from '../lib/db-errors.ts'

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

    /**
     * The invite code is the room's only credential, and the column is UNIQUE.
     * It used to be generated once and inserted: a collision raised 23505 and
     * escaped as a 500 with the constraint name in it. Four random bytes is
     * 2^32, which sounds like plenty until you notice closed rooms are kept,
     * so the occupied space only ever grows and every new room is drawn
     * against all of history.
     *
     * Retrying is the honest fix — a collision is a fact about the draw, not
     * about the request, so the caller should never see it. Five attempts put
     * the residual failure far below any other way this call can fail.
     */
    const room = await retryOnCollision(async () => queryOne(
      `INSERT INTO watch_together_rooms (code, host_profile, episode_id, is_public)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, episode_id, is_public, created_at`,
      [randomBytes(4).toString('hex'), profile.id, episodeId ?? null, isPublic ?? false]
    ))
    await emitEvent('w2g.room_created', { code: (room as { code: string }).code, host: profile.id })
    return reply.code(201).send(room)
  })

  /**
   * Read a room by its invite code.
   *
   * Unauthenticated on purpose: the code is the credential. This is a
   * capability URL — holding the link is the authorisation, exactly as with a
   * meeting link — so a room that is not listed is still readable by anyone
   * who has been given its code.
   *
   * Note that `is_public` means *listed*, not *access-controlled*. The two
   * read alike and are not the same thing. Chat messages are a separate
   * endpoint and are NOT served this way.
   */
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
    // Scoped to the host, so a stranger's request changes nothing — but it
    // used to return 204 regardless, telling them it had worked. Report what
    // actually happened instead.
    const closed = await query(
      `UPDATE watch_together_rooms r SET closed_at = now()
       FROM user_profiles p
       WHERE r.code = $1 AND r.closed_at IS NULL AND p.id = r.host_profile AND p.user_id = $2
       RETURNING r.id`,
      [code, request.user.sub]
    )
    if (!closed.length) {
      return reply.code(404).send({
        type: 'about:blank', title: 'Not Found', status: 404,
        detail: 'No open room with that code that you host'
      })
    }
    return reply.code(204).send()
  })
}

export default routes
