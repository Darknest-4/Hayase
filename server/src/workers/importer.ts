// Catalogue importer. Reads anime-offline-database-format JSON
// (https://github.com/manami-project/anime-offline-database) and upserts
// anime + titles + synonyms + external-id mappings.
// Job payload: { file: '/path/to/dump.json' }  (or invoke importFile directly)
//
// Idempotent: rows are matched by anilist id (preferred) or MAL id; re-runs
// update in place. The AniList API enricher (banners, genres, relations)
// builds on the rows this importer creates.

import { readFile } from 'node:fs/promises'

import { pool } from '../db.ts'

import type { Job } from '../lib/queue.ts'
import type pg from 'pg'

interface OfflineDbEntry {
  title: string
  type: string            // TV | MOVIE | OVA | ONA | SPECIAL | UNKNOWN
  episodes: number
  status: string          // FINISHED | ONGOING | UPCOMING | UNKNOWN
  animeSeason?: { season?: string, year?: number }
  picture?: string
  synonyms?: string[]
  sources: string[]       // provider URLs carrying the external ids
  duration?: { value: number, unit: string }
}

const FORMAT_MAP: Record<string, string> = { TV: 'TV', MOVIE: 'MOVIE', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'SPECIAL', UNKNOWN: 'TV' }
const STATUS_MAP: Record<string, string> = { FINISHED: 'FINISHED', ONGOING: 'RELEASING', UPCOMING: 'NOT_YET_RELEASED', UNKNOWN: 'FINISHED' }
const SEASON_MAP: Record<string, string> = { WINTER: 'WINTER', SPRING: 'SPRING', SUMMER: 'SUMMER', FALL: 'FALL' }

function externalIds (sources: string[]): { anilist?: number, mal?: number, anidb?: number, kitsu?: number } {
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

async function upsertEntry (client: pg.PoolClient, entry: OfflineDbEntry): Promise<'inserted' | 'updated' | 'skipped'> {
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

  let animeId: string
  let result: 'inserted' | 'updated'

  if (existing.rows[0]) {
    animeId = existing.rows[0].anime_id
    await client.query(
      `UPDATE anime SET canonical_title = $2, format = $3::anime_format, status = $4::anime_status,
         season = $5::anime_season, season_year = $6, episode_count = nullif($7, 0), episode_duration = $8
       WHERE id = $1`,
      [animeId, entry.title, format, status, season, year, entry.episodes ?? 0, duration]
    )
    result = 'updated'
  } else {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO anime (canonical_title, format, status, season, season_year, episode_count, episode_duration)
       VALUES ($1, $2::anime_format, $3::anime_status, $4::anime_season, $5, nullif($6, 0), $7)
       RETURNING id`,
      [entry.title, format, status, season, year, entry.episodes ?? 0, duration]
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

  return result
}

export async function importFile (path: string): Promise<{ inserted: number, updated: number, skipped: number }> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as { data: OfflineDbEntry[] }
  const stats = { inserted: 0, updated: 0, skipped: 0 }

  const client = await pool.connect()
  try {
    // batched transactions: progress survives a crash mid-import
    const BATCH = 500
    for (let i = 0; i < raw.data.length; i += BATCH) {
      await client.query('BEGIN')
      for (const entry of raw.data.slice(i, i + BATCH)) {
        stats[await upsertEntry(client, entry)]++
      }
      await client.query('COMMIT')
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return stats
}

export async function handleImportJob (job: Job): Promise<void> {
  const { file } = job.payload as { file: string }
  await importFile(file)
}
