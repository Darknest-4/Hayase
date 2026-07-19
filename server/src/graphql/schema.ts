// GraphQL layer (mercurius). Resolvers call the same SQL/service patterns
// as the REST routes — GraphQL composes them, it does not own logic.
// Child collections (titles, genres, images, mappings) use mercurius
// loaders so nested queries stay free of N+1s.

import { query, queryOne } from '../db.ts'

import type { MercuriusContext, MercuriusLoaders, IResolvers } from 'mercurius'

export const schema = /* GraphQL */ `
  enum Format { TV TV_SHORT MOVIE SPECIAL OVA ONA MUSIC }
  enum Status { NOT_YET_RELEASED RELEASING FINISHED CANCELLED HIATUS }
  enum Season { WINTER SPRING SUMMER FALL }
  enum LibraryStatus { WATCHING PLANNING COMPLETED PAUSED DROPPED REWATCHING }
  enum AnimeSort { POPULARITY TRENDING SCORE NEWEST TITLE }

  type Titles { romaji: String english: String native: String preferred: String }
  type Image { key: String blurhash: String color: String }
  type ExternalIds { anilist: Int mal: Int anidb: Int kitsu: Int tvdb: Int tmdb: Int imdb: String }
  type RankedTag { name: String! rank: Int! }

  type Anime {
    id: ID!
    canonicalTitle: String!
    format: Format!
    status: Status!
    season: Season
    seasonYear: Int
    episodeCount: Int
    episodeDuration: Int
    synopsis: String
    averageScore: Float
    popularity: Int!
    trending: Int!
    isAdult: Boolean!
    titles: Titles!
    synonyms: [String!]!
    genres: [String!]!
    tags: [RankedTag!]!
    cover: Image
    mappings: ExternalIds
    episodes: [Episode!]!
    relations: [Relation!]!
    viewerEntry: LibraryEntry
  }

  type Episode {
    id: ID!
    number: Float!
    title: String
    synopsis: String
    airDate: String
    duration: Int
    isFiller: Boolean!
    isRecap: Boolean!
  }

  type Relation { relation: String!, node: Anime! }

  type AnimePage { data: [Anime!]!, nextCursor: String }

  type AiringEpisode { episodeId: ID!, animeId: ID!, episode: Float!, airingAt: String!, anime: Anime! }

  type LibraryEntry {
    animeId: ID!
    status: LibraryStatus!
    progress: Int!
    score: Float
    rewatches: Int!
    updatedAt: String!
    anime: Anime!
  }

  type WatchProgress {
    episodeId: ID!
    animeId: ID!
    positionSec: Float!
    durationSec: Float
    completed: Boolean!
    updatedAt: String!
    anime: Anime!
  }

  type ProfileStats {
    xpTotal: Int!
    level: Int!
    minutesWatched: Int!
    episodesWatched: Int!
    animeCompleted: Int!
    meanScore: Float
  }

  type Notification {
    id: ID!
    type: String!
    payload: String!
    readAt: String
    createdAt: String!
  }

  type Viewer {
    id: ID!
    username: String!
    library(status: LibraryStatus): [LibraryEntry!]!
    continueWatching: [WatchProgress!]!
    notifications(unreadOnly: Boolean = false, limit: Int = 25): [Notification!]!
    stats: ProfileStats
  }

  type Extension {
    slug: String!
    name: String!
    summary: String!
    type: String!
    accuracy: String!
    installCount: Int!
    ratingAvg: Float
    ratingCount: Int!
    developer: String!
    developerVerified: Boolean!
    latestVersion: String
  }

  type Query {
    anime(id: ID!): Anime
    animePage(season: Season, year: Int, genre: String, format: Format, status: Status, sort: AnimeSort = POPULARITY, limit: Int = 25, cursor: String, nsfw: Boolean = false): AnimePage!
    search(query: String!, limit: Int = 10, nsfw: Boolean = false): [Anime!]!
    schedule(from: String!, to: String!): [AiringEpisode!]!
    extensionPage(type: String, sort: String = "installs", limit: Int = 25): [Extension!]!
    me: Viewer
  }

  type Mutation {
    saveLibraryEntry(animeId: ID!, status: LibraryStatus, progress: Int, score: Float): LibraryEntry!
    deleteLibraryEntry(animeId: ID!): Boolean!
    saveProgress(episodeId: ID!, positionSec: Float!, durationSec: Float): WatchProgress!
    markNotificationsRead(ids: [ID!]!): Int!
  }
`

interface Ctx extends MercuriusContext {
  userId?: string
  username?: string
  profileId?: string
}

