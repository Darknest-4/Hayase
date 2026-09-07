// /v1/comments — the unified comment system (anime/episode/post).
// Threading uses the materialised path column; this API exposes one level
// of nesting (top-level + replies), which is what the client renders.

import { query, queryOne, transaction } from '../db.ts'
import { emitEvent } from '../lib/webhooks.ts'
import { notify } from '../workers/notify.ts'

import type { FastifyPluginAsync } from 'fastify'
import { WRITE_LIMIT } from '../plugins/security.ts'

const SUBJECT_TYPES = ['anime', 'episode', 'post', 'review'] as const

const routes: FastifyPluginAsync = async fastify => {
  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        required: ['subjectType', 'subjectId'],
        properties: {
          subjectType: { enum: [...SUBJECT_TYPES] },
          subjectId: { type: 'string', format: 'uuid' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async request => {
    const { subjectType, subjectId, limit } = request.query as { subjectType: string, subjectId: string, limit?: number }
    const data = await query(
      `SELECT c.id, c.parent_id, c.body, c.spoiler, c.like_count, c.reply_count,
              c.created_at, c.edited_at, u.username AS author
       FROM comments c
       JOIN users u ON u.id = c.author_id
       WHERE c.subject_type = $1 AND c.subject_id = $2 AND c.hidden_at IS NULL
       ORDER BY c.path, c.created_at
       LIMIT $3`,
      [subjectType, subjectId, limit ?? 50]
    )
    return { data }
  })

  // recent comments across the platform — powers the Community feed
  fastify.get('/recent', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 25 } }
      }
    }
  }, async request => {
    const { limit } = request.query as { limit?: number }
    const data = await query(
      `SELECT c.id, c.subject_type, c.subject_id, c.body, c.spoiler, c.like_count,
              c.created_at, u.username AS author,
              a.canonical_title AS anime_title, m.anilist_id
       FROM comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN anime a ON c.subject_type = 'anime' AND a.id = c.subject_id
       LEFT JOIN anime_mappings m ON m.anime_id = a.id
       WHERE c.hidden_at IS NULL AND c.parent_id IS NULL
       ORDER BY c.created_at DESC
       LIMIT $1`,
      [limit ?? 25]
    )
    return { data }
  })

  fastify.post('/', {
    config: WRITE_LIMIT,
    onRequest: fastify.requirePermission('community.post'),
    schema: {
      body: {
        type: 'object',
        required: ['subjectType', 'subjectId', 'body'],
        properties: {
          subjectType: { enum: [...SUBJECT_TYPES] },
          subjectId: { type: 'string', format: 'uuid' },
          body: { type: 'string', minLength: 1, maxLength: 10000 },
          parentId: { type: 'string', format: 'uuid' },
          spoiler: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const { subjectType, subjectId, body, parentId, spoiler } = request.body as {
      subjectType: string, subjectId: string, body: string, parentId?: string, spoiler?: boolean
    }

    // validate the subject exists for the types we can check
    if (subjectType === 'anime') {
      const exists = await queryOne('SELECT 1 FROM anime WHERE id = $1', [subjectId])
      if (!exists) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'Unknown anime' })
    }

    let path = ''
    let parentAuthor: string | null = null
    if (parentId) {
      const parent = await queryOne<{ id: string, path: string, subject_id: string, author_id: string }>(
        'SELECT id, path, subject_id, author_id FROM comments WHERE id = $1 AND hidden_at IS NULL',
        [parentId]
      )
      if (!parent || parent.subject_id !== subjectId) {
        return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'Unknown parent comment' })
      }
      path = parent.path ? `${parent.path}.${parent.id}` : parent.id
      parentAuthor = parent.author_id
    }

    const comment = await transaction(async client => {
      const { rows } = await client.query(
        `INSERT INTO comments (subject_type, subject_id, author_id, parent_id, path, body, spoiler)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, parent_id, body, spoiler, like_count, reply_count, created_at`,
        [subjectType, subjectId, request.user.sub, parentId ?? null, path, body, spoiler ?? false]
      )
      if (parentId) {
        await client.query('UPDATE comments SET reply_count = reply_count + 1 WHERE id = $1', [parentId])
      }
      return rows[0] as Record<string, unknown>
    })

    // notify the parent comment's author about the reply (not self-replies).
    // Inline: one insert + live WS push. Mass fan-out (episode_aired) goes
    // through the notify queue instead.
    if (parentAuthor && parentAuthor !== request.user.sub) {
      await notify(parentAuthor, 'comment_reply', {
        commentId: comment.id, by: request.user.username, subjectType, subjectId, preview: body.slice(0, 120)
      })
    }

    await emitEvent('comment.created', {
      author: request.user.username, subject: subjectType, preview: body.slice(0, 200)
    })

    return reply.code(201).send({ ...comment, author: request.user.username })
  })

  fastify.post('/:id/like', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const exists = await queryOne('SELECT 1 FROM comments WHERE id = $1 AND hidden_at IS NULL', [id])
    if (!exists) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    /**
     * Toggling has to survive being raced with itself.
     *
     * A double-clicked button sends two requests. Both found no row to delete,
     * both inserted, and the second hit comment_likes_pkey — which escaped as
     * a 500 carrying the constraint name. Verified: six parallel likes from
     * one account returned 200 200 200 500 500 500.
     *
     * ON CONFLICT DO NOTHING makes the insert idempotent, and the counter is
     * only moved when a row actually changed, so a lost race adds nothing.
     */
    const liked = await transaction(async client => {
      const { rowCount } = await client.query(
        'DELETE FROM comment_likes WHERE comment_id = $1 AND user_id = $2',
        [id, request.user.sub]
      )
      if ((rowCount ?? 0) > 0) {
        await client.query('UPDATE comments SET like_count = greatest(like_count - 1, 0) WHERE id = $1', [id])
        return false
      }

      const inserted = await client.query(
        'INSERT INTO comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, request.user.sub]
      )
      if ((inserted.rowCount ?? 0) > 0) {
        await client.query('UPDATE comments SET like_count = like_count + 1 WHERE id = $1', [id])
      }
      return true
    })

    return { liked }
  })
}

export default routes
