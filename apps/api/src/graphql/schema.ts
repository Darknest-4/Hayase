// GraphQL layer (mercurius) over the same rules as the REST routes.
//
// What a caller may see is decided exactly as REST decides it: a hidden title
// does not exist, an unlisted one is reachable by id but never listed, and an
// episode is listed only when it is public. These resolvers used to run their
// own SQL without any of that, so every unpublished title in the catalogue was
// one `anime(id:)` away.
//
// Writes go through the library services the REST routes use
// (modules/library/entries.ts, progress.ts) — one set of validation, one way
// of counting a finished episode.
//
// Every field that resolves a title for a list of parents is a batched loader,
// so a nested query costs one statement per field, not one per row.

import mercurius from 'mercurius'

import { pool, query, queryOne } from '../infrastructure/database/index.ts'
import { removeEntry, saveEntry, validate } from '../modules/library/entries.ts'
import { recordProgress } from '../modules/library/progress.ts'
import { searchAnime } from '../modules/search/search.ts'

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
    library(status: LibraryStatus, limit: Int = 500): [LibraryEntry!]!
    continueWatching: [WatchProgress!]!
    notifications(unreadOnly: Boolean = false, limit: Int = 25): [Notification!]!
    stats: ProfileStats
  }


  type Query {
    anime(id: ID!): Anime
    animePage(season: Season, year: Int, genre: String, format: Format, status: Status, sort: AnimeSort = POPULARITY, limit: Int = 25, cursor: String, nsfw: Boolean = false): AnimePage!
    search(query: String!, limit: Int = 10, nsfw: Boolean = false): [Anime!]!
    schedule(from: String!, to: String!): [AiringEpisode!]!
    me: Viewer
  }

  type Mutation {
    saveLibraryEntry(animeId: ID!, status: LibraryStatus, progress: Int, score: Float): LibraryEntry!
    deleteLibraryEntry(animeId: ID!): Boolean!
    saveProgress(episodeId: ID!, positionSec: Float!, durationSec: Float): WatchProgress!
    markNotificationsRead(ids: [ID!]!): Int!
  }
