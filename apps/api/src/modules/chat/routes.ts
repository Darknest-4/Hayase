// /v1/chat — public rooms, and the history behind them.
//
// The live half already existed: infrastructure/websocket persists a message
// and broadcasts it to every subscriber, on every instance, and refuses a
// channel the caller is not a member of. What was missing is everything you
// need before a socket is useful — which rooms there are, how to become a
// member of one, and what was said before you arrived.
//
// So this module is deliberately small. It does not send messages: a message
// sent over HTTP would have to be broadcast to the sockets anyway, and then
// there would be two paths that must agree about ordering and about what
// counts as a member.

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { WRITE_LIMIT } from '../../middleware/security.ts'

import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('onRequest', fastify.requireFeature('feature.chat'))

  /** Public rooms. Readable signed out, so the tab shows something before sign-in. */
  fastify.get('/rooms', async () => {
    const data = await query(
      `SELECT c.id, c.slug, c.name, c.topic, c.created_at,
              (SELECT count(*) FROM chat_members m WHERE m.chat_id = c.id)::int AS members,
              (SELECT count(*) FROM messages msg
                WHERE msg.chat_id = c.id AND msg.deleted_at IS NULL
                  AND msg.created_at > now() - interval '24 hours')::int          AS today
         FROM chats c
        WHERE c.kind = 'room'
        ORDER BY c.name`
    )
    return { data }
  })

  /**
   * Join a room, which is what makes the socket accept you on its channel.
   *
   * Idempotent: opening the tab twice is not an error, and the client calls
   * this every time it opens a room rather than tracking membership itself.
   */
  fastify.post('/rooms/:slug/join', {
    config: WRITE_LIMIT,
    onRequest: fastify.authenticate
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const room = await queryOne<{ id: string }>("SELECT id FROM chats WHERE slug = $1 AND kind = 'room'", [slug])
    if (!room) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such room' })

    await query(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (chat_id, user_id) DO UPDATE SET last_read_at = now()`,
      [room.id, request.user.sub]
    )
    return { id: room.id, channel: `chat:${room.id}` }
  })

  /**
   * What was said before now, newest first.
   *
   * Newest first because that is the page a room opens on; the client reverses
   * it to draw. `before` pages backwards through the history by message id,
   * which is a bigint identity column and therefore already in send order —
   * no timestamp precision to get wrong.
   */
  fastify.get('/rooms/:slug/messages', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          before: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const { limit = 50, before } = request.query as { limit?: number, before?: number }

    const room = await queryOne<{ id: string }>("SELECT id FROM chats WHERE slug = $1 AND kind = 'room'", [slug])
    if (!room) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such room' })

    const params: unknown[] = [room.id]
    let cursor = ''
    if (before !== undefined) { params.push(before); cursor = `AND m.id < $${params.length}` }
    params.push(limit)

    const data = await query(
      `SELECT m.id, m.body, m.created_at, m.reply_to, u.username AS author,
              ap.avatar_key AS author_avatar
         FROM messages m
         JOIN users u ON u.id = m.author_id
         LEFT JOIN user_profiles ap ON ap.user_id = u.id
        WHERE m.chat_id = $1 AND m.deleted_at IS NULL ${cursor}
        ORDER BY m.id DESC
        LIMIT $${params.length}`,
      params
    )
    return { data, roomId: room.id }
  })

  /** Take a message down. Hidden rather than removed, like a forum post. */
  fastify.delete('/messages/:id', {
    onRequest: fastify.requirePermission('chat.moderate')
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const gone = await queryOne(
      'UPDATE messages SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [Number(id)]
    )
    if (!gone) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return reply.code(204).send()
  })
}

export default routes
