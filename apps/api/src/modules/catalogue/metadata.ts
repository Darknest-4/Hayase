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
// without a database — and that is now the whole of this file. The statements
// that write a resolution, move a lock or merge two entries live in
// ./metadata-repository.ts; what is left here is the reasoning, which is the
// part worth reading twice and the part a test can drive with no Postgres
// behind it.

/** Known metadata providers, ranked. Higher wins. */
/** Module-local: read through rankOf(), which is the exported view of it. */
const PROVIDER_RANK: Record<string, number> = {
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
