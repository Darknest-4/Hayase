// Metadata normalisation and conflict resolution.
//
// Before this layer existed the AniList enricher wrote straight onto the anime
// row with `coalesce($new, $current)`, so any value an administrator had
// corrected by hand was silently replaced the next time the importer ran.
//
// Every automatic write now goes through `resolveFields`, which decides — per
// field — whether the incoming value may land, based on:
//
//   1. anime.locked_fields — fields a human edited. Automatic sources never
//      touch these. This is absolute and comes first.
//   2. provider precedence — a lower-ranked source cannot overwrite a value a
//      higher-ranked source already set (recorded in anime.metadata_sources).
//   3. emptiness — a missing incoming value never erases a stored one.
//
// The decision function is pure so the precedence rules can be unit-tested
// without a database.

import type pg from 'pg'

/** Known metadata providers, ranked. Higher wins. */
export const PROVIDER_RANK: Record<string, number> = {
  manual: 100, // a human in the catalogue admin
  anilist: 60, //  richest automatic source
  mal: 50,
  aod: 30, //      anime-offline-database (the seed)
  stub: 10 //      placeholder row created by /v1/anime/resolve
}

export const rankOf = (provider: string): number => PROVIDER_RANK[provider] ?? 0

/**
 * Fields this layer governs. Anything not listed is either derived
 * (search vectors), relational (genres, titles) or operational (visibility)
 * and is handled by its own code path.
 */
export const MANAGED_FIELDS = [
  'canonical_title', 'synopsis', 'season', 'season_year', 'start_date', 'end_date',
  'episode_count', 'episode_duration', 'format', 'status', 'is_adult', 'source_material',
  'average_score', 'popularity', 'country', 'age_rating'
] as const

export type ManagedField = typeof MANAGED_FIELDS[number]

/**
 * Time-varying statistics rather than canonical facts. A fresher reading is
 * always better than an older one, so precedence does not apply — but a
 * human lock still does (an operator may pin a score for a curated row).
 */
const VOLATILE = new Set<string>(['average_score', 'popularity'])

export interface FieldSource { provider: string, at: string }
export type SourceMap = Record<string, FieldSource>

export interface CurrentRow {
  locked_fields?: string[] | null
  metadata_sources?: SourceMap | null
  [field: string]: unknown
}