`

export interface Ctx extends MercuriusContext {
  userId?: string
  username?: string
  profileId?: string
}

/** A refusal the caller is meant to read. Anything else is masked in production. */
export function refuse (message: string, code: string, statusCode = 400): never {
  throw new mercurius.ErrorWithProps(message, { code }, statusCode)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A malformed id is not a lookup — Postgres would answer it with an error. */
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** Listed: browse, search, relations, the schedule. */
const LISTED = "a.visibility = 'public'"
/** Reachable by id: the detail of one title. Unlisted titles are, hidden ones are not. */
const REACHABLE = "a.visibility <> 'hidden'"

/** The widest schedule window one request may ask for. */
const SCHEDULE_MAX_DAYS = 62
/** The deepest page `animePage` will go to. OFFSET pages cost what they skip. */
const PAGE_OFFSET_MAX = 10_000

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
  if (!ctx.userId) refuse('Sign in first', 'UNAUTHENTICATED', 401)
  if (ctx.profileId) return ctx.profileId
  const profile = await queryOne<{ id: string }>(
    'SELECT id FROM user_profiles WHERE user_id = $1 ORDER BY is_default DESC LIMIT 1',
    [ctx.userId]
  )
  if (!profile) refuse('This account has no profile', 'NO_PROFILE', 409)
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

/**
 * Titles by id for a batch of parents, in the parents' order.
 *
 * Deliberately NOT filtered by visibility: the parents are the viewer's own
 * library and resume positions, or schedule rows that were filtered already.
 * A title hidden after somebody listed it stays on that person's list.
 */
async function animeFor (ids: string[]): Promise<Array<ReturnType<typeof mapAnime> | null>> {
  const rows = await query<AnimeRow>(`SELECT ${ANIME_COLS} FROM anime a WHERE a.id = ANY($1::uuid[])`, [ids])
  const byId = new Map(rows.map(row => [row.id, mapAnime(row)]))
  return ids.map(id => byId.get(id) ?? null)
}

export const resolvers: IResolvers = {
  Query: {
    async anime (_root, args: { id: string }) {
      if (!isUuid(args.id)) return null
      const row = await queryOne<AnimeRow>(`SELECT ${ANIME_COLS} FROM anime a WHERE a.id = $1 AND ${REACHABLE}`, [args.id])
      return row ? mapAnime(row) : null
    },

    async animePage (_root, args: { season?: string, year?: number, genre?: string, format?: string, status?: string, sort: string, limit: number, cursor?: string, nsfw: boolean }) {
      const where: string[] = [LISTED]
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

      const limit = Math.min(Math.max(1, args.limit), 50)
      const decoded = args.cursor ? Number(Buffer.from(args.cursor, 'base64url').toString()) : 0
      const offset = Number.isInteger(decoded) && decoded > 0 ? Math.min(decoded, PAGE_OFFSET_MAX) : 0
      params.push(limit + 1, offset)

      const rows = await query<AnimeRow>(
        `SELECT ${ANIME_COLS} FROM anime a
         WHERE ${where.join(' AND ')}
         ORDER BY ${SORTS[args.sort] ?? SORTS.POPULARITY}, a.id
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      )
      const hasMore = rows.length > limit && offset + limit < PAGE_OFFSET_MAX
      return {
        data: rows.slice(0, limit).map(mapAnime),
        nextCursor: hasMore ? Buffer.from(String(offset + limit)).toString('base64url') : null
      }
    },

    // The REST search, not a second implementation of it: the same ranking,
    // the same accent folding, the same visibility rule.
    async search (_root, args: { query: string, limit: number, nsfw: boolean }) {
      const limit = Math.min(Math.max(1, args.limit), 50)
      const found = await searchAnime(pool, args.query, { limit, nsfw: args.nsfw })
      if (!found.length) return []
      const ids = found.map(row => row.id)
      const rows = await query<AnimeRow>(`SELECT ${ANIME_COLS} FROM anime a WHERE a.id = ANY($1::uuid[])`, [ids])
      const byId = new Map(rows.map(row => [row.id, mapAnime(row)]))
      return ids.map(id => byId.get(id)).filter(Boolean)
    },

    async schedule (_root, args: { from: string, to: string }) {
      const from = new Date(args.from)
      const to = new Date(args.to)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        refuse('`from` and `to` must be ISO dates', 'BAD_DATE')
      }
      if (to <= from) refuse('`to` must be later than `from`', 'BAD_RANGE')
      if (to.getTime() - from.getTime() > SCHEDULE_MAX_DAYS * 86_400_000) {
        refuse(`A schedule spans at most ${SCHEDULE_MAX_DAYS} days`, 'RANGE_TOO_WIDE')
      }
      const rows = await query<{ episode_id: string, anime_id: string, number: string, air_date: string }>(
        `SELECT e.id AS episode_id, e.anime_id, e.number, e.air_date::text AS air_date
           FROM episodes e JOIN anime a ON a.id = e.anime_id
          WHERE e.air_date >= $1 AND e.air_date < $2
            AND ${LISTED} AND e.visibility = 'public'
          ORDER BY e.air_date`,
        [from.toISOString(), to.toISOString()]
      )
      return rows.map(row => ({
        episodeId: row.episode_id,
        animeId: row.anime_id,
        episode: Number(row.number),
        airingAt: row.air_date
      }))
    },

    me (_root, _args, ctx: Ctx) {
      if (!ctx.userId) return null
      return { id: ctx.userId, username: ctx.username }
    }
  },

  Viewer: {
    async library (_viewer, args: { status?: string, limit: number }, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      const params: unknown[] = [profileId]
      if (args.status) params.push(args.status)
      params.push(Math.min(Math.max(1, args.limit), 1000))
      const rows = await query(
        `SELECT anime_id, status, progress, score, rewatches, updated_at
         FROM library_entries WHERE profile_id = $1 ${args.status ? 'AND status = $2' : ''}
         ORDER BY updated_at DESC
         LIMIT $${params.length}`,
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
      if (!ctx.userId) refuse('Sign in first', 'UNAUTHENTICATED', 401)
      const rows = await query(
        `SELECT id, type, payload, read_at, created_at FROM notifications
         WHERE user_id = $1 ${args.unreadOnly ? 'AND read_at IS NULL' : ''}
         ORDER BY created_at DESC LIMIT $2`,
        [ctx.userId, Math.min(Math.max(1, args.limit), 100)]
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

  Mutation: {
    async saveLibraryEntry (_root, args: { animeId: string, status?: string, progress?: number, score?: number }, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      if (!isUuid(args.animeId)) refuse('Unknown anime', 'NOT_FOUND', 404)
      const change = {
        status: args.status ?? undefined,
        progress: args.progress ?? undefined,
        score: args.score ?? undefined
      }
      const problem = validate(change)
      if (problem) refuse(problem, 'BAD_INPUT')
      const row = await saveEntry(profileId, args.animeId, change)
      if (!row) refuse('Unknown anime', 'NOT_FOUND', 404)
      return mapEntry(row)
    },

    async deleteLibraryEntry (_root, args: { animeId: string }, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      if (isUuid(args.animeId)) await removeEntry(profileId, args.animeId)
      return true
    },

    async saveProgress (_root, args: { episodeId: string, positionSec: number, durationSec?: number }, ctx: Ctx) {
      const profileId = await requireProfile(ctx)
      if (!isUuid(args.episodeId)) refuse('Unknown episode', 'NOT_FOUND', 404)
      if (!Number.isFinite(args.positionSec) || args.positionSec < 0) refuse('positionSec must be zero or more', 'BAD_INPUT')
      if (args.durationSec != null && (!Number.isFinite(args.durationSec) || args.durationSec < 0)) {
        refuse('durationSec must be zero or more', 'BAD_INPUT')
      }
      const saved = await recordProgress({
        profileId,
        episodeId: args.episodeId,
        positionSec: args.positionSec,
        durationSec: args.durationSec ?? null
      })
      if (!saved) refuse('Unknown episode', 'NOT_FOUND', 404)
      return saved
    },

    async markNotificationsRead (_root, args: { ids: string[] }, ctx: Ctx) {
      if (!ctx.userId) refuse('Sign in first', 'UNAUTHENTICATED', 401)
      const ids = args.ids.filter(isUuid).slice(0, 200)
      if (!ids.length) return 0
      const rows = await query(
        `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL RETURNING id`,
        [ctx.userId, ids]
      )
      return rows.length
    }
  }
}

// ---- batched child-field loaders — one query per field per request ----

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

    // Public episodes only — the rule the REST episode list applies.
    async episodes (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<Record<string, unknown> & { anime_id: string }>(
        `SELECT id, anime_id, number, title, synopsis, air_date::text AS air_date, duration, is_filler, is_recap
         FROM episodes WHERE anime_id = ANY($1) AND visibility = 'public' ORDER BY number`, [ids]
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

    // Related titles are a listing, so only listed ones appear in it.
    async relations (queries) {
      const ids = queries.map(q => (q.obj as { id: string }).id)
      const rows = await query<AnimeRow & { src_id: string, relation: string }>(
        `SELECT r.anime_id AS src_id, r.relation, ${ANIME_COLS}
         FROM anime_relations r JOIN anime a ON a.id = r.related_id
         WHERE r.anime_id = ANY($1) AND ${LISTED}`, [ids]
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
  },

  // One statement per field for the whole list — these resolved a title per
  // row before, so a schedule of a thousand episodes was a thousand queries.
  LibraryEntry: {
    async anime (queries) { return await animeFor(queries.map(q => (q.obj as { animeId: string }).animeId)) }
  },
  WatchProgress: {
    async anime (queries) { return await animeFor(queries.map(q => (q.obj as { animeId: string }).animeId)) }
  },
  AiringEpisode: {
    async anime (queries) { return await animeFor(queries.map(q => (q.obj as { animeId: string }).animeId)) }
  }
}
