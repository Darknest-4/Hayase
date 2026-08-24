// Database text-encoding health.
//
// Yume serves a Hungarian audience, and Hungarian is where a mis-encoded
// database stops being a footnote. Under SQL_ASCII Postgres does not interpret
// bytes at all, so every multi-byte character is treated as a run of separate
// ones. The consequences are not subtle:
//
//   lower('ÁRVÍZTŰRŐ')        → 'ÁrvÍztŰrŐ'   accented letters never fold
//   'Álom' < 'Zebra'          → false          byte order, not alphabet
//   'ÁLOM' ILIKE '%álom%'     → false          case-insensitive match misses
//   length('á')               → 2              character limits become byte limits
//
// That matters here more than in most projects because search.ts matches on
// lower() and ILIKE in all three of its tiers — title, alternative titles and
// synonyms. A viewer typing an accented title in lower case gets wrong results
// today, before a single string has been translated.
//
// Encoding cannot be changed after initdb. The only fix is to create the
// database correctly, which is why this is checked at two moments and answered
// differently at each — see `assess`.

/** What the database reports about itself. */
export interface EncodingFacts {
  serverEncoding: string
  collate: string
  ctype: string
  /**
   * True when no migration has been applied yet, i.e. the schema is about to
   * be created. This is the one moment when refusing to continue costs
   * nothing, because there is no data to lose and recreating is a one-liner.
   */
  freshDatabase: boolean
}

export type EncodingLevel = 'ok' | 'warn' | 'fatal'

export interface EncodingVerdict {
  level: EncodingLevel
  /** Machine-readable reasons, so diagnostics can render them individually. */
  problems: string[]
  message: string
}

const RECREATE_HINT =
  "  Recreate the database with:\n" +
  "    CREATE DATABASE yume ENCODING 'UTF8' LOCALE 'C.UTF-8' TEMPLATE template0;\n" +
  '  Under Docker, set POSTGRES_INITDB_ARGS in docker-compose.yml (already done\n' +
  '  for new clusters) and start from an empty volume.'

/**
 * Judge a set of facts.
 *
 * Pure and synchronous so the policy can be tested without a database — the
 * policy is the interesting part, the query is not.
 *
 * The two-level answer is deliberate. Refusing to boot protects an empty
 * database from being populated wrongly; refusing to boot against an existing
 * production database would turn a text-handling defect into an outage, which
 * is strictly worse than the defect. So: fail closed while it is free, warn
 * loudly once it is not.
 */
export function assess (facts: EncodingFacts): EncodingVerdict {
  const problems: string[] = []

  if (facts.serverEncoding !== 'UTF8') problems.push(`encoding is ${facts.serverEncoding}, not UTF8`)

  // C and POSIX sort by byte value, which is not the Hungarian alphabet. This
  // is recoverable per-query with COLLATE, so it is never fatal on its own.
  if (facts.collate === 'C' || facts.collate === 'POSIX') {
    problems.push(`collation is ${facts.collate}, so ORDER BY follows byte order rather than any alphabet`)
  }

  if (!problems.length) {
    return { level: 'ok', problems, message: 'database encoding is UTF8' }
  }

  const encodingBroken = facts.serverEncoding !== 'UTF8'
  const level: EncodingLevel = encodingBroken && facts.freshDatabase ? 'fatal' : encodingBroken ? 'warn' : 'warn'

  const lines = [
    level === 'fatal'
      ? 'Refusing to create the schema on a database that cannot store Hungarian text correctly.'
      : 'Database text handling is degraded for non-ASCII text.',
    ...problems.map(p => `  - ${p}`)
  ]

  if (encodingBroken) {
    lines.push(
      '  Effect: lower()/ILIKE do not fold accented letters, so search misses them,',
      '  and length() counts bytes, so text limits apply at a fraction of their size.'
    )
    lines.push(RECREATE_HINT)
    if (level === 'warn') {
      lines.push('  This database already has data, so startup continues — but the defect is real.')
    }
  } else {
    lines.push('  Use COLLATE "hu-HU-x-icu" on queries that sort Hungarian text for display.')
  }

  return { level, problems, message: lines.join('\n') }
}

/** Ask the database about itself. */
export async function readFacts (
  runQuery: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>,
  freshDatabase: boolean
): Promise<EncodingFacts> {
  const rows = await runQuery(
    `SELECT pg_encoding_to_char(encoding) AS server_encoding,
            datcollate                    AS collate,
            datctype                      AS ctype
       FROM pg_database
      WHERE datname = current_database()`
  )
  const row = rows[0] ?? {}
  return {
    serverEncoding: String(row.server_encoding ?? 'unknown'),
    collate: String(row.collate ?? 'unknown'),
    ctype: String(row.ctype ?? 'unknown'),
    freshDatabase
  }
}

/** Read, judge, and report. Returns the verdict so callers can decide to exit. */
export async function check (
  runQuery: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>,
  freshDatabase: boolean,
  log: { warn: (msg: string) => void, error: (msg: string) => void } = console
): Promise<EncodingVerdict> {
  const verdict = assess(await readFacts(runQuery, freshDatabase))
  if (verdict.level === 'fatal') log.error(verdict.message)
  else if (verdict.level === 'warn') log.warn(verdict.message)
  return verdict
}
