// Catalogue importer. Reads anime-offline-database-format JSON
// (https://github.com/manami-project/anime-offline-database) and upserts
// the full catalogue: anime + titles + synonyms + external-id mappings +
// cover images + genres/tags + the relation graph.
// Job payload: { file: '/path/to/dump.json' }  (or invoke importFile directly)
//
// Idempotent: rows are matched by anilist id (preferred) or MAL id; re-runs
// update in place. scripts/seed.ts drives this plus episode generation and
// real filler flags for a complete database seed.

import { readFile } from 'node:fs/promises'

import { pool, query } from '../db.ts'

import type { Job } from '../lib/queue.ts'
import type pg from 'pg'

interface OfflineDbEntry {
  title: string
  type: string            // TV | MOVIE | OVA | ONA | SPECIAL | UNKNOWN
  episodes: number
  status: string          // FINISHED | ONGOING | UPCOMING | UNKNOWN
  animeSeason?: { season?: string, year?: number }
  picture?: string
  thumbnail?: string
  synonyms?: string[]
  sources: string[]       // provider URLs carrying the external ids
  relations?: string[]    // provider URLs of related entries
  tags?: string[]
  duration?: { value: number, unit: string }
}

const FORMAT_MAP: Record<string, string> = { TV: 'TV', MOVIE: 'MOVIE', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'SPECIAL', UNKNOWN: 'TV' }
const STATUS_MAP: Record<string, string> = { FINISHED: 'FINISHED', ONGOING: 'RELEASING', UPCOMING: 'NOT_YET_RELEASED', UNKNOWN: 'FINISHED' }
const SEASON_MAP: Record<string, string> = { WINTER: 'WINTER', SPRING: 'SPRING', SUMMER: 'SUMMER', FALL: 'FALL' }
// approximate premiere date per season — gives episode air dates a real anchor
const SEASON_MONTH: Record<string, number> = { WINTER: 1, SPRING: 4, SUMMER: 7, FALL: 10 }

// curated genres (aod tags are lowercase); everything else lands in tags
const GENRE_MAP: Record<string, string> = {
  action: 'Action',
  adventure: 'Adventure',
  comedy: 'Comedy',
  drama: 'Drama',
  ecchi: 'Ecchi',
  fantasy: 'Fantasy',
  horror: 'Horror',
  'mahou shoujo': 'Mahou Shoujo',
  'magical girl': 'Mahou Shoujo',
  mecha: 'Mecha',
  music: 'Music',
  mystery: 'Mystery',
  psychological: 'Psychological',
  romance: 'Romance',
  'sci-fi': 'Sci-Fi',
  'science fiction': 'Sci-Fi',
  'slice of life': 'Slice of Life',
  sports: 'Sports',
  supernatural: 'Supernatural',
  thriller: 'Thriller'
}
const MAX_TAGS_PER_ANIME = 20

const slugify = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

export function externalIds (sources: string[]): { anilist?: number, mal?: number, anidb?: number, kitsu?: number } {
  const ids: ReturnType<typeof externalIds> = {}
  for (const url of sources) {
    let match = url.match(/anilist\.co\/anime\/(\d+)/)
    if (match) { ids.anilist = Number(match[1]); continue }
    match = url.match(/myanimelist\.net\/anime\/(\d+)/)
    if (match) { ids.mal = Number(match[1]); continue }
    match = url.match(/anidb\.net\/anime\/(\d+)/)
    if (match) { ids.anidb = Number(match[1]); continue }
    match = url.match(/kitsu\.(?:io|app)\/anime\/(\d+)/)
    if (match) ids.kitsu = Number(match[1])
  }
  return ids
}

// caches shared across one importFile run
interface ImportCaches {
  genreIds: Map<string, number>
  tagIds: Map<string, number>
}

