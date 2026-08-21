// AniList enrichment importer.
// The catalogue rows exist (seeded from anime-offline-database with an
// anilist_id mapping) but lack the rich fields AniList carries — synopsis,
// cover/banner art, score, genres, tags, studios, trailer. This pulls those
// from the AniList GraphQL API in batches of 50 (by id_in) and upserts them.
//
// AniList is rate-limited; requests are paced and 429s are honoured. The
// network fetch (fetchMediaBatch) and the DB write (upsertMedia) are split so
// the mapping/upsert can be unit-tested without touching the network.

import { pool, transaction } from '../db.ts'

import type pg from 'pg'

export const ANILIST_URL = process.env.ANILIST_URL ?? 'https://graphql.anilist.co'
const DELAY_MS = Number(process.env.AL_DELAY_MS ?? 2000) // ~30 req/min: safe under AniList's limit

const FORMATS = new Set(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'])
const STATUSES = new Set(['NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS'])

export interface AniListMedia {
  id: number
  idMal?: number | null
  title?: { userPreferred?: string, romaji?: string, english?: string, native?: string }
  description?: string | null
  coverImage?: { extraLarge?: string, color?: string | null }
  bannerImage?: string | null
  season?: string | null
  seasonYear?: number | null
  format?: string | null
  status?: string | null
  episodes?: number | null
  duration?: number | null
  averageScore?: number | null
  popularity?: number | null
  isAdult?: boolean | null
  source?: string | null
  genres?: string[]
  synonyms?: string[]
  tags?: Array<{ name: string, rank?: number | null, isAdult?: boolean | null }>
  startDate?: { year?: number | null, month?: number | null, day?: number | null }
  endDate?: { year?: number | null, month?: number | null, day?: number | null }
  studios?: { nodes?: Array<{ name: string }> }
  trailer?: { id?: string | null, site?: string | null } | null
}

const MEDIA_FIELDS = `
  id idMal
  title { userPreferred romaji english native }
  description(asHtml: false)
  coverImage { extraLarge color }
  bannerImage
  season seasonYear format status episodes duration
  averageScore popularity isAdult source
  genres synonyms
  tags { name rank isAdult }
  startDate { year month day }
  endDate { year month day }
  studios(isMain: true) { nodes { name } }
  trailer { id site }`

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Fetch up to 50 media by AniList id, honouring rate limits (429 / retry-after). */
export async function fetchMediaBatch (ids: number[], attempt = 0): Promise<AniListMedia[]> {
  const query = `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } } }`
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { ids } })
  })

  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? 60)
    if (attempt >= 5) throw new Error('AniList rate limit: giving up after 5 retries')
    await sleep((retry + 1) * 1000)
    return fetchMediaBatch(ids, attempt + 1)
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`)

  const body = await res.json() as { data?: { Page?: { media?: AniListMedia[] } }, errors?: Array<{ message: string }> }
  if (body.errors?.length) throw new Error('AniList: ' + body.errors.map(e => e.message).join('; '))

  // stay well under the limit even when the server doesn't push back
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? 99)
  if (remaining <= 2) await sleep(60_000)

  return body.data?.Page?.media ?? []
}

// ---- mapping helpers ----

const stripHtml = (s?: string | null): string | null =>
  s ? s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#039);/g, m =>
    ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'" } as Record<string, string>)[m] ?? m).trim() || null : null

const dateStr = (d?: { year?: number | null, month?: number | null, day?: number | null }): string | null =>
  d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}` : null

const slugify = (s: string): string => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export interface EnrichCaches { genreIds: Map<string, number>, tagIds: Map<string, number>, companyIds: Map<string, string> }

export async function loadCaches (client: pg.PoolClient): Promise<EnrichCaches> {
  const g = await client.query<{ id: number, slug: string }>('SELECT id, slug FROM genres')
  const t = await client.query<{ id: number, slug: string }>('SELECT id, slug FROM tags')
  return { genreIds: new Map(g.rows.map(r => [r.slug, r.id])), tagIds: new Map(t.rows.map(r => [r.slug, r.id])), companyIds: new Map() }
}

