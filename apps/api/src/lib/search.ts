// Catalogue search.
//
// The previous implementation scored every candidate with a single
// `similarity()` call against canonical_title and the synonym list, took the
// top 200 and re-sorted them in JavaScript. Two things were wrong with it:
// alternative titles stored in anime_titles (romaji / english / native) were
// never matched at all, and a fuzzy near-miss could outrank an exact title.
//
// Ranking is now tiered. A result's tier is decided by *how* it matched, and
// only inside a tier does the fuzzy score matter:
//
//   100  the canonical title is exactly the query
//    90  a romaji / english / native title is exactly the query
//    80  a synonym is exactly the query
//    70  a title starts with the query        ("attack on" → Attack on Titan)
//    60  a title contains the query
//    40  full-text match (websearch_to_tsquery over the stored tsvector)
//    20  trigram similarity only — the typo-tolerant tail
//
// Ties inside a tier break on similarity, then popularity. That ordering is
// what makes "one piece" return One Piece rather than One Piece Film: Red,
// which the old single-score ranking could not guarantee.
//
// This runs entirely in Postgres. The docker-compose file carries an
// OpenSearch service, but at 25k catalogue rows pg_trgm + tsvector answer in
// single-digit milliseconds off the indexes added in migration 0017; a second
// search engine would cost ~1 GB of RAM on the VPS and an operational
// dependency for no measurable gain. See docs/search.md.

import type pg from 'pg'

export const SEARCH_SORTS = {
  relevance: null, // tier → similarity → popularity (the default)
  popularity: 'a.popularity DESC NULLS LAST',
  score: 'a.average_score DESC NULLS LAST',
  newest: 'a.start_date DESC NULLS LAST',
  title: 'a.canonical_title ASC'
} as const

export type SearchSort = keyof typeof SEARCH_SORTS

