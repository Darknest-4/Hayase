// /v1/anime — catalogue browse, detail, episodes, schedule.
// Public (no auth). Cursor pagination on (sort value, id) keyset.

import { query, queryOne } from '../db.ts'

import type { FastifyPluginAsync } from 'fastify'

const SORTS = {
  popularity: 'a.popularity DESC',
  trending: 'a.trending DESC',
  score: 'a.average_score DESC NULLS LAST',
  newest: 'a.start_date DESC NULLS LAST',
  title: 'a.canonical_title ASC'
} as const

interface BrowseQuery {
  season?: string
  year?: number
  genre?: string
  format?: string
  status?: string
  sort?: keyof typeof SORTS
  limit?: number
  cursor?: string
  nsfw?: boolean
}

const routes: FastifyPluginAsync = async fastify => {
  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          season: { enum: ['WINTER', 'SPRING', 'SUMMER', 'FALL'] },
          year: { type: 'integer', minimum: 1917, maximum: 2100 },
          genre: { type: 'string', maxLength: 40 },
          format: { enum: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'] },
          status: { enum: ['NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS'] },
          sort: { enum: Object.keys(SORTS) },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
          cursor: { type: 'string' },
          nsfw: { type: 'boolean', default: false }
        }
      }
    }
  }, async request => {
    const q = request.query as BrowseQuery
    const sort = SORTS[q.sort ?? 'popularity']
    const limit = q.limit ?? 25
    const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) || 0 : 0

    const where: string[] = []
    const params: unknown[] = []
    const add = (clause: string, value: unknown): void => {
      params.push(value)
      where.push(clause.replace('?', `$${params.length}`))
    }

    if (!q.nsfw) where.push('NOT a.is_adult')
    if (q.season) add('a.season = ?', q.season)
    if (q.year) add('a.season_year = ?', q.year)
    if (q.format) add('a.format = ?', q.format)
    if (q.status) add('a.status = ?', q.status)
    if (q.genre) add('EXISTS (SELECT 1 FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.anime_id = a.id AND g.slug = ?)', q.genre)

    params.push(limit + 1, offset)
    const rows = await query(
      `SELECT a.id, a.canonical_title, a.format, a.status, a.season, a.season_year,
              a.episode_count, a.average_score, a.popularity, a.is_adult,
              img.object_key AS cover_key, img.blurhash, img.dominant_color
       FROM anime a
       LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${sort}, a.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const hasMore = rows.length > limit
    return {
      data: rows.slice(0, limit),
      nextCursor: hasMore ? Buffer.from(String(offset + limit)).toString('base64url') : null
    }
  })

  fastify.get('/schedule', {
    schema: {
      querystring: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' }
        }
      }
    }
  }, async request => {
    const { from, to } = request.query as { from: string, to: string }
    const data = await query(
      `SELECT e.id AS episode_id, e.number AS episode, e.air_date,
              a.id AS anime_id, a.canonical_title, a.format, a.is_adult,
              img.object_key AS cover_key
       FROM episodes e
       JOIN anime a ON a.id = e.anime_id
       LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
       WHERE e.air_date >= $1 AND e.air_date < $2
       ORDER BY e.air_date`,
      [from, to]
    )
    return { data }
  })

  fastify.get('/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const anime = await queryOne(
      `SELECT a.*,
        (SELECT jsonb_object_agg(t.kind, t.title) FROM anime_titles t WHERE t.anime_id = a.id) AS titles,
        (SELECT coalesce(jsonb_agg(s.synonym), '[]') FROM anime_synonyms s WHERE s.anime_id = a.id) AS synonyms,
        (SELECT coalesce(jsonb_agg(g.name ORDER BY g.name), '[]') FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.anime_id = a.id) AS genres,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('name', tg.name, 'rank', at.rank) ORDER BY at.rank DESC), '[]')
           FROM anime_tags at JOIN tags tg ON tg.id = at.tag_id WHERE at.anime_id = a.id) AS tags,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'role', ac.role, 'isMain', ac.is_main)), '[]')
           FROM anime_companies ac JOIN companies c ON c.id = ac.company_id WHERE ac.anime_id = a.id) AS companies,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'key', i.object_key, 'blurhash', i.blurhash, 'color', i.dominant_color)), '[]')
           FROM anime_images i WHERE i.anime_id = a.id AND i.is_primary) AS images,
        (SELECT to_jsonb(m) - 'anime_id' FROM anime_mappings m WHERE m.anime_id = a.id) AS mappings
       FROM anime a WHERE a.id = $1`,
      [id]
    )

    if (!anime) {
      return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }
    delete (anime as Record<string, unknown>).search
    return anime
  })

  fastify.get('/:id/episodes', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const exists = await queryOne('SELECT 1 FROM anime WHERE id = $1', [id])
    if (!exists) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const data = await query(
      `SELECT id, number, absolute_number, title, synopsis, thumbnail_key,
              air_date, duration, is_filler, is_recap
       FROM episodes WHERE anime_id = $1 ORDER BY number`,
      [id]
    )
    return { data }
  })

  fastify.get('/:id/relations', async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = await query(
      `SELECT r.relation, a.id, a.canonical_title, a.format, a.status,
              img.object_key AS cover_key
       FROM anime_relations r
       JOIN anime a ON a.id = r.related_id
       LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
       WHERE r.anime_id = $1`,
      [id]
    )
    return { data }
  })
}

export default routes