/** Write one AniList media onto its existing anime row (matched by anilist_id). */
export async function upsertMedia (client: pg.PoolClient, media: AniListMedia, caches: EnrichCaches): Promise<boolean> {
  const found = await client.query<{ anime_id: string }>(
    'SELECT anime_id FROM anime_mappings WHERE anilist_id = $1', [media.id]
  )
  if (!found.rows[0]) return false // no local row keyed on this AniList id
  const animeId = found.rows[0].anime_id

  const title = media.title ?? {}
  const format = media.format && FORMATS.has(media.format) ? media.format : null
  const status = media.status && STATUSES.has(media.status) ? media.status : null

  await client.query(
    `UPDATE anime SET
       canonical_title = coalesce($2, canonical_title),
       synopsis = coalesce($3, synopsis),
       average_score = $4, popularity = coalesce($5, popularity),
       season = coalesce($6::anime_season, season), season_year = coalesce($7, season_year),
       start_date = coalesce($8::date, start_date), end_date = coalesce($9::date, end_date),
       episode_count = coalesce(nullif($10, 0), episode_count), episode_duration = coalesce($11, episode_duration),
       format = coalesce($12::anime_format, format), status = coalesce($13::anime_status, status),
       is_adult = coalesce($14, is_adult), source_material = coalesce($15, source_material),
       updated_at = now()
     WHERE id = $1`,
    [animeId, title.userPreferred ?? title.romaji ?? null, stripHtml(media.description),
      media.averageScore ?? null, media.popularity ?? null,
      media.season ?? null, media.seasonYear ?? null,
      dateStr(media.startDate), dateStr(media.endDate),
      media.episodes ?? 0, media.duration ?? null,
      format, status, media.isAdult ?? null, media.source ?? null]
  )

  if (media.idMal) {
    await client.query('UPDATE anime_mappings SET mal_id = coalesce(mal_id, $2), updated_at = now() WHERE anime_id = $1', [animeId, media.idMal])
  }

  // localised titles
  for (const [kind, value] of [['romaji', title.romaji], ['english', title.english], ['native', title.native], ['preferred', title.userPreferred]] as const) {
    if (value) {
      await client.query(
        `INSERT INTO anime_titles (anime_id, kind, title) VALUES ($1, $2, $3)
         ON CONFLICT (anime_id, kind) DO UPDATE SET title = excluded.title`, [animeId, kind, value])
    }
  }
  for (const syn of (media.synonyms ?? []).slice(0, 50)) {
    await client.query('INSERT INTO anime_synonyms (anime_id, synonym) VALUES ($1, $2) ON CONFLICT DO NOTHING', [animeId, syn.slice(0, 500)])
  }

  // cover + banner (AniList CDN URLs stored as the image key, like the aod import)
  if (media.coverImage?.extraLarge) {
    await client.query(
      `INSERT INTO anime_images (anime_id, kind, object_key, dominant_color, is_primary)
       VALUES ($1, 'cover', $2, $3, true)
       ON CONFLICT (anime_id, kind) WHERE is_primary DO UPDATE SET object_key = excluded.object_key, dominant_color = excluded.dominant_color`,
      [animeId, media.coverImage.extraLarge, media.coverImage.color ?? null])
  }
  if (media.bannerImage) {
    await client.query(
      `INSERT INTO anime_images (anime_id, kind, object_key, is_primary)
       VALUES ($1, 'banner', $2, true)
       ON CONFLICT (anime_id, kind) WHERE is_primary DO UPDATE SET object_key = excluded.object_key`,
      [animeId, media.bannerImage])
  }

  // genres (get-or-create by slug)
  for (const name of media.genres ?? []) {
    const slug = slugify(name)
    if (!slug) continue
    let id = caches.genreIds.get(slug)
    if (!id) {
      const { rows } = await client.query<{ id: number }>(
        'INSERT INTO genres (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = excluded.name RETURNING id', [slug, name])
      id = rows[0]!.id
      caches.genreIds.set(slug, id)
    }
    await client.query('INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [animeId, id])
  }

  // tags with rank
  for (const tag of (media.tags ?? []).slice(0, 30)) {
    const slug = slugify(tag.name)
    if (!slug) continue
    let id = caches.tagIds.get(slug)
    if (!id) {
      const { rows } = await client.query<{ id: number }>(
        'INSERT INTO tags (slug, name, is_adult) VALUES ($1, $2, $3) ON CONFLICT (slug) DO UPDATE SET name = tags.name RETURNING id',
        [slug, tag.name, tag.isAdult ?? false])
      id = rows[0]!.id
      caches.tagIds.set(slug, id)
    }
    await client.query(
      `INSERT INTO anime_tags (anime_id, tag_id, rank) VALUES ($1, $2, $3)
       ON CONFLICT (anime_id, tag_id) DO UPDATE SET rank = excluded.rank`,
      [animeId, id, Math.max(0, Math.min(100, tag.rank ?? 0))])
  }

  // main studios
  for (const studio of media.studios?.nodes ?? []) {
    let companyId = caches.companyIds.get(studio.name)
    if (!companyId) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO companies (name, country) VALUES ($1, NULL)
         ON CONFLICT (name, country) DO UPDATE SET name = excluded.name RETURNING id`, [studio.name])
      companyId = rows[0]!.id
      caches.companyIds.set(studio.name, companyId)
    }
    await client.query(
      `INSERT INTO anime_companies (anime_id, company_id, role, is_main) VALUES ($1, $2, 'studio', true)
       ON CONFLICT (anime_id, company_id, role) DO UPDATE SET is_main = true`, [animeId, companyId])
  }

  // trailer
  if (media.trailer?.id && media.trailer.site === 'youtube') {
    await client.query(
      `INSERT INTO anime_videos (anime_id, kind, provider, ref) VALUES ($1, 'trailer', 'youtube', $2)
       ON CONFLICT DO NOTHING`, [animeId, media.trailer.id])
  }

  return true
}

/** Drive the enrichment across every anime that has an anilist_id. */
export async function enrichFromAniList (
  opts: { limit?: number, onlyMissing?: boolean, onProgress?: (done: number, total: number, updated: number) => void } = {}
): Promise<{ processed: number, updated: number, failed: number }> {
  const onlyMissing = opts.onlyMissing ?? true
  const rows = await pool.query<{ anilist_id: number }>(
    `SELECT m.anilist_id FROM anime_mappings m JOIN anime a ON a.id = m.anime_id
     WHERE m.anilist_id IS NOT NULL ${onlyMissing ? 'AND a.synopsis IS NULL' : ''}
     ORDER BY a.popularity DESC
     ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ''}`
  )
  const ids = rows.rows.map(r => r.anilist_id)
  const total = ids.length
  let processed = 0
  let updated = 0
  let failed = 0

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    try {
      const media = await fetchMediaBatch(batch)
      await transaction(async client => {
        const caches = await loadCaches(client)
        for (const m of media) { if (await upsertMedia(client, m, caches)) updated++ }
      })
    } catch (err) {
      failed += batch.length
      console.error(`batch ${i / 50 + 1} failed:`, (err as Error).message)
    }
    processed += batch.length
    opts.onProgress?.(processed, total, updated)
    if (i + 50 < ids.length) await sleep(DELAY_MS)
  }
  return { processed, updated, failed }
}
