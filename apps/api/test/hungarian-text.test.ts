// Hungarian text handling — the encoding policy and what the database
// actually does with accented letters.
//
// The policy half is pure and always runs. The database half runs only when
// DATABASE_URL is set, and it asserts the things migration 0022 promises
// rather than assuming them: that the ICU collation exists, that unaccent is
// installed, and that folding actually works on this cluster.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { assess } from '../src/lib/db-encoding.ts'

describe('encoding policy', () => {
  const utf8 = { serverEncoding: 'UTF8', collate: 'C.UTF-8', ctype: 'C.UTF-8', freshDatabase: false }

  it('passes a UTF8 database', () => {
    assert.equal(assess(utf8).level, 'ok')
    assert.deepEqual(assess(utf8).problems, [])
  })

  it('refuses to create a schema on a non-UTF8 database', () => {
    const verdict = assess({ ...utf8, serverEncoding: 'SQL_ASCII', freshDatabase: true })
    assert.equal(verdict.level, 'fatal')
    assert.match(verdict.message, /Refusing to create the schema/)
  })

  it('only warns once the database has data', () => {
    // Refusing to boot against a populated production database would turn a
    // text-handling defect into an outage, which is strictly worse.
    const verdict = assess({ ...utf8, serverEncoding: 'SQL_ASCII', freshDatabase: false })
    assert.equal(verdict.level, 'warn')
    assert.match(verdict.message, /already has data/)
  })

  it('flags byte-order collation without ever calling it fatal', () => {
    // Recoverable per query with COLLATE, so it must never block a boot —
    // not even on a fresh database.
    for (const fresh of [true, false]) {
      const verdict = assess({ ...utf8, collate: 'C', freshDatabase: fresh })
      assert.equal(verdict.level, 'warn')
      assert.equal(verdict.problems.length, 1)
      assert.match(verdict.problems[0], /byte order/)
    }
  })

  it('names every problem it found, not just the first', () => {
    const verdict = assess({ serverEncoding: 'LATIN2', collate: 'POSIX', ctype: 'POSIX', freshDatabase: false })
    assert.equal(verdict.problems.length, 2)
    assert.match(verdict.message, /LATIN2/)
    assert.match(verdict.message, /POSIX/)
  })
})

// ---------------------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe('database text handling', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: import('pg').Pool
  const one = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>> => {
    const result = await pool.query(sql, params)
    return result.rows[0] as Record<string, unknown>
  }

  before(async () => {
    const pg = (await import('pg')).default
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  })
  after(async () => { await pool?.end() })

  it('runs on a UTF8 database', async () => {
    // Every assertion below is meaningless otherwise, so this one comes first
    // and says why rather than failing cryptically further down.
    const row = await one('SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()')
    assert.equal(row.enc, 'UTF8', 'the test database is not UTF8 — Hungarian text cannot behave correctly on it')
  })

  it('folds case for accented letters', async () => {
    const row = await one("SELECT lower('ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP') AS v")
    assert.equal(row.v, 'árvíztűrő tükörfúrógép')
  })

  it('matches case-insensitively across accents', async () => {
    const row = await one("SELECT ('ÁLOM' ILIKE '%álom%') AS v")
    assert.equal(row.v, true)
  })

  it('has the Hungarian ICU collation migration 0022 tells callers to use', async () => {
    const row = await one(`SELECT count(*)::int AS n FROM pg_collation WHERE collname = 'hu-HU-x-icu'`)
    assert.equal(row.n, 1)
  })

  it('sorts the Hungarian alphabet correctly under that collation', async () => {
    const row = await one(`
      SELECT string_agg(w, ' ' ORDER BY w COLLATE "hu-HU-x-icu") AS v
        FROM unnest(ARRAY['Zebra','Álom','Ödön','Cica','Űr']) w`)
    assert.equal(row.v, 'Álom Cica Ödön Űr Zebra')
  })

  it('folds accents for search', async () => {
    // The case this exists for: nobody types "támadás" on a phone.
    const row = await one("SELECT (yume_unaccent('Támadás') = 'Tamadas') AS v")
    assert.equal(row.v, true)
  })

  it('keeps yume_unaccent immutable so it can be indexed', async () => {
    // If this ever loosens, the indexes created in 0022 silently stop being
    // usable and search quietly falls back to sequential scans.
    const row = await one(`SELECT provolatile AS v FROM pg_proc WHERE proname = 'yume_unaccent'`)
    assert.equal(row.v, 'i')
  })

  it('stems Hungarian with accents folded first', async () => {
    const row = await one(`SELECT to_tsvector('hungarian_unaccent', 'A titánok támadása') @@ to_tsquery('hungarian_unaccent', 'tamadas') AS v`)
    assert.equal(row.v, true)
  })

  it('counts characters, not bytes', async () => {
    // Under SQL_ASCII this returns 9 and every length CHECK becomes a byte
    // limit at roughly half its documented size.
    const row = await one("SELECT length('árvíztűrő')::int AS v")
    assert.equal(row.v, 9)
  })
})