export interface SearchFilters {
  genre?: string | undefined
  year?: number | undefined
  season?: string | undefined
  format?: string | undefined
  status?: string | undefined
  nsfw?: boolean | undefined
  sort?: SearchSort | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export interface SearchRow {
  id: string
  canonical_title: string
  format: string | null
  status: string | null
  season: string | null
  season_year: number | null
  episode_count: number | null
  average_score: number | null
  popularity: number | null
  is_adult: boolean
  cover_key: string | null
  /** the web client navigates by AniList id, so it travels with each row */
  anilist_id: number | null
  tier: number
  sim: number
  matched_title: string | null
}

/**
 * Trim a user query down to something safe to feed the matchers.
 * Trigram operators cope with anything, but a query of only punctuation
 * produces a useless full-table fuzzy scan, so it is rejected upstream.
 */
export function prepareQuery (raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** Lowercased, accent-stripped form recorded in search_stats.normalized. */
export function normaliseQuery (raw: string): string {
  return raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Build the tiered search SQL. Extracted from the route so the parameter
 * layout and filter composition can be asserted in unit tests without a
 * database connection.
 */
export interface SearchSqlOptions {
  /**
   * Include the trigram-similarity (`%`) predicates — the typo-tolerant tier.
   *
   * They are the entire cost of this endpoint. `%` asks the GIN trigram index
   * for every row that shares *enough* trigrams to clear the similarity
   * threshold, which the index answers by OR-ing the posting lists of all of
   * them and rechecking each candidate against the heap. Measured on 25k
   * anime / 150k synonyms, `q=naruto`:
   *
   *   with `%`      planning 3.6 ms + execution 17.8 ms   (1449 index rows on
   *                                                        synonyms alone, of
   *                                                        which 1028 are then
   *                                                        thrown away)
   *   without `%`   planning 0.4 ms + execution  0.5 ms
   *
   * `ILIKE '%q%'` uses the *same* index and is 25x cheaper, because LIKE
   * requires every trigram (an AND) instead of enough of them.
   */
  fuzzy?: boolean
}

export function buildSearchSql (filters: SearchFilters, options: SearchSqlOptions = {}): { sql: string, params: unknown[] } {
  const fuzzy = options.fuzzy ?? true
  const params: unknown[] = []
  const push = (v: unknown): string => { params.push(v); return `$${params.length}` }

  // $1 is always the query text; searchAnime fills it in before executing.
  params.push('')

  const where: string[] = ["a.visibility = 'public'"]
  if (!filters.nsfw) where.push('NOT a.is_adult')
  if (filters.year) where.push(`a.season_year = ${push(filters.year)}`)
  if (filters.season) where.push(`a.season = ${push(filters.season)}::anime_season`)
  if (filters.format) where.push(`a.format = ${push(filters.format)}::anime_format`)
  if (filters.status) where.push(`a.status = ${push(filters.status)}::anime_status`)
  if (filters.genre) {
    // Slug OR name, case-insensitively — the client shows genre names, so it
    // sends "Action" and not "action". See the same fix in routes/anime.ts.
    const g = push(filters.genre)
    where.push(`EXISTS (SELECT 1 FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id
                         WHERE ag.anime_id = a.id AND (g.slug = lower(${g}) OR lower(g.name) = lower(${g})))`)
  }

  const explicitSort = filters.sort && filters.sort !== 'relevance' ? SEARCH_SORTS[filters.sort] : null
  const order = explicitSort
    ? `${explicitSort}, m.tier DESC, m.id`
    : 'm.tier DESC, m.sim DESC, a.popularity DESC NULLS LAST, a.id'

  const limit = push(Math.min(50, Math.max(1, filters.limit ?? 20)))
  const offset = push(Math.max(0, filters.offset ?? 0))

  // `matches` collects every way a row can match, one row per match; the
  // outer DISTINCT ON keeps the strongest tier per anime.
  const sql = `
    WITH matches AS (
      SELECT a.id,
             CASE WHEN lower(a.canonical_title) = lower($1) THEN 100
                  WHEN lower(a.canonical_title) LIKE lower($1) || '%' THEN 70
                  WHEN a.canonical_title ILIKE '%' || $1 || '%' THEN 60
                  WHEN a.search @@ websearch_to_tsquery('simple', $1) THEN 40
                  ELSE 20 END AS tier,
             similarity(a.canonical_title, $1) AS sim,
             a.canonical_title AS matched_title
        FROM anime a
       WHERE ${fuzzy ? 'a.canonical_title % $1 OR ' : ''}a.canonical_title ILIKE '%' || $1 || '%'
          OR a.search @@ websearch_to_tsquery('simple', $1)

      UNION ALL

      SELECT t.anime_id,
             CASE WHEN lower(t.title) = lower($1) THEN 90
                  WHEN lower(t.title) LIKE lower($1) || '%' THEN 70
                  WHEN t.title ILIKE '%' || $1 || '%' THEN 60
                  ELSE 20 END,
             similarity(t.title, $1), t.title
        FROM anime_titles t
       WHERE ${fuzzy ? 't.title % $1 OR ' : ''}t.title ILIKE '%' || $1 || '%'

      UNION ALL

      SELECT s.anime_id,
             CASE WHEN lower(s.synonym) = lower($1) THEN 80
                  WHEN lower(s.synonym) LIKE lower($1) || '%' THEN 70
                  WHEN s.synonym ILIKE '%' || $1 || '%' THEN 60
                  ELSE 20 END,
             similarity(s.synonym, $1), s.synonym
        FROM anime_synonyms s
       WHERE ${fuzzy ? 's.synonym % $1 OR ' : ''}s.synonym ILIKE '%' || $1 || '%'
    ),
    best AS (
      SELECT DISTINCT ON (id) id, tier, sim, matched_title
        FROM matches
       ORDER BY id, tier DESC, sim DESC
    )
    SELECT a.id, a.canonical_title, a.format::text, a.status::text, a.season::text,
           a.season_year, a.episode_count, a.average_score, a.popularity, a.is_adult,
           img.object_key AS cover_key, map.anilist_id,
           m.tier, round(m.sim::numeric, 4) AS sim, m.matched_title
      FROM best m
      JOIN anime a ON a.id = m.id
      LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
      LEFT JOIN anime_mappings map ON map.anime_id = a.id
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}
     LIMIT ${limit} OFFSET ${offset}`

  return { sql, params }
}

/**
 * Run a tiered catalogue search.
 *
 * Two passes, and the second one usually does not happen.
 *
 * The fuzzy (`%`) predicates cost ~25x what the rest of the query costs, and
 * they only ever produce tier-20 rows — the typo-tolerant tail. Under the
 * default `relevance` order (`tier DESC, sim DESC, …`) a tier-20 row sits
 * below every exact, prefix, substring and full-text match there is. So when
 * the cheap pass already fills the requested page, no tier-20 row could have
 * appeared on it, and running the expensive predicates would have changed
 * nothing but the response time. `q=naruto` is exactly that case, and so is
 * every query a viewer spells correctly.
 *
 * The fallback is not an optimisation of the typo case, only of the common
 * one: a short page from the cheap pass means the fuzzy pass runs in full and
 * its result — not the partial one — is returned.
 *
 * An explicit sort is excluded on purpose. Ordering by popularity or score
 * makes `tier` a tiebreak rather than the primary key, so a fuzzy-only row
 * *can* outrank an exact one, and skipping it would change the answer. That
 * path keeps the single full query it always had.
 */
export async function searchAnime (
  db: { query: pg.Pool['query'] },
  rawQuery: string,
  filters: SearchFilters = {}
): Promise<SearchRow[]> {
  const q = prepareQuery(rawQuery)
  if (!q) return []

  const limit = Math.min(50, Math.max(1, filters.limit ?? 20))
  const rankedByRelevance = !filters.sort || filters.sort === 'relevance'

  if (rankedByRelevance) {
    const cheap = buildSearchSql(filters, { fuzzy: false })
    cheap.params[0] = q
    const { rows } = await db.query(cheap.sql, cheap.params)
    // A full page cannot be improved on by rows that rank below all of it.
    if (rows.length >= limit) return rows as SearchRow[]
  }

  const { sql, params } = buildSearchSql(filters)
  params[0] = q
  const { rows } = await db.query(sql, params)
  return rows as SearchRow[]
}

/**
 * Record the query for the zero-result report in the admin analytics page.
 * Best effort: telemetry must never fail a search. Only the query text and
 * result count are stored — no IP, no user agent.
 */
export async function recordSearch (
  db: { query: pg.Pool['query'] },
  rawQuery: string,
  resultCount: number,
  profileId?: string | null
): Promise<void> {
  const q = prepareQuery(rawQuery)
  if (!q) return
  // the header is client-supplied; only a well-formed uuid is stored
  const profile = profileId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)
    ? profileId
    : null
  try {
    await db.query(
      'INSERT INTO search_stats (query, normalized, result_count, profile_id) VALUES ($1, $2, $3, $4)',
      [q, normaliseQuery(q), resultCount, profile]
    )
  } catch {
    // a missing partition or a busy database must not break search
  }
}

/** Suggestions for the quick-search box: titles only, tier-ordered, cheap. */
export async function suggest (
  db: { query: pg.Pool['query'] },
  rawQuery: string,
  limit = 8,
  nsfw = false
): Promise<Array<{ id: string, anilist_id: number | null, canonical_title: string, cover_key: string | null, season_year: number | null, format: string | null, episode_count: number | null }>> {
  const rows = await searchAnime(db, rawQuery, { limit, nsfw })
  return rows.map(r => ({
    id: r.id,
    anilist_id: r.anilist_id,
    canonical_title: r.canonical_title,
    cover_key: r.cover_key,
    season_year: r.season_year,
    format: r.format,
    episode_count: r.episode_count
  }))
}
