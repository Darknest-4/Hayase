// /v1/anime — catalogue browse, detail, episodes, schedule.
// Public (no auth). Cursor pagination on (sort value, id) keyset.

import { pool, query, queryOne } from '../db.ts'
import { SEARCH_SORTS, recordSearch, searchAnime, suggest } from '../lib/search.ts'

import type { SearchFilters } from '../lib/search.ts'

import type { FastifyPluginAsync } from 'fastify'

/**
 * Browse orderings, as keyset components rather than raw ORDER BY strings.
 *
 * Pagination used to base64-encode an OFFSET and call it a cursor, which meant
 * Postgres re-read and discarded every skipped row: page 200 costs 200 pages of
 * work. Keyset pagination carries the last row's sort value and id instead, so
 * every page costs the same regardless of depth.
 *
 * `nulls` records where NULLs sort, because the comparison has to reproduce it,
 * and `cast` is the column's type — a cursor value arrives as JSON, so it has
 * to be cast back to the column's type or the comparison operator will not
 * exist (date < text).
 */
const SORTS = {
  popularity: { column: 'a.popularity', dir: 'DESC', nulls: 'LAST', cast: 'numeric' },
  trending: { column: 'a.trending', dir: 'DESC', nulls: 'LAST', cast: 'numeric' },
  score: { column: 'a.average_score', dir: 'DESC', nulls: 'LAST', cast: 'numeric' },
  newest: { column: 'a.start_date', dir: 'DESC', nulls: 'LAST', cast: 'date' },
  title: { column: 'a.canonical_title', dir: 'ASC', nulls: 'LAST', cast: 'text' }
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

    // { v: last sort value, id: last row id } — opaque to the client, but a
    // position in the ordering rather than a count of rows to throw away.
    let cursor: { v: string | number | null, id: string } | undefined
    if (q.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(q.cursor, 'base64url').toString()) as { v: unknown, id: unknown }
        if (typeof decoded?.id === 'string') {
          cursor = { v: (decoded.v as string | number | null) ?? null, id: decoded.id }
        }
      } catch {
        // A malformed cursor starts from the beginning rather than 400ing: it
        // is opaque state the client did not compose, and a stale one is not
        // the user's mistake.
      }
    }

    const where: string[] = []
    const params: unknown[] = []
    const add = (clause: string, value: unknown): void => {
      params.push(value)
      where.push(clause.replace('?', `$${params.length}`))
    }

    where.push("a.visibility = 'public'") // hidden/unlisted stay out of browse
    if (!q.nsfw) where.push('NOT a.is_adult')
    if (q.season) add('a.season = ?', q.season)
    if (q.year) add('a.season_year = ?', q.year)
    if (q.format) add('a.format = ?', q.format)
    if (q.status) add('a.status = ?', q.status)
    if (q.genre) add('EXISTS (SELECT 1 FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.anime_id = a.id AND g.slug = ?)', q.genre)

    if (cursor) {
      // Strictly "after" the last row in this ordering.
      const compare = sort.dir === 'DESC' ? '<' : '>'
      if (cursor.v === null) {
        // NULLs sort last, so a NULL cursor has already passed every non-NULL
        // row and only the id tiebreak remains. The value parameter is not
        // bound at all here — an unreferenced parameter leaves Postgres unable
        // to infer its type.
        params.push(cursor.id)
        where.push(`(${sort.column} IS NULL AND a.id > $${params.length}::uuid)`)
      } else {
        params.push(cursor.v, cursor.id)
        const value = `$${params.length - 1}::${sort.cast}`
        const id = `$${params.length}::uuid`
        where.push(`(${sort.column} ${compare} ${value} OR ${sort.column} IS NULL
                     OR (${sort.column} = ${value} AND a.id > ${id}))`)
      }
    }

    params.push(limit + 1)
    const rows = await query(
      `SELECT a.id, a.canonical_title, a.format, a.status, a.season, a.season_year,
              a.episode_count, a.average_score, a.popularity, a.is_adult,
              ${sort.column} AS sort_value,
              img.object_key AS cover_key, img.blurhash, img.dominant_color
       FROM anime a
       LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
       WHERE ${where.join(' AND ')}
       ORDER BY ${sort.column} ${sort.dir} NULLS ${sort.nulls}, a.id
       LIMIT $${params.length}`,
      params
    )

    const hasMore = rows.length > limit
    const data = rows.slice(0, limit)
    const last = data[data.length - 1]

    // Read the cursor key BEFORE stripping it: slice() shares the row objects,
    // so deleting the field from `data` also removes it from `rows`.
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ v: last.sort_value ?? null, id: last.id })).toString('base64url')
      : null

    // sort_value is the pagination key, not part of the resource
    for (const row of data) delete (row as Record<string, unknown>).sort_value

    return { data, nextCursor }
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
       WHERE e.air_date >= $1 AND e.air_date < $2 AND a.visibility = 'public'
       ORDER BY e.air_date`,
      [from, to]
    )
    return { data }
  })

  // ---- search ----
  // Tiered ranking across canonical titles, anime_titles (romaji/english/
  // native) and synonyms, with combinable catalogue filters. See
  // server/src/lib/search.ts for the tier definitions.
  fastify.get('/search', {
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string', minLength: 1, maxLength: 200 },
          genre: { type: 'string', maxLength: 40 },
          year: { type: 'integer', minimum: 1917, maximum: 2100 },
          season: { enum: ['WINTER', 'SPRING', 'SUMMER', 'FALL'] },
          format: { enum: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'] },
          status: { enum: ['NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS'] },
          sort: { enum: Object.keys(SEARCH_SORTS), default: 'relevance' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          offset: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
          nsfw: { type: 'boolean', default: false }
        }
      }
    }
  }, async request => {
    const { q, ...filters } = request.query as { q: string } & SearchFilters
    const data = await searchAnime(pool, q, filters)
    // telemetry is fire-and-forget: a zero-result query is a catalogue gap
    // worth reporting, but recording it must never delay the response
    void recordSearch(pool, q, data.length, request.headers['x-profile-id'] as string | undefined)
    return { data, query: q }
  })

  // Quick-search box: same ranking, minimal payload, no telemetry (it fires
  // on every keystroke — storing those would be noise, not signal).
  fastify.get('/suggest', {
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string', minLength: 1, maxLength: 100 },
          limit: { type: 'integer', minimum: 1, maximum: 15, default: 8 },
          nsfw: { type: 'boolean', default: false }
        }
      }
    }
  }, async request => {
    const { q, limit, nsfw } = request.query as { q: string, limit?: number, nsfw?: boolean }
    return { data: await suggest(pool, q, limit, nsfw) }
  })

  // ---- AniList id bridge ----
  // The web client browses AniList ids until the catalogue import lands.
  // These endpoints map anilist_id → Yume anime id so platform features
  // (comments, library sync) can attach to catalogue rows.

  fastify.get('/by-anilist/:anilistId', {
    schema: { params: { type: 'object', properties: { anilistId: { type: 'integer' } } } }
  }, async (request, reply) => {
    const { anilistId } = request.params as { anilistId: number }
    const row = await queryOne<{ id: string, canonical_title: string }>(
      `SELECT a.id, a.canonical_title FROM anime_mappings m JOIN anime a ON a.id = m.anime_id
       WHERE m.anilist_id = $1 AND a.visibility <> 'hidden'`,
      [anilistId]
    )
    if (!row) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return row
  })

  fastify.post('/resolve', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['anilistId', 'title'],
        properties: {
          anilistId: { type: 'integer', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 500 },
          format: { enum: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'] },
          status: { enum: ['NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS'] },
          episodes: { type: 'integer', minimum: 0 },
          isAdult: { type: 'boolean' }
        }
      }
    }
  }, async request => {
    const body = request.body as { anilistId: number, title: string, format?: string, status?: string, episodes?: number, isAdult?: boolean }

    const existing = await queryOne<{ id: string }>(
      'SELECT anime_id AS id FROM anime_mappings WHERE anilist_id = $1',
      [body.anilistId]
    )
    if (existing) return existing

    // minimal stub row; the metadata importer enriches it later
    const created = await queryOne<{ id: string }>(
      `WITH new_anime AS (
         INSERT INTO anime (canonical_title, format, status, episode_count, is_adult)
         VALUES ($1, coalesce($2, 'TV')::anime_format, coalesce($3, 'FINISHED')::anime_status, $4, coalesce($5, false))
         RETURNING id
       )
       INSERT INTO anime_mappings (anime_id, anilist_id)
       SELECT id, $6 FROM new_anime
       RETURNING anime_id AS id`,
      [body.title, body.format ?? null, body.status ?? null, body.episodes ?? null, body.isAdult ?? null, body.anilistId]
    )
    return created
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
       FROM anime a WHERE a.id = $1 AND a.visibility <> 'hidden'`,
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
    const exists = await queryOne("SELECT 1 FROM anime WHERE id = $1 AND visibility <> 'hidden'", [id])
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
