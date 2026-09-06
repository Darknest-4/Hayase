// /v1/anime — catalogue browse, detail, episodes, schedule.
// Public (no auth). Cursor pagination on (sort value, id) keyset.

import { pool, query, queryOne } from '../db.ts'
import { SEARCH_SORTS, recordSearch, searchAnime, suggest } from '../lib/search.ts'
import { localiseAnime, localiseEpisode } from '../lib/localise.ts'
import { requestLanguage, coerce } from '../lib/preferences.ts'

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Which language this request wants, and how it wants titles written.
 *
 * Precedence is explicit query parameter, then Accept-Language, then the site
 * default. The viewer's stored preference is applied by the client, which
 * sends it as ?lang= after a switch — the server does not read user_settings
 * on catalogue reads, because these endpoints are public and cacheable and a
 * per-viewer database lookup on every card would undo that.
 */
function localeOf (request: { headers: Record<string, unknown>, query: unknown }): { language: 'hu' | 'en', titles: string } {
  const q = (request.query ?? {}) as { lang?: string, titles?: string }
  return {
    language: requestLanguage({
      explicit: q.lang ?? null,
      header: (request.headers['accept-language'] as string | undefined) ?? null
    }),
    titles: (coerce('language.titles', q.titles) as string) ?? 'romaji'
  }
}

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

/**
 * The full catalogue record for one anime.
 *
 * Extracted from GET /:id so the AniList bridge can answer with the same
 * payload. The client's detail page needs the whole record, and resolving an
 * AniList id to a Yume id and then fetching the record was two round trips for
 * the single most-loaded screen in the app.
 */
