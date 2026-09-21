// /v1/comments — the unified comment system (anime/episode/post).
// Threading uses the materialised path column; this API exposes one level
// of nesting (top-level + replies), which is what the client renders.

import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'
import { emitEvent } from '../webhooks/delivery.ts'
import { loadPermissions } from '../../middleware/auth.ts'
import { notify } from '../notifications/worker.ts'

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { WRITE_LIMIT } from '../../middleware/security.ts'

const SUBJECT_TYPES = ['anime', 'episode', 'post', 'review'] as const

const routes: FastifyPluginAsync = async fastify => {
  // The kill switch, enforced. `feature.comments` used to gate only the
  // client's own routing, so turning off the comment surface — threads, replies and likes
  // removed the buttons and left every endpoint answering normally.
  fastify.addHook('onRequest', fastify.requireFeature('feature.comments'))

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
              c.created_at, c.edited_at, c.deleted_at, c.author_id,
              u.username AS author,
              ap.avatar_key AS author_avatar
       FROM comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN user_profiles ap ON ap.user_id = u.id
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
              c.created_at, u.username AS author, ap.avatar_key AS author_avatar,
              a.canonical_title AS anime_title, m.anilist_id
       FROM comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN user_profiles ap ON ap.user_id = u.id
       LEFT JOIN anime a ON c.subject_type = 'anime' AND a.id = c.subject_id
       LEFT JOIN anime_mappings m ON m.anime_id = a.id
       WHERE c.hidden_at IS NULL AND c.deleted_at IS NULL AND c.parent_id IS NULL
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

  /**
   * A komment törlése.
   *
   * KI TÖRÖLHET. A szerző a sajátját, és aki `comment.moderate` jogot tart, a
   * másokét. A döntés a KISZOLGÁLÓN dől el: a kliens elrejtheti a gombot, de
   * az nem védelem — ezért kérdezzük le a szerzőt a törlés előtt, és ezért
   * felel 404-gyel az idegen komment, nem 403-mal (a 403 megerősítené, hogy a
   * megtippelt azonosító létezik).
   *
   * MI TÖRTÉNIK A VÁLASZOKKAL. A `parent_id` idegen kulcsa `ON DELETE
   * CASCADE`: egy szálindító puszta eldobása MÁSOK hozzászólásait is elvinné.
   * Ezért két eset van, és a különbség a válaszok száma:
   *
   *   * levél komment (nincs válasza) → a sor tényleg eltűnik, a lájkjaival
   *     együtt (azok is cascade-elnek);
   *   * szálindító → SÍRKŐ marad: a törzs helyére rövid jelölő kerül, a
   *     `deleted_at` beáll, a szál alakja megmarad. Az eredeti szöveg elvész.
   *
   * A szülő `reply_count`-ját egy levél törlésekor vissza kell venni, különben
   * a szál fejlécében ott marad egy válasz, ami nincs. Tranzakcióban, mert a
   * két írás együtt igaz vagy együtt hamis.
   */
  fastify.delete('/:id', {
    preHandler: fastify.authenticate,
    config: WRITE_LIMIT,
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const comment = await queryOne<{ author_id: string, parent_id: string | null, reply_count: number, deleted_at: Date | null }>(
      'SELECT author_id, parent_id, reply_count, deleted_at FROM comments WHERE id = $1',
      [id]
    )
    const missing = (): FastifyReply =>
      reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'Nincs ilyen hozzászólás' })

    if (!comment) return missing()

    const own = comment.author_id === request.user.sub
    /*
     * A JOGOSULTSÁGOT A KISZOLGÁLÓ OLVASSA KI, nem a token. A hozzáférési
     * token nem hordozza a jogosultságokat — ha hordozná, egy visszavont
     * moderátori jog a token lejártáig érvényben maradna. A `loadPermissions`
     * kérésenként memoizált, tehát ez nem lekérdezés minden törlésnél.
     *
     * Csak akkor kérdezzük meg, ha nem a sajátját törli: a hétköznapi eset ne
     * fizessen a ritkáért.
     */
    const moderator = own
      ? false
      : await loadPermissions(request.user.sub).then(
        held => held.has('comment.moderate') || held.has('community.moderate'))
    // Idegen komment jog nélkül: ugyanaz a válasz, mint a nem létezőre. Egy
    // 403 megerősítené, hogy a megtippelt azonosító mögött van valami.
    if (!own && !moderator) return missing()

    // Már törölve: a kívánt állapot áll fenn. Nem hiba, és nem is írunk újra.
    if (comment.deleted_at) return reply.code(204).send()

    const tombstone = comment.reply_count > 0

    await transaction(async client => {
      if (tombstone) {
        await client.query(
          `UPDATE comments
              SET body = $2, deleted_at = now(), spoiler = false, edited_at = NULL
            WHERE id = $1`,
          [id, '[törölve]']
        )
        return
      }
      await client.query('DELETE FROM comments WHERE id = $1', [id])
      if (comment.parent_id) {
        await client.query(
          'UPDATE comments SET reply_count = greatest(reply_count - 1, 0) WHERE id = $1',
          [comment.parent_id]
        )
      }
    })

    /*
     * A NAPLÓ A MODERÁLÁSRÓL SZÓL, nem a szerzőről. Aki a sajátját veszi le,
     * arról nem készül biztonsági bejegyzés — ez hétköznapi művelet. Ha egy
     * moderátor törli valaki másét, az viszont számon kérhető kell legyen.
     */
    if (!own) {
      await query(
        `INSERT INTO security_logs (user_id, event, severity, metadata)
         VALUES ($1, 'comment_deleted_by_moderator', 'low', $2::jsonb)`,
        [request.user.sub, JSON.stringify({ commentId: id, authorId: comment.author_id, tombstone })]
      ).catch(() => { /* a naplózás hibája nem vonhatja vissza a törlést */ })
    }

    return reply.code(204).send()
  })

  fastify.post('/:id/like', { preHandler: fastify.authenticate, config: WRITE_LIMIT }, async (request, reply) => {
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
