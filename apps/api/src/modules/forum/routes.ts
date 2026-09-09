// /v1/forum — boards, topics and posts.
//
// The tables have been in the schema since 0004 with nothing behind them: no
// routes, no page, and zero rows in every deployment. This is what they were
// waiting for, and the permissions catalogued alongside them (`forum.create`,
// `topic.pin`, `post.hide`, …) become enforced rather than planned.
//
// Anyone signed in may start a board. That is deliberate and it is the reason
// the moderation grants exist: `forum.delete` and `topic.lock` are what a
// moderator uses when somebody starts a board nobody wants. The alternative —
// only staff may create — makes the feature something people ask for rather
// than something they use.

import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'
import { WRITE_LIMIT } from '../../middleware/security.ts'

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type pg from 'pg'

/** A url-safe name derived from a title, unique-ified by the caller. */
function slugify (text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // fold Hungarian accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'forum'
}

const routes: FastifyPluginAsync = async fastify => {
  // The kill switch, enforced here rather than only in the client's routing —
  // the mistake the comment module documents having made.
  fastify.addHook('onRequest', fastify.requireFeature('feature.forum'))

  /** Does the caller hold this grant? Used to decide what to *offer*, not to authorise. */
  async function holds (request: FastifyRequest, slug: string): Promise<boolean> {
    if (!request.user) return false
    const row = await queryOne(
      `SELECT 1 FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1 AND p.slug = $2`,
      [request.user.sub, slug]
    )
    return !!row
  }

  // ---- boards ----

  fastify.get('/', async () => {
    const data = await query(
      `SELECT f.id, f.slug, f.name, f.description, f.position, f.anime_id, f.locked_at,
              f.created_at, u.username AS created_by,
              (SELECT count(*) FROM topics t WHERE t.forum_id = f.id)::int AS topic_count,
              (SELECT max(t.last_post_at) FROM topics t WHERE t.forum_id = f.id) AS last_post_at
         FROM forums f
         LEFT JOIN users u ON u.id = f.created_by
        ORDER BY f.position, f.name`
    )
    return { data }
  })

  fastify.get('/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const forum = await queryOne(
      `SELECT f.id, f.slug, f.name, f.description, f.anime_id, f.locked_at, f.created_at,
              u.username AS created_by
         FROM forums f LEFT JOIN users u ON u.id = f.created_by
        WHERE f.slug = $1`,
      [slug]
    )
    if (!forum) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such forum' })
    return forum
  })

  fastify.post('/', {
    config: WRITE_LIMIT,
    onRequest: fastify.requirePermission('forum.create'),
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 3, maxLength: 80 },
          description: { type: 'string', maxLength: 500 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { name, description } = request.body as { name: string, description?: string }

    // A slug collision is a rename, not an error: two people naming a board
    // "Ajánlók" should both get one.
    const base = slugify(name)
    const taken = await query<{ slug: string }>(
      'SELECT slug FROM forums WHERE slug = $1 OR slug LIKE $2', [base, base + '-%']
    )
    let slug = base
    if (taken.some(row => row.slug === base)) {
      let n = 2
      while (taken.some(row => row.slug === `${base}-${n}`)) n++
      slug = `${base}-${n}`
    }

    const forum = await queryOne(
      `INSERT INTO forums (slug, name, description, created_by, position)
       VALUES ($1, $2, $3, $4, 100)
       RETURNING id, slug, name, description, created_at`,
      [slug, name, description ?? null, request.user.sub]
    )
    return reply.code(201).send(forum)
  })

  fastify.patch('/:id', {
    onRequest: fastify.requirePermission('forum.edit'),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 3, maxLength: 80 },
          description: { type: 'string', maxLength: 500 },
          locked: { type: 'boolean' },
          position: { type: 'integer', minimum: 0, maximum: 1000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>
    const sets: string[] = []
    const params: unknown[] = [id]
    for (const [key, column] of Object.entries({ name: 'name', description: 'description', position: 'position' })) {
      if (body[key] !== undefined) { params.push(body[key]); sets.push(`${column} = $${params.length}`) }
    }
    if (body.locked !== undefined) sets.push(`locked_at = ${body.locked === true ? 'now()' : 'NULL'}`)
    if (!sets.length) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Nothing to change' })

    const forum = await queryOne(
      `UPDATE forums SET ${sets.join(', ')} WHERE id = $1 RETURNING id, slug, name, description, locked_at`, params
    )
    if (!forum) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return forum
  })

  fastify.delete('/:id', {
    onRequest: fastify.requirePermission('forum.delete')
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    // Topics and posts cascade. Deleting a board with discussion in it is a
    // moderator action and is audited like one.
    const gone = await queryOne('DELETE FROM forums WHERE id = $1 RETURNING slug', [id])
    if (!gone) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    await query(
      `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
       VALUES ($1::uuid, 'forum.delete', 'forum', $2::text, '{}'::jsonb, '{}'::jsonb)`,
      [request.user.sub, id]
    )
    return reply.code(204).send()
  })

  // ---- topics ----

  fastify.get('/:slug/topics', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          offset: { type: 'integer', minimum: 0, default: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const { limit = 30, offset = 0 } = request.query as { limit?: number, offset?: number }

    const forum = await queryOne<{ id: string }>('SELECT id FROM forums WHERE slug = $1', [slug])
    if (!forum) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such forum' })

    const data = await query(
      `SELECT t.id, t.title, t.pinned, t.locked, t.post_count, t.last_post_at, t.created_at,
              u.username AS author
         FROM topics t
         JOIN users u ON u.id = t.author_id
        WHERE t.forum_id = $1
        ORDER BY t.pinned DESC, t.last_post_at DESC NULLS LAST, t.created_at DESC
        LIMIT $2 OFFSET $3`,
      [forum.id, limit, offset]
    )
    const total = await queryOne<{ n: string }>('SELECT count(*) AS n FROM topics WHERE forum_id = $1', [forum.id])
    return { data, total: Number(total?.n ?? 0) }
  })

  fastify.post('/:slug/topics', {
    config: WRITE_LIMIT,
    onRequest: fastify.requirePermission('topic.create'),
    schema: {
      body: {
        type: 'object',
        required: ['title', 'body'],
        properties: {
          title: { type: 'string', minLength: 3, maxLength: 200 },
          body: { type: 'string', minLength: 1, maxLength: 20000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const { title, body } = request.body as { title: string, body: string }

    const forum = await queryOne<{ id: string, locked_at: string | null }>(
      'SELECT id, locked_at FROM forums WHERE slug = $1', [slug]
    )
    if (!forum) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such forum' })
    if (forum.locked_at) {
      return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'This forum is locked' })
    }

    // The topic and its first post are one act, so they are one transaction:
    // a topic with no post in it is a row nothing can render.
    const topic = await transaction(async (client: pg.PoolClient) => {
      const { rows } = await client.query(
        `INSERT INTO topics (forum_id, author_id, title, post_count, last_post_at)
         VALUES ($1, $2, $3, 1, now()) RETURNING id, title, created_at`,
        [forum.id, request.user.sub, title]
      )
      await client.query('INSERT INTO posts (topic_id, author_id, body) VALUES ($1, $2, $3)',
        [rows[0]!.id, request.user.sub, body])
      return rows[0]
    })
    return reply.code(201).send(topic)
  })

  fastify.get('/topics/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const topic = await queryOne(
      `SELECT t.id, t.title, t.pinned, t.locked, t.post_count, t.created_at,
              u.username AS author, f.slug AS forum_slug, f.name AS forum_name, f.locked_at AS forum_locked
         FROM topics t
         JOIN users u ON u.id = t.author_id
         JOIN forums f ON f.id = t.forum_id
        WHERE t.id = $1`,
      [id]
    )
    if (!topic) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return topic
  })

  fastify.patch('/topics/:id', {
    // No requirePermission here because the two fields need different grants —
    // see below — but the caller still has to be identified before either can
    // be checked.
    onRequest: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        properties: { pinned: { type: 'boolean' }, locked: { type: 'boolean' } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    // Two grants, one endpoint, checked per field: a moderator may hold `pin`
    // without `lock`, and a request that asks for both must not get one of
    // them through on the strength of the other.
    const body = request.body as { pinned?: boolean, locked?: boolean }
    if (body.pinned !== undefined && !await holds(request, 'topic.pin')) {
      return reply.code(403).send({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Pinning needs the topic.pin permission' })
    }
    if (body.locked !== undefined && !await holds(request, 'topic.lock')) {
      return reply.code(403).send({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Locking needs the topic.lock permission' })
    }

    const { id } = request.params as { id: string }
    const sets: string[] = []
    const params: unknown[] = [id]
    if (body.pinned !== undefined) { params.push(body.pinned); sets.push(`pinned = $${params.length}`) }
    if (body.locked !== undefined) { params.push(body.locked); sets.push(`locked = $${params.length}`) }
    if (!sets.length) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Nothing to change' })

    const topic = await queryOne(`UPDATE topics SET ${sets.join(', ')} WHERE id = $1 RETURNING id, pinned, locked`, params)
    if (!topic) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return topic
  })

  fastify.delete('/topics/:id', {
    onRequest: fastify.requirePermission('topic.delete')
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const gone = await queryOne('DELETE FROM topics WHERE id = $1 RETURNING id', [id])
    if (!gone) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return reply.code(204).send()
  })

  // ---- posts ----

  fastify.get('/topics/:id/posts', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 }
        }
      }
    }
  }, async request => {
    const { id } = request.params as { id: string }
    const { limit = 50, offset = 0 } = request.query as { limit?: number, offset?: number }
    const data = await query(
      `SELECT p.id, p.body, p.created_at, p.edited_at, u.username AS author, p.author_id
         FROM posts p
         JOIN users u ON u.id = p.author_id
        WHERE p.topic_id = $1 AND p.hidden_at IS NULL
        ORDER BY p.created_at
        LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    )
    return { data }
  })

  fastify.post('/topics/:id/posts', {
    config: WRITE_LIMIT,
    onRequest: fastify.requirePermission('post.create'),
    schema: {
      body: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string', minLength: 1, maxLength: 20000 } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { body } = request.body as { body: string }

    const topic = await queryOne<{ id: string, locked: boolean, forum_locked: string | null }>(
      `SELECT t.id, t.locked, f.locked_at AS forum_locked
         FROM topics t JOIN forums f ON f.id = t.forum_id WHERE t.id = $1`,
      [id]
    )
    if (!topic) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such topic' })
    if (topic.locked || topic.forum_locked) {
      return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'This topic is locked' })
    }

    // The post and the topic's counters move together, or the list shows a
    // reply count that does not match the replies.
    const post = await transaction(async (client: pg.PoolClient) => {
      const { rows } = await client.query(
        'INSERT INTO posts (topic_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at',
        [id, request.user.sub, body]
      )
      await client.query('UPDATE topics SET post_count = post_count + 1, last_post_at = now() WHERE id = $1', [id])
      return rows[0]
    })
    return reply.code(201).send(post)
  })

  fastify.patch('/posts/:id', {
    onRequest: fastify.requirePermission('post.edit'),
    schema: {
      body: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string', minLength: 1, maxLength: 20000 } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { body } = request.body as { body: string }

    // `post.edit` is granted to every account, so it means "edit your own".
    // Somebody else's post is a moderation action and needs `post.hide`.
    const own = await queryOne<{ author_id: string }>('SELECT author_id FROM posts WHERE id = $1', [id])
    if (!own) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    if (own.author_id !== request.user.sub && !await holds(request, 'post.hide')) {
      return reply.code(403).send({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'That is not your post' })
    }

    const post = await queryOne(
      'UPDATE posts SET body = $2, edited_at = now() WHERE id = $1 RETURNING id, body, edited_at', [id, body]
    )
    return post
  })

  fastify.delete('/posts/:id', {
    onRequest: fastify.requirePermission('post.delete')
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    // Hidden, not deleted: a thread with holes in it is unreadable, and the
    // moderation queue needs the text it acted on.
    const post = await queryOne<{ topic_id: string }>(
      'UPDATE posts SET hidden_at = now() WHERE id = $1 AND hidden_at IS NULL RETURNING topic_id', [id]
    )
    if (!post) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    await query('UPDATE topics SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1', [post.topic_id])
    return reply.code(204).send()
  })

}

export default routes