export interface Resolution {
  /** field → value that should be written */
  apply: Record<string, unknown>
  /** field → why it was not written (for operator-facing import reports) */
  skipped: Record<string, 'locked' | 'empty' | 'lower-precedence' | 'unchanged'>
  /** the new metadata_sources map, only when something is applied */
  sources: SourceMap
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/** Loose equality across the pg driver's representations (dates, numerics). */
function sameValue (a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a instanceof Date || b instanceof Date) {
    const da = a instanceof Date ? a : new Date(String(a))
    const db = b instanceof Date ? b : new Date(String(b))
    return !isNaN(da.getTime()) && !isNaN(db.getTime()) && da.getTime() === db.getTime()
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return false
}

/**
 * Decide which incoming fields may be written onto an existing row.
 * Pure: no database, no clock beyond the injected `now`.
 */
export function resolveFields (
  current: CurrentRow,
  incoming: Partial<Record<ManagedField, unknown>>,
  provider: string,
  now: Date = new Date()
): Resolution {
  const locked = new Set(current.locked_fields ?? [])
  const sources: SourceMap = { ...(current.metadata_sources ?? {}) }
  const apply: Record<string, unknown> = {}
  const skipped: Resolution['skipped'] = {}
  const incomingRank = rankOf(provider)
  const stamp = now.toISOString()

  for (const field of MANAGED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue
    const value = incoming[field]

    // 1. human edits are never overwritten by an automatic source
    if (locked.has(field) && provider !== 'manual') { skipped[field] = 'locked'; continue }

    // 2. a missing incoming value must not erase what we already have
    if (isEmpty(value)) { skipped[field] = 'empty'; continue }

    const stored = current[field]
    if (sameValue(stored, value)) {
      // still record provenance the first time we see it from this provider
      if (!sources[field]) sources[field] = { provider, at: stamp }
      skipped[field] = 'unchanged'
      continue
    }

    // 3. precedence — but an empty stored value is always fillable, and
    //    volatile statistics always take the freshest reading
    if (!isEmpty(stored) && !VOLATILE.has(field)) {
      const owner = sources[field]?.provider
      if (owner && rankOf(owner) > incomingRank) { skipped[field] = 'lower-precedence'; continue }
    }

    apply[field] = value
    sources[field] = { provider, at: stamp }
  }

  return { apply, skipped, sources }
}

/** Columns needed by resolveFields — select these before calling it. */
export const CURRENT_COLUMNS = ['id', 'locked_fields', 'metadata_sources', ...MANAGED_FIELDS].join(', ')

const CASTS: Record<string, string> = {
  season: '::anime_season',
  format: '::anime_format',
  status: '::anime_status',
  start_date: '::date',
  end_date: '::date'
}

/**
 * Apply a resolution to the anime row. Returns the number of fields written.
 * Always updates metadata_sources so provenance is recorded even when the
 * values themselves were already correct.
 */
export async function applyResolution (
  client: pg.PoolClient,
  animeId: string,
  resolution: Resolution
): Promise<number> {
  const fields = Object.keys(resolution.apply)
  const values: unknown[] = [animeId, JSON.stringify(resolution.sources)]
  const sets = fields.map(field => {
    values.push(resolution.apply[field])
    return `${field} = $${values.length}${CASTS[field] ?? ''}`
  })
  sets.push('metadata_sources = $2::jsonb')
  if (fields.length) sets.push('updated_at = now()')

  await client.query(`UPDATE anime SET ${sets.join(', ')} WHERE id = $1`, values)
  return fields.length
}

/** Mark fields as human-owned so importers stop touching them. */
export async function lockFields (
  client: pg.PoolClient | { query: pg.Pool['query'] },
  animeId: string,
  fields: string[],
  now: Date = new Date()
): Promise<void> {
  const managed = fields.filter(f => (MANAGED_FIELDS as readonly string[]).includes(f))
  if (!managed.length) return
  const sources: SourceMap = {}
  for (const f of managed) sources[f] = { provider: 'manual', at: now.toISOString() }
  await client.query(
    `UPDATE anime
        SET locked_fields = (SELECT array_agg(DISTINCT x) FROM unnest(locked_fields || $2::text[]) x),
            metadata_sources = metadata_sources || $3::jsonb
      WHERE id = $1`,
    [animeId, managed, JSON.stringify(sources)]
  )
}

/** Release a lock so automatic sources own the field again. */
export async function unlockFields (
  client: pg.PoolClient | { query: pg.Pool['query'] },
  animeId: string,
  fields: string[]
): Promise<void> {
  if (!fields.length) return
  await client.query(
    `UPDATE anime
        SET locked_fields = coalesce((SELECT array_agg(x) FROM unnest(locked_fields) x WHERE NOT (x = ANY($2::text[]))), '{}')
      WHERE id = $1`,
    [animeId, fields]
  )
}

// ---------------------------------------------------------------------------
// normalisation — used for duplicate detection and search keys
// ---------------------------------------------------------------------------

const ROMAN = /\b(?:i{1,3}|iv|v|vi{1,3}|ix|x)\b/g
const ROMAN_VALUE: Record<string, string> = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10'
}

/**
 * Fold a title down to a comparison key: lowercase, accents stripped,
 * punctuation removed, season markers and roman numerals normalised.
 * "Fate/Zero 2nd Season" and "Fate Zero Season 2" collapse to the same key.
 */
