// /v1/anime — catalogue browse, detail, episodes, schedule.
// Public (no auth). Cursor pagination on (sort value, id) keyset.

// `pool` only travels through to the search module, which takes its
// connection as an argument so it can be driven against a scratch database in
// the performance tests. No SQL is written in this file.
import { pool } from '../../infrastructure/database/index.ts'
import { AnimeRepository, animeRepository as animeRepo } from './anime-repository.ts'
import { episodeRepository as episodeRepo } from './episode-repository.ts'
import { SEARCH_SORTS, recordSearch, searchAnime, suggest } from '../search/search.ts'
import { localiseAnime, localiseEpisode } from './localise.ts'
import { requestLanguage, coerce } from '../profiles/preferences.ts'

import type { SearchFilters } from '../search/search.ts'

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
  const anime = await animeRepo.detail(id, locale.language)
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
    if (q.genre) {
      // Bound once and referenced twice, so this cannot go through add(),
      // which substitutes only the first placeholder. The clause itself is a
      // subquery and lives with the rest of the SQL — see AnimeRepository.
      params.push(q.genre)
      where.push(AnimeRepository.genreFilter(params.length))
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
    const rows = await animeRepo.browse({ where, params, sort })

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
    return { data: await animeRepo.schedule(from, to) }
  })

  // ---- search ----
  // Tiered ranking across canonical titles, anime_titles (romaji/english/
  // native) and synonyms, with combinable catalogue filters. See
  // apps/api/src/modules/search/search.ts for the tier definitions.
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

    const rows = await animeRepo.cardsByAnilistIds(wanted)

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

    const row = await animeRepo.byAnilistId(anilistId)
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

    const existing = await animeRepo.mappedIdFor(body.anilistId)
    if (existing) return existing

    // minimal stub row; the metadata importer enriches it later
    return animeRepo.createStub({
      title: body.title,
      format: body.format ?? null,
      status: body.status ?? null,
      episodes: body.episodes ?? null,
      isAdult: body.isAdult ?? null,
      anilistId: body.anilistId
    })
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
    if (!await animeRepo.isVisible(id)) {
      return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }

    const locale = localeOf(request)
    const [data, total] = await Promise.all([
      episodeRepo.listFor(id, locale.language),
      episodeRepo.countFor(id)
    ])
    return { data: data.map(row => localiseEpisode(row, locale.language)), total }
  })

  /**
   * Where this episode can be played from.
   *
   * References, never media: the platform stores a pointer an operator
   * registered and hands it to the player, which is the same thing it does
   * with a source an extension found. Disabled rows are left out — "enabled"
   * is how an operator takes a dead link out of playback without losing the
   * record of which episode it belonged to.
   *
   * Visibility is checked through the episode's anime, not only the episode:
   * publishing an episode under a hidden entry must not make it reachable.
   */
  fastify.get('/episodes/:eid/sources', async (request, reply) => {
    const { eid } = request.params as { eid: string }
    if (!UUID.test(eid)) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    if (!await episodeRepo.isPlayable(eid)) {
      return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }
    return { data: await episodeRepo.sourcesFor(eid) }
  })

  fastify.get('/:id/relations', async (request, reply) => {
    const { id } = request.params as { id: string }
    return { data: await animeRepo.relations(id) }
  })

  /**
   * The opening and ending intervals for one episode.
   *
   * Ours, from `skip_segments` — a table that has been in the schema since
   * migration 0003 with nothing ever reading or writing it. The player used to
   * ask an extension and then call api.aniskip.com from the page directly, so
   * a deployment that had corrected a wrong interval had nowhere to put the
   * correction.
   *
   * Ordered by votes: the table was built for community submissions, and the
   * one people agreed with is the one to offer.
   */
  fastify.get('/episodes/:eid/skips', async (request, reply) => {
    const { eid } = request.params as { eid: string }
    if (!UUID.test(eid)) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return { data: await episodeRepo.skipsFor(eid) }
  })

  /**
   * Subtitle tracks for one episode.
   *
   * `subtitle_tracks` is the same story: in the schema since 0003, written by
   * nothing. A track is either hosted by us (`object_key`) or referenced
   * (`url`); the caller wants one address either way, so both are returned and
   * the client prefers whichever is set.
   */
  fastify.get('/episodes/:eid/subtitles', async (request, reply) => {
    const { eid } = request.params as { eid: string }
    if (!UUID.test(eid)) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return { data: await episodeRepo.subtitlesFor(eid) }
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

    const data = await animeRepo.franchise(id)
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
    return { data: await animeRepo.characters(id) }
  })

  fastify.get('/:id/staff', async request => {
    const { id } = request.params as { id: string }
    return { data: await animeRepo.staff(id) }
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
    return { data: await animeRepo.recommendations(id, limit ?? 20) }
  })
}

export default routes
