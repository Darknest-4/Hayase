// /v1/profiles — the account's own profile.
//
// This module used to serve a Netflix-style picker: up to six profiles per
// account, each with its own library, history and settings, chosen from a
// "Who's watching?" screen. That feature is gone from the product.
//
// What remains is one profile per account, and it is not a thing anybody
// chooses — it is where the account's rows hang. Every user-data table in this
// schema (library_entries, watch_history, watch_progress, favorites, reviews,
// collections, user_settings, xp_events, …) is keyed on profile_id, so the row
// stays as the account's own identifier; `X-Profile-Id` on the data routes is
// unchanged. Collapsing that column onto user_id would be a rewrite of twenty
// tables to delete a screen, and it would have to merge the accounts that hold
// two profiles today. See database/migrations/0035_single_profile.sql.
//
// So: no create, no delete, no list. Ask for yours, and edit its name, avatar
// and adult-content switch — which are account preferences now, and are edited
// in Settings.

import { query, queryOne } from '../../infrastructure/database/index.ts'

import type { FastifyPluginAsync } from 'fastify'

const COLUMNS = 'id, display_name, avatar_emoji, avatar_key, is_kids, nsfw_enabled, created_at'

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', fastify.authenticate)

  /**
   * The caller's profile, made if it is somehow missing.
   *
   * Registration creates one (auth/repository.ts), so the insert here is for
   * an account that predates that or had its profile removed by hand. It is
   * written as an upsert against the one-per-account index rather than a
   * check-then-insert, because two tabs signing in at once would otherwise
   * race and one of them would get a constraint violation instead of a profile.
   */
  async function mine (userId: string, displayName: string) {
    const existing = await queryOne(`SELECT ${COLUMNS} FROM user_profiles WHERE user_id = $1`, [userId])
    if (existing) return existing
    await query(
      `INSERT INTO user_profiles (user_id, display_name, is_default) VALUES ($1, $2, true)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, displayName.slice(0, 50)]
    )
    return queryOne(`SELECT ${COLUMNS} FROM user_profiles WHERE user_id = $1`, [userId])
  }

  fastify.get('/me', async request => mine(request.user.sub, request.user.username ?? 'Me'))

  fastify.patch('/me', {
    schema: {
      body: {
        type: 'object',
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 50 },
          avatarEmoji: { type: 'string', maxLength: 8 },
          isKids: { type: 'boolean' },
          nsfwEnabled: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const profile = await mine(request.user.sub, request.user.username ?? 'Me')
    if (!profile) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const body = request.body as Record<string, unknown>
    const map: Record<string, string> = {
      displayName: 'display_name',
      avatarEmoji: 'avatar_emoji',
      isKids: 'is_kids',
      nsfwEnabled: 'nsfw_enabled'
    }
    const sets: string[] = []
    const params: unknown[] = [request.user.sub]
    for (const [key, column] of Object.entries(map)) {
      if (body[key] !== undefined) { params.push(body[key]); sets.push(`${column} = $${params.length}`) }
    }
    if (!sets.length) return profile

    return queryOne(
      `UPDATE user_profiles SET ${sets.join(', ')} WHERE user_id = $1 RETURNING ${COLUMNS}`,
      params
    )
  })
}

export default routes