async function loadCaches (client: pg.PoolClient): Promise<ImportCaches> {
  const genreIds = new Map<string, number>()
  for (const name of new Set(Object.values(GENRE_MAP))) {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO genres (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = excluded.name RETURNING id`,
      [slugify(name), name]
    )
    genreIds.set(name, rows[0]!.id)
  }
  const tagIds = new Map<string, number>()
  const existing = await client.query<{ id: number, slug: string }>('SELECT id, slug FROM tags')
  for (const row of existing.rows) tagIds.set(row.slug, row.id)
  return { genreIds, tagIds }
}

function startDateFor (entry: OfflineDbEntry): string | null {
  const season = entry.animeSeason?.season ? SEASON_MAP[entry.animeSeason.season] : null
  const year = entry.animeSeason?.year
  if (!year) return null
  const month = season ? SEASON_MONTH[season]! : 1
  return `${year}-${String(month).padStart(2, '0')}-05`
}

async function upsertEntry (client: pg.PoolClient, entry: OfflineDbEntry, caches: ImportCaches): Promise<'inserted' | 'updated' | 'skipped'> {
  const ids = externalIds(entry.sources ?? [])
  if (!ids.anilist && !ids.mal) return 'skipped' // nothing to key on

  const existing = await client.query<{ anime_id: string }>(
    'SELECT anime_id FROM anime_mappings WHERE ($1::int IS NOT NULL AND anilist_id = $1) OR ($2::int IS NOT NULL AND mal_id = $2)',
    [ids.anilist ?? null, ids.mal ?? null]
  )

  const format = FORMAT_MAP[entry.type] ?? 'TV'
  const status = STATUS_MAP[entry.status] ?? 'FINISHED'
  const season = entry.animeSeason?.season ? SEASON_MAP[entry.animeSeason.season] ?? null : null
  const year = entry.animeSeason?.year ?? null
  const duration = entry.duration?.unit === 'SECONDS' ? Math.round(entry.duration.value / 60) : entry.duration?.value ?? null
  const startDate = startDateFor(entry)
  const tags = (entry.tags ?? []).map(t => t.toLowerCase())
  const isAdult = tags.includes('hentai')

  let animeId: string
  let result: 'inserted' | 'updated'

  if (existing.rows[0]) {
    animeId = existing.rows[0].anime_id
    await client.query(
      `UPDATE anime SET canonical_title = $2, format = $3::anime_format, status = $4::anime_status,
         season = $5::anime_season, season_year = $6, episode_count = nullif($7, 0), episode_duration = $8,
         start_date = coalesce($9::date, start_date), is_adult = $10
       WHERE id = $1`,
      [animeId, entry.title, format, status, season, year, entry.episodes ?? 0, duration, startDate, isAdult]
    )
    result = 'updated'
  } else {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO anime (canonical_title, format, status, season, season_year, episode_count, episode_duration, start_date, is_adult)
       VALUES ($1, $2::anime_format, $3::anime_status, $4::anime_season, $5, nullif($6, 0), $7, $8::date, $9)
       RETURNING id`,
      [entry.title, format, status, season, year, entry.episodes ?? 0, duration, startDate, isAdult]
    )
    animeId = inserted.rows[0]!.id
    result = 'inserted'
  }

  await client.query(
    `INSERT INTO anime_mappings (anime_id, anilist_id, mal_id, anidb_id, kitsu_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (anime_id) DO UPDATE SET
       anilist_id = coalesce(excluded.anilist_id, anime_mappings.anilist_id),
       mal_id = coalesce(excluded.mal_id, anime_mappings.mal_id),
       anidb_id = coalesce(excluded.anidb_id, anime_mappings.anidb_id),
       kitsu_id = coalesce(excluded.kitsu_id, anime_mappings.kitsu_id),
       updated_at = now()`,
    [animeId, ids.anilist ?? null, ids.mal ?? null, ids.anidb ?? null, ids.kitsu ?? null]
  )

  await client.query(
    `INSERT INTO anime_titles (anime_id, kind, title) VALUES ($1, 'romaji', $2)
     ON CONFLICT (anime_id, kind) DO UPDATE SET title = excluded.title`,
    [animeId, entry.title]
  )

  for (const synonym of (entry.synonyms ?? []).slice(0, 50)) {
    await client.query(
      'INSERT INTO anime_synonyms (anime_id, synonym) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [animeId, synonym.slice(0, 500)]
    )
  }

  // cover art: aod ships MAL CDN URLs; stored as the image key (dev-mode —
  // the media worker re-hosts to object storage in production)
  if (entry.picture) {
    await client.query(
      `INSERT INTO anime_images (anime_id, kind, object_key, is_primary)
       VALUES ($1, 'cover', $2, true)
       ON CONFLICT (anime_id, kind) WHERE is_primary DO UPDATE SET object_key = excluded.object_key`,
      [animeId, entry.picture]
    )
  }

  // genres + tags
  const genreNames = new Set<string>()
  const tagNames: string[] = []
  for (const tag of tags) {
    const genre = GENRE_MAP[tag]
    if (genre) genreNames.add(genre)
    else if (tagNames.length < MAX_TAGS_PER_ANIME) tagNames.push(tag)
  }
  for (const name of genreNames) {
    await client.query(
      'INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [animeId, caches.genreIds.get(name)]
    )
  }
  for (const name of tagNames) {
    const slug = slugify(name)
    if (!slug) continue
    let tagId = caches.tagIds.get(slug)
    if (!tagId) {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO tags (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = tags.name RETURNING id`,
        [slug, name]
      )
      tagId = rows[0]!.id
      caches.tagIds.set(slug, tagId)
    }
    await client.query(
      'INSERT INTO anime_tags (anime_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [animeId, tagId]
    )
  }

  return result
}

export async function importFile (path: string, onProgress?: (done: number, total: number) => void): Promise<{ inserted: number, updated: number, skipped: number, relations: number }> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as { data: OfflineDbEntry[] }
  const stats = { inserted: 0, updated: 0, skipped: 0, relations: 0 }

  const client = await pool.connect()
  try {
    const caches = await loadCaches(client)

    // pass 1: entities — batched transactions so progress survives a crash
    const BATCH = 500
    for (let i = 0; i < raw.data.length; i += BATCH) {
      await client.query('BEGIN')
      for (const entry of raw.data.slice(i, i + BATCH)) {
        stats[await upsertEntry(client, entry, caches)]++
      }
      await client.query('COMMIT')
      onProgress?.(Math.min(i + BATCH, raw.data.length), raw.data.length)
    }

    // pass 2: relation graph — resolve provider URLs through the id map
    const idRows = await client.query<{ anime_id: string, anilist_id: number | null, mal_id: number | null }>(
      'SELECT anime_id, anilist_id, mal_id FROM anime_mappings'
    )
    const byExt = new Map<string, string>()
    for (const row of idRows.rows) {
      if (row.anilist_id) byExt.set('al:' + row.anilist_id, row.anime_id)
      if (row.mal_id) byExt.set('mal:' + row.mal_id, row.anime_id)
    }
    const resolve = (url: string): string | undefined => {
      const al = url.match(/anilist\.co\/anime\/(\d+)/)
      if (al) return byExt.get('al:' + al[1])
      const mal = url.match(/myanimelist\.net\/anime\/(\d+)/)
      if (mal) return byExt.get('mal:' + mal[1])
      return undefined
    }

    await client.query('BEGIN')
    let pending = 0
    for (const entry of raw.data) {
      const source = externalIds(entry.sources ?? [])
      const from = (source.anilist && byExt.get('al:' + source.anilist)) ?? (source.mal && byExt.get('mal:' + source.mal))
      if (!from || !entry.relations?.length) continue
      for (const relUrl of entry.relations) {
        const to = resolve(relUrl)
        if (!to || to === from) continue
        await client.query(
          `INSERT INTO anime_relations (anime_id, related_id, relation) VALUES ($1, $2, 'OTHER') ON CONFLICT DO NOTHING`,
          [from, to]
        )
        stats.relations++
        if (++pending >= 2000) { await client.query('COMMIT'); await client.query('BEGIN'); pending = 0 }
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return stats
}

// generate episode rows from real counts + season-anchored weekly air dates.
// Titles stay NULL until a per-episode metadata source fills them in.
export async function generateEpisodes (maxEpisodes = 100): Promise<number> {
  const rows = await query<{ count: string }>(
    `WITH created AS (
       INSERT INTO episodes (anime_id, number, air_date, duration)
       SELECT a.id, gs.n,
              CASE WHEN a.start_date IS NOT NULL THEN a.start_date + (gs.n - 1) * interval '7 days' END,
              a.episode_duration
       FROM anime a
       CROSS JOIN LATERAL generate_series(1, least(a.episode_count, $1)) AS gs(n)
       WHERE a.episode_count IS NOT NULL AND a.episode_count >= 1
       ON CONFLICT (anime_id, number) DO NOTHING
       RETURNING 1
     ) SELECT count(*) FROM created`,
    [maxEpisodes]
  )
  return Number(rows[0]?.count ?? 0)
}

// real filler data (filler-scrape aggregates community filler lists, keyed
// by AniList id): mark matching generated episodes
export async function applyFillerData (fillerByAnilistId: Record<string, number[]>): Promise<number> {
  let updated = 0
  for (const [anilistId, episodes] of Object.entries(fillerByAnilistId)) {
    if (!episodes?.length) continue
    const rows = await query<{ count: string }>(
      `WITH marked AS (
         UPDATE episodes e SET is_filler = true
         FROM anime_mappings m
         WHERE m.anime_id = e.anime_id AND m.anilist_id = $1 AND e.number = ANY($2::numeric[]) AND NOT e.is_filler
         RETURNING 1
       ) SELECT count(*) FROM marked`,
      [Number(anilistId), episodes]
    )
    updated += Number(rows[0]?.count ?? 0)
  }
  return updated
}

export async function handleImportJob (job: Job): Promise<void> {
  const { file } = job.payload as { file: string }
  await importFile(file)
}