async function animeDetail (
  id: string,
  locale: { language: 'hu' | 'en', titles: string } = { language: 'hu', titles: 'romaji' }
): Promise<Record<string, unknown> | undefined> {
  const anime = await queryOne<Record<string, unknown>>(
    `SELECT a.*,
        tr.title    AS title_hu,
        tr.synopsis AS synopsis_hu,
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
       FROM anime a
       LEFT JOIN anime_translations tr
              ON tr.anime_id = a.id AND tr.language = $2 AND tr.approved
      WHERE a.id = $1 AND a.visibility <> 'hidden'`,
    [id, locale.language]
  )
  if (!anime) return anime
  // The tsvector is an implementation detail of search, not part of the record.
  delete anime.search

  // The title forms live in the `titles` jsonb the query above builds; lift
  // the three the resolver knows about so it does not have to know the shape.
  const titles = (anime.titles ?? {}) as Record<string, string>
  return localiseAnime({
    ...anime,
    title_romaji: titles.romaji ?? titles.preferred ?? null,
    title_english: titles.english ?? null,
    title_native: titles.native ?? null
  }, locale)
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
        // The cursor is opaque state the client did not compose, so a stale or
        // malformed one starts from the beginning rather than erroring. But it
        // arrives from the network, so both fields are validated before they
        // reach a query: an id that is not a uuid, or a value that is not a
        // primitive, would otherwise fail the cast and surface as a 500 that
        // anyone could trigger at will.
        const validId = typeof decoded?.id === 'string' && UUID.test(decoded.id)
        const value = decoded?.v ?? null
        const validValue = value === null || typeof value === 'string' || typeof value === 'number'
        if (validId && validValue) cursor = { v: value as string | number | null, id: decoded.id as string }
      } catch {
        // not decodable — same treatment
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
    // Slug OR name, case-insensitively. The client shows genre names and
    // therefore sends "Action"; matching only the slug meant every genre rail
    // on the home page silently returned nothing and fell back to AniList,
    // with the catalogue holding 900 Action titles. A caller should not have
    // to know our slugging rule to ask a question about a genre.
    if (q.genre) {
      // Bound once and referenced twice, so this cannot go through add(),
      // which substitutes only the first placeholder.
      params.push(q.genre)
      const n = params.length
      where.push(`EXISTS (SELECT 1 FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id
                           WHERE ag.anime_id = a.id AND (g.slug = lower($${n}) OR lower(g.name) = lower($${n})))`)
    }

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
              img.object_key AS cover_key, m.anilist_id
       FROM episodes e
       JOIN anime a ON a.id = e.anime_id
       LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
       -- the client links a row by whichever id it has, same rule as everywhere
       LEFT JOIN anime_mappings m ON m.anime_id = a.id
       -- only published episodes: a calendar listing something nobody can
       -- watch yet is worse than one that waits
       WHERE e.air_date >= $1 AND e.air_date < $2
         AND a.visibility = 'public' AND e.visibility = 'public'
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

  /**
   * Look up many catalogue entries by their AniList ids, in one request.
   *
   * The home page resolves whole rails this way — continue-watching,
   * favourites, planning, the sequels of finished shows — because the library
   * stores AniList ids and the rail needs cards. Without a batch route the
   * client had no way to ask the catalogue for a set, so it asked AniList
   * instead, one query for up to fifty titles.
   *
   * Card-shaped rather than full records: a rail draws a cover, a title and a
   * score, and fetching every synonym and tag for fifty titles to render fifty
   * covers would be a large waste on the most-loaded screen in the app.
   *
   * Order follows the ids as given. A rail is usually ordered by something the
   * caller knows and the database does not — most recently watched, say — and
   * re-sorting it here would silently discard that.
   */
  fastify.get('/by-anilist', {
    schema: {
      querystring: {
        type: 'object',
        required: ['ids'],
        properties: {
          // 50 is the largest rail the client builds; the cap is what stops a
          // caller asking for the whole catalogue through this route.
          ids: { type: 'string', maxLength: 600 }
        }
      }
    }
  }, async request => {
    const { ids } = request.query as { ids: string }
    const wanted = [...new Set(
      ids.split(',').map(part => Number(part.trim())).filter(n => Number.isInteger(n) && n > 0)
    )].slice(0, 50)
    if (!wanted.length) return { data: [] }

    const rows = await query<{ anilist_id: number }>(
      `SELECT a.id, m.anilist_id, a.canonical_title, a.format, a.status,
              a.season_year, a.episode_count, a.average_score, a.is_adult,
              t.title AS romaji, te.title AS english,
              img.object_key AS cover_key, img.dominant_color AS cover_color
         FROM anime_mappings m
         JOIN anime a ON a.id = m.anime_id
         LEFT JOIN anime_titles t ON t.anime_id = a.id AND t.kind = 'romaji'
         LEFT JOIN anime_titles te ON te.anime_id = a.id AND te.kind = 'english'
         LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
        WHERE m.anilist_id = ANY($1::int[]) AND a.visibility = 'public'`,
      [wanted]
    )

    const byId = new Map(rows.map(row => [row.anilist_id, row]))
    return { data: wanted.map(id => byId.get(id)).filter(Boolean) }
  })

  /**
   * Look up a catalogue entry by its AniList id.
   *
   * `?full=true` returns the complete record rather than just the mapping.
   * Without it the detail page had to resolve the id and then fetch the
   * record — two round trips on the most-loaded screen in the app, which is
   * exactly the cost that made the client skip the catalogue and call AniList
   * directly instead.
   */
  fastify.get('/by-anilist/:anilistId', {
    schema: {
      params: { type: 'object', properties: { anilistId: { type: 'integer' } } },
      querystring: { type: 'object', properties: { full: { type: 'boolean', default: false } } }
    }
  }, async (request, reply) => {
    const { anilistId } = request.params as { anilistId: number }
    const { full } = request.query as { full?: boolean }

    const row = await queryOne<{ id: string, canonical_title: string }>(
      `SELECT a.id, a.canonical_title FROM anime_mappings m JOIN anime a ON a.id = m.anime_id
       WHERE m.anilist_id = $1 AND a.visibility <> 'hidden'`,
      [anilistId]
    )
    if (!row) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    if (!full) return row

    const anime = await animeDetail(row.id, localeOf(request))
    // The row existed a statement ago; if it does not now it was hidden or
    // deleted between the two, which is a 404 like any other miss.
    if (!anime) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return anime
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
    const anime = await animeDetail(id, localeOf(request))
    if (!anime) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return anime
  })

  /**
   * The published episodes of one anime.
   *
   * Only `public` ones are served. On a Hungarian site the subtitle arrives
   * days after the episode does, so an imported episode must not be offered
   * before somebody publishes it.
   *
   * `total` is the count of episodes we hold regardless of state, and it is
   * load-bearing rather than informational. Without it an empty `data` is
   * ambiguous, and the two meanings need opposite handling:
   *
   *   total = 0   we have no episode data → the client may fall back to
   *               ani.zip, because our silence is ignorance
   *   total > 0   we have episodes and publish none → the client must NOT
   *               fall back, because our silence is a decision
   *
   * Without the distinction, hiding every episode would make the client fetch
   * them from ani.zip and show them anyway — the feature would defeat itself.
   */
  fastify.get('/:id/episodes', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const exists = await queryOne("SELECT 1 FROM anime WHERE id = $1 AND visibility <> 'hidden'", [id])
    if (!exists) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const locale = localeOf(request)
    const [data, counts] = await Promise.all([
      query(
        `SELECT e.id, e.number, e.absolute_number, e.title, e.synopsis, e.thumbnail_key,
                e.air_date, e.duration, e.is_filler, e.is_recap,
                tr.title    AS title_hu,
                tr.synopsis AS synopsis_hu
         FROM episodes e
         LEFT JOIN episode_translations tr
                ON tr.episode_id = e.id AND tr.language = $2 AND tr.approved
         WHERE e.anime_id = $1 AND e.visibility = 'public' ORDER BY e.number`,
        [id, locale.language]
      ),
      queryOne<{ total: string }>('SELECT count(*)::int AS total FROM episodes WHERE anime_id = $1', [id])
    ])
    return { data: data.map(row => localiseEpisode(row, locale.language)), total: Number(counts?.total ?? 0) }
  })

  fastify.get('/:id/relations', async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = await query(
      `SELECT r.relation, a.id, a.canonical_title, a.format, a.status,
              img.object_key AS cover_key, m.anilist_id
       FROM anime_relations r
       JOIN anime a ON a.id = r.related_id
       LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
       -- the client links a related title by whichever id it has; without the
       -- AniList id a catalogue-only relation had nowhere to point
       LEFT JOIN anime_mappings m ON m.anime_id = a.id
       WHERE r.anime_id = $1`,
      [id]
    )
    return { data }
  })

  /**
   * The whole franchise this title belongs to, in the order to watch it.
   *
   * The relations endpoint answers "what is directly attached to this one",
   * which is the question a graph asks. The question a viewer asks is "where
   * does this sit and what comes next" — and answering that means walking past
   * the immediate neighbours: season three does not link to season one.
   *
   * So: an undirected walk over `anime_relations`, depth-capped and
   * count-capped. Franchises are not small — some run to dozens of entries —
   * and an uncapped walk on a well-connected component would return most of
   * the catalogue to draw a sidebar.
   *
   * Ordering is by release date, not by the relation graph. Sequel edges give
   * only a partial order, plenty of them are missing, and every entry that is
   * neither sequel nor prequel — the films, the specials — has no place in
   * that order at all. A date is a total order and is what a viewer means.
   */
  fastify.get('/:id/franchise', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!UUID.test(id)) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const data = await query<{
      id: string, canonical_title: string, format: string, status: string,
      season: string | null, season_year: number | null, start_date: string | null,
      episode_count: number | null, cover_key: string | null, anilist_id: number | null,
      relation: string | null, depth: number
    }>(
      `WITH RECURSIVE walk AS (
         SELECT $1::uuid AS id, 0 AS depth
         UNION
         SELECT CASE WHEN r.anime_id = w.id THEN r.related_id ELSE r.anime_id END, w.depth + 1
           FROM walk w
           JOIN anime_relations r ON r.anime_id = w.id OR r.related_id = w.id
          WHERE w.depth < 2
       ),
       nodes AS (SELECT id, min(depth) AS depth FROM walk GROUP BY id)
       SELECT a.id, a.canonical_title, a.format, a.status, a.season, a.season_year,
              a.start_date, a.episode_count, n.depth,
              img.object_key AS cover_key, m.anilist_id,
              -- the direct edge to the title that was asked about, when there
              -- is one; further out there is no single relation to name
              (SELECT r.relation FROM anime_relations r
                WHERE (r.anime_id = $1 AND r.related_id = a.id)
                   OR (r.related_id = $1 AND r.anime_id = a.id)
                LIMIT 1) AS relation
         FROM nodes n
         JOIN anime a ON a.id = n.id
         LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
         LEFT JOIN anime_mappings m ON m.anime_id = a.id
        WHERE a.visibility = 'public' OR a.id = $1
        ORDER BY a.start_date NULLS LAST, a.season_year NULLS LAST, a.canonical_title
        LIMIT 61`,
      [id]
    )
    if (!data.length) return { data: [], truncated: false }

    // One over the cap means there was more; the list itself stays at the cap.
    const truncated = data.length > 60
    return { data: truncated ? data.slice(0, 60) : data, truncated }
  })

  /*
   * Cast, staff and recommendations.
   *
   * These tables were filled by the AniList deep pass and then read by nobody:
   * there was no endpoint over any of them, so the anime page fell back to
   * "No character data." on every catalogue title however much had been
   * imported. Three small reads rather than one wide one, because the page
   * draws them in separate tabs and most visits open none of them.
   */

  fastify.get('/:id/characters', async request => {
    const { id } = request.params as { id: string }
    // Voices are aggregated per character rather than joined flat: a character
    // with a Japanese and a Hungarian actor is one card with two credits, and
    // a flat join would return the character twice.
    const data = await query(
      `SELECT c.id, c.name, c.native_name, c.image_key, ac.role,
              (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'id', p.id, 'name', p.name, 'nativeName', p.native_name,
                        'imageKey', p.image_key, 'language', cv.language) ORDER BY cv.language), '[]')
                 FROM character_voices cv
                 JOIN people p ON p.id = cv.person_id
                WHERE cv.character_id = c.id AND cv.anime_id = ac.anime_id) AS voices
         FROM anime_characters ac
         JOIN characters c ON c.id = ac.character_id
        WHERE ac.anime_id = $1
        -- MAIN first, then SUPPORTING, then BACKGROUND; the page shows the
        -- top of this list and never paginates it.
        ORDER BY CASE ac.role WHEN 'MAIN' THEN 0 WHEN 'SUPPORTING' THEN 1 ELSE 2 END, c.name`,
      [id]
    )
    return { data }
  })

  fastify.get('/:id/staff', async request => {
    const { id } = request.params as { id: string }
    const data = await query(
      `SELECT p.id, p.name, p.native_name, p.image_key, s.role
         FROM anime_staff s
         JOIN people p ON p.id = s.person_id
        WHERE s.anime_id = $1
        -- Director first: it is the credit anybody scanning the list wants.
        ORDER BY CASE WHEN s.role ILIKE 'director%' THEN 0
                      WHEN s.role ILIKE 'original creator%' THEN 1
                      ELSE 2 END, s.role, p.name`,
      [id]
    )
    return { data }
  })

  fastify.get('/:id/recommendations', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }
      }
    }
  }, async request => {
    const { id } = request.params as { id: string }
    const { limit } = request.query as { limit?: number }
    const data = await query(
      `SELECT a.id, a.canonical_title, a.format::text, a.status::text, a.season_year,
              a.episode_count, a.average_score, r.score,
              img.object_key AS cover_key, m.anilist_id
         FROM anime_recommendations r
         JOIN anime a ON a.id = r.recommended_id
         LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
         LEFT JOIN anime_mappings m ON m.anime_id = a.id
        WHERE r.anime_id = $1 AND a.visibility = 'public'
        ORDER BY r.score DESC, a.popularity DESC NULLS LAST
        LIMIT $2`,
      [id, limit ?? 20]
    )
    return { data }
  })
}

export default routes
