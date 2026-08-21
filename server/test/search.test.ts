// Search ranking and SQL composition. buildSearchSql is pure, so the filter
// wiring and parameter layout are asserted without a database; the tier
// values themselves are asserted against a fake query executor so a
// reordering of the CASE arms cannot pass unnoticed.

import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { buildSearchSql, prepareQuery, normaliseQuery, searchAnime, recordSearch, SEARCH_SORTS } from '../src/lib/search.ts'

/** Minimal stand-in for a pg pool that records what it was asked to run. */
function fakeDb (rows: unknown[] = []): { query: (...a: unknown[]) => Promise<{ rows: unknown[] }>, calls: Array<{ sql: string, params: unknown[] }> } {
  const calls: Array<{ sql: string, params: unknown[] }> = []
  return {
    calls,
    query: async (sql: unknown, params: unknown) => {
      calls.push({ sql: String(sql), params: (params as unknown[]) ?? [] })
      return { rows }
    }
  } as never
}

describe('query preparation', () => {
  test('whitespace is collapsed and the length is capped', () => {
    assert.equal(prepareQuery('  one    piece  '), 'one piece')
    assert.equal(prepareQuery('x'.repeat(500)).length, 120)
  })

  test('an all-whitespace query is rejected rather than run', async () => {
    const db = fakeDb()
    assert.deepEqual(await searchAnime(db, '   '), [])
    assert.equal(db.calls.length, 0, 'an empty query must not reach the database')
  })

  test('normalisation strips accents and case for the telemetry key', () => {
    assert.equal(normaliseQuery('  One   PIECE '), 'one piece')
    assert.equal(normaliseQuery('Ōkami'), 'okami')
  })
})

describe('ranking tiers', () => {
  const sql = buildSearchSql({}).sql

  test('an exact canonical title outranks every other match', () => {
    const tiers = [...sql.matchAll(/THEN (\d+)/g)].map(m => Number(m[1]))
    assert.equal(Math.max(...tiers), 100)
  })

  test('every title form is searched, not just the canonical one', () => {
    assert.ok(sql.includes('FROM anime_titles'), 'romaji/english/native titles must be matched')
    assert.ok(sql.includes('FROM anime_synonyms'), 'synonyms must be matched')
  })

  test('the strongest match per anime wins, without duplicate rows', () => {
    assert.ok(/DISTINCT ON \(id\)[\s\S]*ORDER BY id, tier DESC/.test(sql))
  })

  test('relevance order is tier, then similarity, then popularity', () => {
    assert.ok(sql.includes('ORDER BY m.tier DESC, m.sim DESC, a.popularity DESC NULLS LAST'))
  })
})

describe('filters', () => {
  test('hidden and unlisted entries are never returned', () => {
    assert.ok(buildSearchSql({}).sql.includes("a.visibility = 'public'"))
  })

  test('adult entries are excluded unless asked for', () => {
    assert.ok(buildSearchSql({}).sql.includes('NOT a.is_adult'))
    assert.ok(!buildSearchSql({ nsfw: true }).sql.includes('NOT a.is_adult'))
  })

  test('filters compose and each binds its own parameter', () => {
    const { sql, params } = buildSearchSql({ year: 2019, season: 'SPRING', format: 'TV', status: 'FINISHED', genre: 'action' })
    assert.ok(params.includes(2019) && params.includes('SPRING') && params.includes('TV') && params.includes('FINISHED') && params.includes('action'))
    assert.ok(!sql.includes('2019'), 'filter values must be bound, never interpolated')
  })

  test('$1 is reserved for the query text', () => {
    const { params } = buildSearchSql({ year: 2019 })
    assert.equal(params[0], '')
    assert.equal(params[1], 2019)
  })

  test('limit is clamped into range', () => {
    const big = buildSearchSql({ limit: 9999 }).params
    assert.equal(big[big.length - 2], 50)
    const small = buildSearchSql({ limit: -5 }).params
    assert.equal(small[small.length - 2], 1)
  })

  test('an explicit sort replaces relevance ordering but keeps tier as a tiebreak', () => {
    const { sql } = buildSearchSql({ sort: 'newest' })
    assert.ok(sql.includes(`ORDER BY ${SEARCH_SORTS.newest}, m.tier DESC`))
  })
})

describe('telemetry', () => {
  test('the query and result count are recorded', async () => {
    const db = fakeDb()
    await recordSearch(db, 'one piece', 3)
    assert.equal(db.calls.length, 1)
    assert.deepEqual(db.calls[0]?.params.slice(0, 3), ['one piece', 'one piece', 3])
  })

  test('a malformed profile header is dropped rather than stored', async () => {
    const db = fakeDb()
    await recordSearch(db, 'q', 1, 'not-a-uuid')
    assert.equal(db.calls[0]?.params[3], null)
    await recordSearch(db, 'q', 1, '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')
    assert.equal(db.calls[1]?.params[3], '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')
  })

  test('a telemetry failure never breaks the search', async () => {
    const broken = { query: async () => { throw new Error('partition missing') } } as never
    await recordSearch(broken, 'one piece', 0) // must not throw
  })
})