const SORTS: Record<string, string> = {
  POPULARITY: 'a.popularity DESC',
  TRENDING: 'a.trending DESC',
  SCORE: 'a.average_score DESC NULLS LAST',
  NEWEST: 'a.start_date DESC NULLS LAST',
  TITLE: 'a.canonical_title ASC'
}

const ANIME_COLS = `a.id, a.canonical_title, a.format, a.status, a.season, a.season_year,
  a.episode_count, a.episode_duration, a.synopsis, a.average_score, a.popularity, a.trending, a.is_adult`

interface AnimeRow {
  id: string
  canonical_title: string
  format: string
  status: string
  season: string | null
  season_year: number | null
  episode_count: number | null
  episode_duration: number | null
  synopsis: string | null
  average_score: string | null
  popularity: number
  trending: number
  is_adult: boolean
}

const mapAnime = (row: AnimeRow) => ({
  id: row.id,
  canonicalTitle: row.canonical_title,
  format: row.format,
  status: row.status,
  season: row.season,
  seasonYear: row.season_year,
  episodeCount: row.episode_count,
  episodeDuration: row.episode_duration,
  synopsis: row.synopsis,
  averageScore: row.average_score == null ? null : Number(row.average_score),
  popularity: row.popularity,
  trending: row.trending,
  isAdult: row.is_adult
})

async function requireProfile (ctx: Ctx): Promise<string> {
  if (!ctx.userId) throw new Error('Unauthorized')
  if (ctx.profileId) return ctx.profileId
  const profile = await queryOne<{ id: string }>(
    'SELECT id FROM user_profiles WHERE user_id = $1 ORDER BY is_default DESC LIMIT 1',
    [ctx.userId]
  )
  if (!profile) throw new Error('Account has no profile')
  ctx.profileId = profile.id
  return profile.id
}

const mapEntry = (row: Record<string, unknown>) => ({
  animeId: row.anime_id,
  status: row.status,
  progress: row.progress,
  score: row.score == null ? null : Number(row.score),
  rewatches: row.rewatches ?? 0,
  updatedAt: row.updated_at
})