export function normaliseTitle (title: string): string {
  let s = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  s = s.replace(/[‘’“”]/g, "'")
  s = s.replace(/[^a-z0-9\s'&]+/g, ' ')
  s = s.replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, 'season $1')
  s = s.replace(/\bseason\s+(\d+)\b/g, 'season $1')
  s = s.replace(ROMAN, m => ROMAN_VALUE[m] ?? m)
  s = s.replace(/\b(the|a|an)\b/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

export interface DuplicateCandidate {
  a_id: string
  b_id: string
  a_title: string
  b_title: string
  similarity: number
  season_year: number | null
  format: string | null
}

/**
 * Find likely duplicate catalogue entries: rows sharing a year and format
 * whose titles are near-identical. Restricted to the same (year, format)
 * bucket so the trigram comparison stays bounded — a full cross join over
 * 25k rows would not be.
 */
export async function findDuplicates (
  db: { query: pg.Pool['query'] },
  opts: { threshold?: number | undefined, limit?: number | undefined } = {}
): Promise<DuplicateCandidate[]> {
  const threshold = Math.min(0.99, Math.max(0.5, opts.threshold ?? 0.86))
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100))
  const { rows } = await db.query(
    `SELECT a.id AS a_id, b.id AS b_id,
            a.canonical_title AS a_title, b.canonical_title AS b_title,
            similarity(a.canonical_title, b.canonical_title) AS similarity,
            a.season_year, a.format::text AS format
       FROM anime a
       JOIN anime b
         ON b.id > a.id
        AND b.season_year IS NOT DISTINCT FROM a.season_year
        AND b.format IS NOT DISTINCT FROM a.format
        AND similarity(a.canonical_title, b.canonical_title) >= $1
      WHERE a.season_year IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM anime_relations r
                         WHERE (r.anime_id = a.id AND r.related_id = b.id)
                            OR (r.anime_id = b.id AND r.related_id = a.id))
      ORDER BY similarity DESC
      LIMIT $2`,
    [threshold, limit]
  )
  return rows as DuplicateCandidate[]
}

/**
 * Merge `sourceId` into `targetId`: relations, mappings, titles, synonyms,
 * genres, tags and library entries move across, then the source row is
 * deleted. Runs inside the caller's transaction.
 */
export async function mergeAnime (client: pg.PoolClient, targetId: string, sourceId: string): Promise<void> {
  if (targetId === sourceId) throw new Error('cannot merge an anime into itself')

  // alternative titles of the loser survive as synonyms of the winner
  await client.query(
    `INSERT INTO anime_synonyms (anime_id, synonym)
     SELECT $1::uuid, t.title FROM anime_titles t WHERE t.anime_id = $2
     UNION
     SELECT $1::uuid, canonical_title FROM anime WHERE id = $2
     UNION
     SELECT $1::uuid, s.synonym FROM anime_synonyms s WHERE s.anime_id = $2
     ON CONFLICT DO NOTHING`, [targetId, sourceId])

  // classification moves across, skipping pairs the target already has
  await client.query(
    `INSERT INTO anime_genres (anime_id, genre_id)
     SELECT $1::uuid, genre_id FROM anime_genres WHERE anime_id = $2
     ON CONFLICT DO NOTHING`, [targetId, sourceId])
  await client.query(
    `INSERT INTO anime_tags (anime_id, tag_id, rank)
     SELECT $1::uuid, tag_id, rank FROM anime_tags WHERE anime_id = $2
     ON CONFLICT DO NOTHING`, [targetId, sourceId])

  // library entries: a profile tracking both keeps the further progress
  await client.query(
    `INSERT INTO library_entries (profile_id, anime_id, status, progress, score, rewatches, notes, started_at, finished_at)
     SELECT profile_id, $1::uuid, status, progress, score, rewatches, notes, started_at, finished_at
       FROM library_entries WHERE anime_id = $2
     ON CONFLICT (profile_id, anime_id) DO UPDATE
       SET progress = greatest(library_entries.progress, excluded.progress),
           score = coalesce(library_entries.score, excluded.score)`, [targetId, sourceId])

  // relations are copied onto the winner (the source's rows disappear with
  // the row itself, via ON DELETE CASCADE); self-references are dropped
  await client.query(
    `INSERT INTO anime_relations (anime_id, related_id, relation)
     SELECT $1::uuid, related_id, relation FROM anime_relations WHERE anime_id = $2 AND related_id <> $1
     ON CONFLICT DO NOTHING`, [targetId, sourceId])
  await client.query(
    `INSERT INTO anime_relations (anime_id, related_id, relation)
     SELECT anime_id, $1::uuid, relation FROM anime_relations WHERE related_id = $2 AND anime_id <> $1
     ON CONFLICT DO NOTHING`, [targetId, sourceId])

  // external ids: keep the target's, fill any gaps from the source
  await client.query(
    `UPDATE anime_mappings t SET
       anilist_id = coalesce(t.anilist_id, s.anilist_id),
       mal_id     = coalesce(t.mal_id, s.mal_id),
       updated_at = now()
     FROM anime_mappings s WHERE t.anime_id = $1 AND s.anime_id = $2`, [targetId, sourceId])

  await client.query('DELETE FROM anime WHERE id = $1', [sourceId])
}
