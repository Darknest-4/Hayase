// /v1/profiles — per-account watch profiles (Netflix-style). Each profile
// scopes its own library, history, progress and settings (via X-Profile-Id
// on the data routes). One profile is always the default; the last profile
// cannot be deleted.

import { query, queryOne, transaction } from '../db.ts'

import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.get('/', async request => {
    const data = await query(
      `SELECT id, display_name, avatar_emoji, avatar_key, is_default, is_kids, nsfw_enabled, created_at
       FROM user_profiles WHERE user_id = $1 ORDER BY is_default DESC, created_at`,
      [request.user.sub]
    )
    return { data }
  })

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['displayName'],
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 50 },
          avatarEmoji: { type: 'string', maxLength: 8 },
          isKids: { type: 'boolean', default: false },
          nsfwEnabled: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const b = request.body as { displayName: string, avatarEmoji?: string, isKids?: boolean, nsfwEnabled?: boolean }

    const count = await queryOne<{ n: string }>('SELECT count(*) AS n FROM user_profiles WHERE user_id = $1', [request.user.sub])
    if (Number(count?.n ?? 0) >= 6) {
      return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Maximum 6 profiles per account' })
    }

    const isFirst = Number(count?.n ?? 0) === 0
    const profile = await queryOne(
      `INSERT INTO user_profiles (user_id, display_name, avatar_emoji, is_default, is_kids, nsfw_enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, display_name, avatar_emoji, is_default, is_kids, nsfw_enabled, created_at`,
      [request.user.sub, b.displayName, b.avatarEmoji ?? null, isFirst, b.isKids ?? false, b.nsfwEnabled ?? false]
    )
    return reply.code(201).send(profile)
  })

  // helper: ensure the profile belongs to the caller
  async function owned (userId: string, id: string): Promise<boolean> {
    return !!(await queryOne('SELECT 1 FROM user_profiles WHERE id = $1 AND user_id = $2', [id, userId]))
  }

  fastify.patch('/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 50 },
          avatarEmoji: { type: 'string', maxLength: 8 },
          isKids: { type: 'boolean' },
          nsfwEnabled: { type: 'boolean' },
          makeDefault: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!await owned(request.user.sub, id)) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const b = request.body as Record<string, unknown>
    const map: Record<string, string> = { displayName: 'display_name', avatarEmoji: 'avatar_emoji', isKids: 'is_kids', nsfwEnabled: 'nsfw_enabled' }
    const sets: string[] = []
    const params: unknown[] = [id]
    for (const [key, col] of Object.entries(map)) {
      if (b[key] !== undefined) { params.push(b[key]); sets.push(`${col} = $${params.length}`) }
    }

    const profile = await transaction(async client => {
      if (b.makeDefault === true) {
        await client.query('UPDATE user_profiles SET is_default = false WHERE user_id = $1', [request.user.sub])
        sets.push('is_default = true')
      }
      if (!sets.length) return queryOne('SELECT id, display_name, avatar_emoji, is_default, is_kids, nsfw_enabled FROM user_profiles WHERE id = $1', [id])
      const { rows } = await client.query(
        `UPDATE user_profiles SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, display_name, avatar_emoji, is_default, is_kids, nsfw_enabled`,
        params
      )
      return rows[0]
    })
    return profile
  })

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!await owned(request.user.sub, id)) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const count = await queryOne<{ n: string }>('SELECT count(*) AS n FROM user_profiles WHERE user_id = $1', [request.user.sub])
    if (Number(count?.n ?? 0) <= 1) {
      return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Cannot delete the last profile' })
    }

    await transaction(async client => {
      const wasDefault = await client.query<{ is_default: boolean }>('SELECT is_default FROM user_profiles WHERE id = $1', [id])
      await client.query('DELETE FROM user_profiles WHERE id = $1', [id])
      if (wasDefault.rows[0]?.is_default) {
        // promote the oldest remaining profile to default
        await client.query(
          `UPDATE user_profiles SET is_default = true WHERE id = (
             SELECT id FROM user_profiles WHERE user_id = $1 ORDER BY created_at LIMIT 1
           )`,
          [request.user.sub]
        )
      }
    })
    return reply.code(204).send()
  })
}

export default routes