export const resolvers: IResolvers = {
  Query: {
    async anime (_root, args: { id: string }) {
      const row = await queryOne<AnimeRow>(`SELECT ${ANIME_COLS} FROM anime a WHERE a.id = $1`, [args.id])
      return row ? mapAnime(row) : null
    },

    async animePage (_root, args: { season?: string, year?: number, genre?: string, format?: string, status?: string, sort: string, limit: number, cursor?: string, nsfw: boolean }) {
      const where: string[] = []
      const params: unknown[] = []
      const add = (clause: string, value: unknown): void => {
        params.push(value)
        where.push(clause.replace('?', `$${params.length}`))
      }
      if (!args.nsfw) where.push('NOT a.is_adult')
      if (args.season) add('a.season = ?', args.season)
      if (args.year) add('a.season_year = ?', args.year)
      if (args.format) add('a.format = ?', args.format)
      if (args.status) add('a.status = ?', args.status)
      if (args.genre) add('EXISTS (SELECT 1 FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.anime_id = a.id AND g.slug = ?)', args.genre)

      const limit = Math.min(args.limit, 50)
      const offset = args.cursor ? Number(Buffer.from(args.cursor, 'base64url').toString()) || 0 : 0
      params.push(limit + 1, offset)

      const rows = await query<AnimeRow>(
        `SELECT ${ANIME_COLS} FROM anime a
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY ${SORTS[args.sort] ?? SORTS.POPULARITY}, a.id
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      )
      const hasMore = rows.length > limit
      return {
        data: rows.slice(0, limit).map(mapAnime),
        nextCursor: hasMore ? Buffer.from(String(offset + limit)).toString('base64url') : null
      }
    },

    // full-text + typo-tolerant search over tsvector and trigram indexes,
    // checking synonyms as well — the OpenSearch fallback path from the docs
    async search (_root, args: { query: string, limit: number, nsfw: boolean }) {
      const rows = await query<AnimeRow>(
        `SELECT DISTINCT ON (a.id) ${ANIME_COLS},
                greatest(
                  similarity(a.canonical_title, $1),
                  coalesce((SELECT max(similarity(s.synonym, $1)) FROM anime_synonyms s WHERE s.anime_id = a.id), 0)
                ) AS sim,
                ts_rank(a.search, websearch_to_tsquery('simple', $1)) AS rank
         FROM anime a
         WHERE (${args.nsfw ? 'true' : 'NOT a.is_adult'})
           AND (a.search @@ websearch_to_tsquery('simple', $1)
                OR a.canonical_title % $1
                OR EXISTS (SELECT 1 FROM anime_synonyms s WHERE s.anime_id = a.id AND s.synonym % $1))
         ORDER BY a.id, sim DESC
         LIMIT 200`,
        [args.query]
      )
      return rows
        .sort((x, y) => Number((y as unknown as { sim: number }).sim) - Number((x as unknown as { sim: number }).sim))
        .slice(0, Math.min(args.limit, 50))
        .map(mapAnime)
    },

    async schedule (_root, args: { from: string, to: string }) {
      const rows = await query(
        `SELECT e.id AS episode_id, e.anime_id, e.number, e.air_date
         FROM episodes e WHERE e.air_date >= $1 AND e.air_date < $2 ORDER BY e.air_date`,
        [args.from, args.to]
      )
      return rows.map(row => ({
        episodeId: row.episode_id,
        animeId: row.anime_id,
        episode: Number(row.number),
        airingAt: row.air_date
      }))
    },

    async extensionPage (_root, args: { type?: string, sort: string, limit: number }) {
      const order = args.sort === 'rating' ? 'e.rating_avg DESC NULLS LAST' : args.sort === 'new' ? 'e.created_at DESC' : 'e.install_count DESC'
      const params: unknown[] = []
      if (args.type) params.push(args.type)
      params.push(Math.min(args.limit, 50))
      const rows = await query(
        `SELECT e.slug, e.name, e.summary, e.type, e.accuracy, e.install_count, e.rating_avg, e.rating_count,
                d.display_name, d.verified,
                (SELECT version FROM extension_versions WHERE extension_id = e.id AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1) AS latest_version
         FROM extensions e JOIN extension_developers d ON d.user_id = e.owner_id
         WHERE e.status = 'published' ${args.type ? 'AND e.type = $1' : ''}
         ORDER BY ${order} LIMIT $${params.length}`,
        params
      )
      return rows.map(row => ({
        slug: row.slug,
        name: row.name,
        summary: row.summary,
        type: row.type,
        accuracy: row.accuracy,
        installCount: row.install_count,
        ratingAvg: row.rating_avg == null ? null : Number(row.rating_avg),
        ratingCount: row.rating_count,
        developer: row.display_name,
        developerVerified: row.verified,
        latestVersion: row.latest_version
      }))
    },

    me (_root, _args, ctx: Ctx) {
      if (!ctx.userId) return null
      return { id: ctx.userId, username: ctx.username }
    }
  },

  Viewer: {
    async library (_viewer, args: { status?: string }, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      const params: unknown[] = [profileId]
      if (args.status) params.push(args.status)
      const rows = await query(
        `SELECT anime_id, status, progress, score, rewatches, updated_at
         FROM library_entries WHERE profile_id = $1 ${args.status ? 'AND status = $2' : ''}
         ORDER BY updated_at DESC`,
        params
      )
      return rows.map(mapEntry)
    },

    async continueWatching (_viewer, _args, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      const rows = await query(
        `SELECT episode_id, anime_id, position_sec, duration_sec, completed, updated_at
         FROM watch_progress WHERE profile_id = $1 AND NOT completed
         ORDER BY updated_at DESC LIMIT 20`,
        [profileId]
      )
      return rows.map(row => ({
        episodeId: row.episode_id,
        animeId: row.anime_id,
        positionSec: Number(row.position_sec),
        durationSec: row.duration_sec == null ? null : Number(row.duration_sec),
        completed: row.completed,
        updatedAt: row.updated_at
      }))
    },

    async notifications (_viewer, args: { unreadOnly: boolean, limit: number }, ctx: Ctx) {
      const rows = await query(
        `SELECT id, type, payload, read_at, created_at FROM notifications
         WHERE user_id = $1 ${args.unreadOnly ? 'AND read_at IS NULL' : ''}
         ORDER BY created_at DESC LIMIT $2`,
        [ctx.userId, Math.min(args.limit, 100)]
      )
      return rows.map(row => ({
        id: row.id,
        type: row.type,
        payload: JSON.stringify(row.payload),
        readAt: row.read_at,
        createdAt: row.created_at
      }))
    },

    async stats (_viewer, _args, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      const row = await queryOne(
        'SELECT xp_total, level, minutes_watched, episodes_watched, anime_completed, mean_score FROM profile_stats WHERE profile_id = $1',
        [profileId]
      )
      if (!row) return null
      return {
        xpTotal: Number(row.xp_total),
        level: row.level,
        minutesWatched: Number(row.minutes_watched),
        episodesWatched: row.episodes_watched,
        animeCompleted: row.anime_completed,
        meanScore: row.mean_score == null ? null : Number(row.mean_score)
      }
    }
  },

  LibraryEntry: {
    async anime (entry: { animeId: string }) {
      const row = await queryOne<AnimeRow>(`SELECT ${ANIME_COLS} FROM anime a WHERE a.id = $1`, [entry.animeId])
      return row ? mapAnime(row) : null
    }
  },

  WatchProgress: {
    async anime (progress: { animeId: string }) {
      const row = await queryOne<AnimeRow>(`SELECT ${ANIME_COLS} FROM anime a WHERE a.id = $1`, [progress.animeId])
      return row ? mapAnime(row) : null
    }
  },

  AiringEpisode: {
    async anime (airing: { animeId: string }) {
      const row = await queryOne<AnimeRow>(`SELECT ${ANIME_COLS} FROM anime a WHERE a.id = $1`, [airing.animeId])
      return row ? mapAnime(row) : null
    }
  },

  Mutation: {
    async saveLibraryEntry (_root, args: { animeId: string, status?: string, progress?: number, score?: number }, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      const anime = await queryOne<{ episode_count: number | null }>('SELECT episode_count FROM anime WHERE id = $1', [args.animeId])
      if (!anime) throw new Error('Unknown anime')

      let status = args.status
      if (!status && args.progress != null && anime.episode_count && args.progress >= anime.episode_count) status = 'COMPLETED'

      const row = await queryOne(
        `INSERT INTO library_entries (profile_id, anime_id, status, progress, score)
         VALUES ($1, $2, coalesce($3, 'PLANNING')::library_status, coalesce($4, 0), $5)
         ON CONFLICT (profile_id, anime_id) DO UPDATE SET
           status = coalesce($3::library_status, library_entries.status),
           progress = coalesce($4, library_entries.progress),
           score = coalesce($5, library_entries.score)
         RETURNING anime_id, status, progress, score, rewatches, updated_at`,
        [profileId, args.animeId, status ?? null, args.progress ?? null, args.score ?? null]
      )
      return mapEntry(row!)
    },

    async deleteLibraryEntry (_root, args: { animeId: string }, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      await query('DELETE FROM library_entries WHERE profile_id = $1 AND anime_id = $2', [profileId, args.animeId])
      return true
    },

    async saveProgress (_root, args: { episodeId: string, positionSec: number, durationSec?: number }, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      const episode = await queryOne<{ anime_id: string }>('SELECT anime_id FROM episodes WHERE id = $1', [args.episodeId])
      if (!episode) throw new Error('Unknown episode')

      const completed = args.durationSec != null && args.durationSec > 0 && args.positionSec / args.durationSec >= 0.85
      const row = await queryOne(
        `INSERT INTO watch_progress (profile_id, episode_id, anime_id, position_sec, duration_sec, completed)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (profile_id, episode_id) DO UPDATE SET
           position_sec = $4, duration_sec = coalesce($5, watch_progress.duration_sec),
           completed = watch_progress.completed OR $6, updated_at = now()
         RETURNING episode_id, anime_id, position_sec, duration_sec, completed, updated_at`,
        [profileId, args.episodeId, episode.anime_id, args.positionSec, args.durationSec ?? null, completed]
      )
      return {
        episodeId: row!.episode_id,
        animeId: row!.anime_id,
        positionSec: Number(row!.position_sec),
        durationSec: row!.duration_sec == null ? null : Number(row!.duration_sec),
        completed: row!.completed,
        updatedAt: row!.updated_at
      }
    },

    async markNotificationsRead (_root, args: { ids: string[] }, ctx: Ctx) {
      if (!ctx.userId) throw new Error('Unauthorized')
      const rows = await query(
        `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL RETURNING id`,
        [ctx.userId, args.ids]
      )
      return rows.length
    }
  }
}

// batched child-field loaders — one query per field per request
export const loaders: MercuriusLoaders = {
  Anime: {
    async titles (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<{ anime_id: string, kind: string, title: string }>(
        'SELECT anime_id, kind, title FROM anime_titles WHERE anime_id = ANY($1)', [ids]
      )
      const byId = new Map<string, Record<string, string>>()
      for (const row of rows) {
        if (!byId.has(row.anime_id)) byId.set(row.anime_id, {})
        byId.get(row.anime_id)![row.kind] = row.title
      }
      return ids.map(id => byId.get(id) ?? {})
    },

    async synonyms (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<{ anime_id: string, synonym: string }>(
        'SELECT anime_id, synonym FROM anime_synonyms WHERE anime_id = ANY($1)', [ids]
      )
      const byId = new Map<string, string[]>()
      for (const row of rows) {
        if (!byId.has(row.anime_id)) byId.set(row.anime_id, [])
        byId.get(row.anime_id)!.push(row.synonym)
      }
      return ids.map(id => byId.get(id) ?? [])
    },

    async genres (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<{ anime_id: string, name: string }>(
        `SELECT ag.anime_id, g.name FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.anime_id = ANY($1)`, [ids]
      )
      const byId = new Map<string, string[]>()
      for (const row of rows) {
        if (!byId.has(row.anime_id)) byId.set(row.anime_id, [])
        byId.get(row.anime_id)!.push(row.name)
      }
      return ids.map(id => byId.get(id) ?? [])
    },

    async tags (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<{ anime_id: string, name: string, rank: number }>(
        `SELECT at.anime_id, t.name, at.rank FROM anime_tags at JOIN tags t ON t.id = at.tag_id
         WHERE at.anime_id = ANY($1) ORDER BY at.rank DESC`, [ids]
      )
      const byId = new Map<string, Array<{ name: string, rank: number }>>()
      for (const row of rows) {
        if (!byId.has(row.anime_id)) byId.set(row.anime_id, [])
        byId.get(row.anime_id)!.push({ name: row.name, rank: row.rank })
      }
      return ids.map(id => byId.get(id) ?? [])
    },

    async cover (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<{ anime_id: string, object_key: string, blurhash: string | null, dominant_color: string | null }>(
        `SELECT anime_id, object_key, blurhash, dominant_color FROM anime_images
         WHERE anime_id = ANY($1) AND kind = 'cover' AND is_primary`, [ids]
      )
      const byId = new Map(rows.map(row => [row.anime_id, { key: row.object_key, blurhash: row.blurhash, color: row.dominant_color }]))
      return ids.map(id => byId.get(id) ?? null)
    },

    async mappings (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<Record<string, unknown> & { anime_id: string }>(
        'SELECT * FROM anime_mappings WHERE anime_id = ANY($1)', [ids]
      )
      const byId = new Map(rows.map(row => [row.anime_id, {
        anilist: row.anilist_id, mal: row.mal_id, anidb: row.anidb_id,
        kitsu: row.kitsu_id, tvdb: row.tvdb_id, tmdb: row.tmdb_id, imdb: row.imdb_id
      }]))
      return ids.map(id => byId.get(id) ?? null)
    },

    async episodes (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<Record<string, unknown> & { anime_id: string }>(
        `SELECT id, anime_id, number, title, synopsis, air_date, duration, is_filler, is_recap
         FROM episodes WHERE anime_id = ANY($1) ORDER BY number`, [ids]
      )
      const byId = new Map<string, unknown[]>()
      for (const row of rows) {
        if (!byId.has(row.anime_id)) byId.set(row.anime_id, [])
        byId.get(row.anime_id)!.push({
          id: row.id, number: Number(row.number), title: row.title, synopsis: row.synopsis,
          airDate: row.air_date, duration: row.duration, isFiller: row.is_filler, isRecap: row.is_recap
        })
      }
      return ids.map(id => byId.get(id) ?? [])
    },

    async relations (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<AnimeRow & { src_id: string, relation: string }>(
        `SELECT r.anime_id AS src_id, r.relation, ${ANIME_COLS}
         FROM anime_relations r JOIN anime a ON a.id = r.related_id
         WHERE r.anime_id = ANY($1)`, [ids]
      )
      const byId = new Map<string, unknown[]>()
      for (const row of rows) {
        if (!byId.has(row.src_id)) byId.set(row.src_id, [])
        byId.get(row.src_id)!.push({ relation: row.relation, node: mapAnime(row) })
      }
      return ids.map(id => byId.get(id) ?? [])
    },

    async viewerEntry (queries, ctx) {
      const ectx = ctx as unknown as Ctx
      if (!ectx.userId) return queries.map(() => null)
      const profileId = await requireProfile(ectx)
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query(
        `SELECT anime_id, status, progress, score, rewatches, updated_at
         FROM library_entries WHERE profile_id = $1 AND anime_id = ANY($2)`,
        [profileId, ids]
      )
      const byId = new Map(rows.map(row => [row.anime_id as string, mapEntry(row)]))
      return ids.map(id => byId.get(id) ?? null)
    }
  }
}
