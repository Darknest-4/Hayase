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

const COLUMNS = `id, display_name, avatar_emoji, avatar_key, banner_key,
                 avatar_anime_id, banner_anime_id, is_kids, nsfw_enabled, created_at,
                 (SELECT a.canonical_title FROM anime a WHERE a.id = user_profiles.avatar_anime_id) AS avatar_from,
                 (SELECT a.canonical_title FROM anime a WHERE a.id = user_profiles.banner_anime_id) AS banner_from`

/**
 * The widest art a title has, for the kind asked for.
 *
 * Covers exist for every title; banners only appear as the AniList enrichment
 * runs, so a banner request falls back to the cover rather than returning
 * nothing. A cover used as a wide backdrop is a compromise; an empty header is
 * a missing feature.
 */
const IMAGE_FOR = `
  SELECT i.object_key FROM anime_images i
   WHERE i.anime_id = $1 AND i.kind = ANY($2::text[])
   ORDER BY array_position($2::text[], i.kind), i.is_primary DESC
   LIMIT 1`

const KINDS = { avatar: ['cover'], banner: ['banner', 'cover'] } as const

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

  /**
   * Pictures to choose from.
   *
   * The viewer's own library first when they have not typed anything: the
   * titles somebody watched are the ones they want on their profile, and a
   * grid of the platform's most popular shows is a worse first screen than a
   * grid of their own. A query searches the whole catalogue instead.
   *
   * Only titles that actually have the art are returned, so nothing in the
   * grid can be picked and then not appear.
   */
  fastify.get('/artwork', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', maxLength: 100 },
          kind: { enum: ['avatar', 'banner'], default: 'avatar' },
          limit: { type: 'integer', minimum: 1, maximum: 60, default: 30 }
        }
      }
    }
  }, async request => {
    const { q, kind = 'avatar', limit = 30 } = request.query as { q?: string, kind?: 'avatar' | 'banner', limit?: number }
    const kinds = [...KINDS[kind]]
    const search = q?.trim()

    if (search) {
      const data = await query(
        `SELECT a.id, a.canonical_title AS title, i.object_key AS image
           FROM anime a
           JOIN LATERAL (
             SELECT object_key FROM anime_images x
              WHERE x.anime_id = a.id AND x.kind = ANY($2::text[])
              ORDER BY array_position($2::text[], x.kind), x.is_primary DESC LIMIT 1
           ) i ON true
          WHERE a.search @@ plainto_tsquery('simple', $1)
          ORDER BY a.popularity DESC
          LIMIT $3`,
        [search, kinds, limit]
      )
      return { data, source: 'search' }
    }

    // No query: the account's own library, newest first.
    const mineFirst = await query(
      `SELECT a.id, a.canonical_title AS title, i.object_key AS image
         FROM library_entries le
         JOIN anime a ON a.id = le.anime_id
         JOIN user_profiles p ON p.id = le.profile_id AND p.user_id = $1
         JOIN LATERAL (
           SELECT object_key FROM anime_images x
            WHERE x.anime_id = a.id AND x.kind = ANY($2::text[])
            ORDER BY array_position($2::text[], x.kind), x.is_primary DESC LIMIT 1
         ) i ON true
        ORDER BY le.updated_at DESC
        LIMIT $3`,
      [request.user.sub, kinds, limit]
    )
    if (mineFirst.length) return { data: mineFirst, source: 'library' }

    // An empty library still needs a grid to look at.
    const popular = await query(
      `SELECT a.id, a.canonical_title AS title, i.object_key AS image
         FROM anime a
         JOIN LATERAL (
           SELECT object_key FROM anime_images x
            WHERE x.anime_id = a.id AND x.kind = ANY($1::text[])
            ORDER BY array_position($1::text[], x.kind), x.is_primary DESC LIMIT 1
         ) i ON true
        WHERE a.visibility = 'public'
        ORDER BY a.popularity DESC
        LIMIT $2`,
      [kinds, limit]
    )
    return { data: popular, source: 'popular' }
  })

  fastify.patch('/me', {
    schema: {
      body: {
        type: 'object',
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 50 },
          avatarEmoji: { type: 'string', maxLength: 8 },
          isKids: { type: 'boolean' },
          nsfwEnabled: { type: 'boolean' },
          // A title, not a URL. The image is looked up here; letting a client
          // post its own address would turn every profile into an arbitrary
          // remote request made by everyone who loads the page.
          avatarAnimeId: { type: ['string', 'null'], format: 'uuid' },
          bannerAnimeId: { type: ['string', 'null'], format: 'uuid' }
        },
        additionalProperties: false
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

    // Artwork: resolve the picture now and store both halves — the title it
    // came from, and the URL every read wants without a join.
    for (const [key, kind] of [['avatarAnimeId', 'avatar'], ['bannerAnimeId', 'banner']] as const) {
      if (body[key] === undefined) continue
      const animeId = body[key]
      const column = kind === 'avatar' ? 'avatar' : 'banner'

      if (animeId === null) {
        sets.push(`${column}_key = NULL`, `${column}_anime_id = NULL`)
        continue
      }

      const image = await queryOne<{ object_key: string }>(IMAGE_FOR, [animeId, [...KINDS[kind]]])
      if (!image) {
        return reply.code(404).send({
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: `That title has no ${kind === 'avatar' ? 'cover' : 'artwork'} to use`
        })
      }
      params.push(image.object_key, animeId)
      sets.push(`${column}_key = $${params.length - 1}`, `${column}_anime_id = $${params.length}`)
    }

    if (!sets.length) return profile

    return queryOne(
      `UPDATE user_profiles SET ${sets.join(', ')} WHERE user_id = $1 RETURNING ${COLUMNS}`,
      params
    )
  })

}

export default routes
