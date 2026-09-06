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
import { resolveFields, applyResolution, CURRENT_COLUMNS, type CurrentRow } from '../lib/metadata.ts'

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

/**
 * One AniList GraphQL call, with the rate limit handled.
 *
 * Shared by both passes: the fast one that fetches 50 media of scalar fields,
 * and the deep one that fetches far fewer with their whole cast attached.
 */
async function anilistRequest<T> (query: string, variables: Record<string, unknown>, attempt = 0): Promise<T> {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables })
  })

  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? 60)
    if (attempt >= 5) throw new Error('AniList rate limit: giving up after 5 retries')
    await sleep((retry + 1) * 1000)
    return anilistRequest<T>(query, variables, attempt + 1)
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`)

  const body = await res.json() as { data?: T, errors?: Array<{ message: string }> }
  if (body.errors?.length) throw new Error('AniList: ' + body.errors.map(e => e.message).join('; '))

  // stay well under the limit even when the server doesn't push back
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? 99)
  if (remaining <= 2) await sleep(60_000)

  return body.data as T
}

/** Fetch up to 50 media by AniList id, honouring rate limits (429 / retry-after). */
export async function fetchMediaBatch (ids: number[]): Promise<AniListMedia[]> {
  const query = `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } } }`
  const data = await anilistRequest<{ Page?: { media?: AniListMedia[] } }>(query, { ids })
  return data?.Page?.media ?? []
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

/**
 * Attach a MAL id to an anime, or record why it could not be.
 *
 * `anime_mappings.mal_id` is UNIQUE, so this is not a write that can simply be
 * retried: another anime may already hold the id. The previous version issued
 * a blind `UPDATE ... SET mal_id = coalesce(mal_id, $2)`, which raised on
 * exactly that case — and since the enricher wraps 50 rows in one
 * transaction, one collision took all fifty down with it.
 *
 * **On a collision the existing mapping wins and the new one is recorded.**
 * Two reasons, and the second is the one that decides it:
 *
 *   1. `anilist_id` is the identity this importer works from — it is how the
 *      anime row was found in the first place. `mal_id` is a cross-reference,
 *      and nothing about arriving second makes a cross-reference more correct
 *      than the one already there.
 *   2. Overwriting does not add a mapping, it *moves* one. Everything
 *      that resolves by MAL id would silently start returning a different
 *      anime, with no event anywhere saying so. Refusing the write leaves the
 *      catalogue exactly as it was and puts the disagreement in a table.
 *
 * The usual cause is not corruption: AniList splits a show into separate
 * entries far more readily than MyAnimeList does, so two AniList ids pointing
 * at one MAL entry is the normal shape of a multi-season show. Some are real
 * duplicates in our own catalogue, which is why the pair is written down.
 *
 * Never throws. A telemetry write must not be able to fail an import.
 */
export async function writeMalId (client: pg.PoolClient, animeId: string, malId: number): Promise<'written' | 'unchanged' | 'conflict'> {
  // One statement, no exception: the guard makes the row invisible to the
  // UPDATE when another anime holds the id, so there is nothing for the unique
  // index to reject.
  const written = await client.query(
    `UPDATE anime_mappings SET mal_id = $2, updated_at = now()
      WHERE anime_id = $1
        AND mal_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM anime_mappings WHERE mal_id = $2)`,
    [animeId, malId]
  )
  if (written.rowCount) return 'written'

  // Nothing was written. Either this row already had the id (the common case,
  // and not worth a word), or somebody else has it.
  const holder = await client.query<{ anime_id: string }>(
    'SELECT anime_id FROM anime_mappings WHERE mal_id = $1', [malId]
  )
  const heldBy = holder.rows[0]?.anime_id
  if (!heldBy || heldBy === animeId) return 'unchanged'

  await client.query(
    `INSERT INTO mapping_conflicts (anime_id, provider, external_id, held_by, source)
     VALUES ($1, 'mal', $2, $3, 'anilist-enrich')
     ON CONFLICT (anime_id, provider, external_id) DO UPDATE
        SET last_seen = now(), seen_count = mapping_conflicts.seen_count + 1, held_by = excluded.held_by`,
    [animeId, String(malId), heldBy]
  )
  return 'conflict'
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

  // Canonical fields go through the conflict-resolution layer instead of a
  // blind UPDATE: anything an operator edited by hand is locked, and a
  // lower-precedence provider cannot overwrite a higher-ranked one.
  const current = await client.query<CurrentRow>(`SELECT ${CURRENT_COLUMNS} FROM anime WHERE id = $1`, [animeId])
  const resolution = resolveFields(current.rows[0] ?? {}, {
    canonical_title: title.userPreferred ?? title.romaji ?? null,
    synopsis: stripHtml(media.description),
    average_score: media.averageScore ?? null,
    popularity: media.popularity ?? null,
    season: media.season ?? null,
    season_year: media.seasonYear ?? null,
    start_date: dateStr(media.startDate),
    end_date: dateStr(media.endDate),
    episode_count: media.episodes || null,
    episode_duration: media.duration ?? null,
    format,
    status,
    is_adult: media.isAdult ?? null,
    source_material: media.source ?? null
  }, 'anilist')
  await applyResolution(client, animeId, resolution)

  if (media.idMal) await writeMalId(client, animeId, media.idMal)

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

/**
 * Re-attempt the external ids that were refused earlier.
 *
 * The ordinary run cannot do this. It selects rows whose synopsis is still
 * NULL, and a row that hit a collision was enriched successfully — only its
 * MAL id was withheld. So once the collision is actually resolved (the
 * duplicate merged, the holder deleted) nothing would ever go back and attach
 * the id, and the mapping would stay missing forever.
 *
 * Cheap enough to run after any merge: it touches only the recorded conflicts,
 * and one that still collides simply stays recorded.
 */
export async function retryMappingConflicts (): Promise<{ retried: number, attached: number }> {
  const { rows } = await pool.query<{ id: string, anime_id: string, external_id: string }>(
    `SELECT id, anime_id, external_id FROM mapping_conflicts
      WHERE provider = 'mal' AND resolved_at IS NULL
      ORDER BY last_seen DESC`
  )
  let attached = 0
  for (const row of rows) {
    const outcome = await transaction(async client => writeMalId(client, row.anime_id, Number(row.external_id)))
    if (outcome === 'written' || outcome === 'unchanged') {
      attached++
      await pool.query(
        `UPDATE mapping_conflicts SET resolved_at = now(), resolution = $2 WHERE id = $1`,
        [row.id, outcome === 'written' ? 'attached on retry' : 'already attached']
      )
    }
  }
  return { retried: rows.length, attached }
}

/** Drive the enrichment across every anime that has an anilist_id. */
export async function enrichFromAniList (
  opts: {
    limit?: number
    onlyMissing?: boolean
    onProgress?: (done: number, total: number, updated: number) => void | Promise<void>
    /**
     * Asked between batches. A full pass is half an hour of paced requests,
     * so "stop" has to mean something before the end of it — but only at a
     * batch boundary, so a stop never leaves a half-written transaction.
     */
    shouldStop?: () => boolean | Promise<boolean>
  } = {}
): Promise<{ processed: number, updated: number, failed: number, rowFailures: number, conflicts: number }> {
  const onlyMissing = opts.onlyMissing ?? true
  const startedAt = new Date()
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
  let rowFailures = 0

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    try {
      const media = await fetchMediaBatch(batch)
      await transaction(async client => {
        const caches = await loadCaches(client)
        for (const m of media) {
          // A savepoint per row, so a row that fails costs one row.
          //
          // Without this the batch is all-or-nothing, and it was: a single
          // duplicate MAL id raised inside the transaction, Postgres marked
          // the whole thing aborted, and 49 rows that had already been written
          // correctly were rolled back with it. Over one run that turned
          // ~200 genuine collisions into 9 650 rows not imported.
          //
          // The savepoint is released on success and rolled back to on
          // failure, which leaves the surrounding transaction usable either
          // way — that is the property the old code did not have.
          await client.query('SAVEPOINT row')
          try {
            if (await upsertMedia(client, m, caches)) updated++
            await client.query('RELEASE SAVEPOINT row')
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT row')
            rowFailures++
            // Identify it by the id we asked for; the local row may be exactly
            // what could not be read.
            console.error(`  anilist_id ${m.id}: ${(err as Error).message}`)
          }
        }
      })
    } catch (err) {
      // Still possible: the fetch failed, or the connection dropped. That is a
      // whole-batch problem and stays counted as one.
      failed += batch.length
      console.error(`batch ${i / 50 + 1} failed:`, (err as Error).message)
    }
    processed += batch.length
    await opts.onProgress?.(processed, total, updated)
    if (await opts.shouldStop?.()) break
    if (i + 50 < ids.length) await sleep(DELAY_MS)
  }

  const { rows: conflicts } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM mapping_conflicts
      WHERE source = 'anilist-enrich' AND resolved_at IS NULL AND last_seen >= $1`, [startedAt]
  )
  return { processed, updated, failed, rowFailures, conflicts: Number(conflicts[0]?.n ?? 0) }
}
