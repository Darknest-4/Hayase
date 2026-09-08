// The catalogue's metadata persistence: applying a resolution, moving a human
// lock, finding duplicates and merging two entries into one.
//
// Split from ./metadata.ts, which now holds only the precedence rules. The
// division is the useful one: that file decides *whether* an incoming value
// may land, this one performs it. The decision is pure and unit-tested without
// a database; the SQL is here where an architecture rule can see it.
//
// Most of these take the caller's `client` rather than opening their own
// transaction. Merging two anime is six statements that must all land or none
// of them, and the caller usually has more to do in the same unit — the audit
// entry, the webhook. A repository that grabbed its own connection would make
// that impossible.

import type pg from 'pg'

import { MANAGED_FIELDS, type Resolution, type SourceMap } from './metadata.ts'

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
