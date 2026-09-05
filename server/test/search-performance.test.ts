// Guards on *how* catalogue search reaches the data, not on how fast the
// machine running the tests happens to be.
//
// The endpoint was ~28x slower than plain listing, and the cause was one
// operator: `%` (trigram similarity) asks a GIN index for every row sharing
// enough trigrams to clear the threshold, which it answers by OR-ing the
// posting lists of all of them and rechecking each candidate against the heap.
// On 25k anime / 150k synonyms, `q=naruto`:
//
//   with `%`      planning 3.6 ms + execution 17.8 ms
//   without `%`   planning 0.4 ms + execution  0.5 ms
//
// `ILIKE '%q%'` uses the same index 25x more cheaply, because LIKE needs every
// trigram rather than enough of them. So searchAnime runs the cheap predicates
// first and only pays for `%` when the cheap ones leave the page short.
//
// A wall-clock assertion would be the obvious test and the wrong one: it fails
// on a loaded CI box and passes on a fast one whatever the code does. These
// assert the mechanism instead — which query gets issued, and what the planner
// does with it — so they fail for the reason the regression would actually
// happen.

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { buildSearchSql, searchAnime } from '../src/lib/search.ts'

const HAS_DB = Boolean(process.env.DATABASE_URL)

/** A db stub that records every statement searchAnime issues. */
function spy (answers: unknown[][]): { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>, calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql)
      return { rows: answers[calls.length - 1] ?? [] }
    }
  }
}

const page = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ id: `row-${i}` }))

describe('the fuzzy predicates are opt-out', () => {
  test('the default query still carries them, so nothing else changes', () => {
    const { sql } = buildSearchSql({})
    assert.match(sql, /a\.canonical_title % \$1/)
    assert.match(sql, /t\.title % \$1/)
    assert.match(sql, /s\.synonym % \$1/)
  })

  test('the cheap query drops every one of them and keeps the rest', () => {
    const { sql } = buildSearchSql({}, { fuzzy: false })
    assert.doesNotMatch(sql, /% \$1/, 'no similarity operator may survive')
    // What it must still do: exact, prefix, substring and full-text.
    assert.match(sql, /ILIKE '%' \|\| \$1 \|\| '%'/)
    assert.match(sql, /websearch_to_tsquery\('simple', \$1\)/)
    assert.match(sql, /lower\(a\.canonical_title\) = lower\(\$1\)/)
  })

  test('both variants take the same parameters in the same order', () => {
    // The route fills params[0] with the query text; a divergence here would
    // silently search for the wrong string.
    const a = buildSearchSql({ year: 2019, genre: 'action', limit: 10 })
    const b = buildSearchSql({ year: 2019, genre: 'action', limit: 10 }, { fuzzy: false })
    assert.deepEqual(a.params, b.params)
  })
})

describe('which query searchAnime actually issues', () => {
  test('a full page costs one cheap query and nothing else', async () => {
    const db = spy([page(20)])
    await searchAnime(db, 'naruto', { limit: 20 })
    assert.equal(db.calls.length, 1, 'a filled page must not run the fuzzy query')
    assert.doesNotMatch(db.calls[0]!, /% \$1/)
  })

  test('a short page falls back to the fuzzy query and returns *its* rows', async () => {
    // The partial cheap result is discarded, not merged: the fuzzy query is a
    // superset, and returning the merge would double-count.
    const db = spy([page(3), page(7)])
    const rows = await searchAnime(db, 'one piece', { limit: 20 })
    assert.equal(db.calls.length, 2)
    assert.doesNotMatch(db.calls[0]!, /% \$1/)
    assert.match(db.calls[1]!, /% \$1/)
    assert.equal(rows.length, 7)
  })

  test('an explicit sort skips the fast path entirely', async () => {
    // Ordering by popularity makes tier a tiebreak rather than the primary
    // key, so a fuzzy-only row can outrank an exact one and dropping it would
    // change the answer.
    for (const sort of ['popularity', 'score', 'newest', 'title'] as const) {
      const db = spy([page(20)])
      await searchAnime(db, 'naruto', { limit: 20, sort })
      assert.equal(db.calls.length, 1, sort)
      assert.match(db.calls[0]!, /% \$1/, `${sort} must use the full query`)
    }
  })

  test('an empty query still touches the database not at all', async () => {
    const db = spy([])
    assert.deepEqual(await searchAnime(db, '   '), [])
    assert.equal(db.calls.length, 0)
  })
})

describe('the plan', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>, end: () => Promise<void> }

  const load = async (): Promise<typeof pool> => {
    pool ??= (await import('../src/db.ts')).pool as never
    return pool
  }

  after(async () => { await pool?.end() })

  /** Every node type the planner chose, flattened. */
  function nodes (plan: Record<string, unknown>, out: string[] = []): string[] {
    out.push(`${String(plan['Node Type'])} ${String(plan['Relation Name'] ?? '')}`.trim())
    for (const child of (plan.Plans ?? []) as Array<Record<string, unknown>>) nodes(child, out)
    return out
  }

  test('the cheap query reaches all three tables by index', async () => {
    // This is the regression that matters: a predicate that stops being
    // index-usable turns 25k anime and 150k synonyms into a sequential scan
    // on every keystroke, and nothing about the response would look wrong.
    const db = await load()
    const { sql, params } = buildSearchSql({ limit: 20 }, { fuzzy: false })
    params[0] = 'naruto'
    const { rows } = await db.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)
    const plan = (rows[0]!['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan
    const scans = nodes(plan).filter(n => n.startsWith('Seq Scan'))
    assert.deepEqual(scans, [], `sequential scans in the search plan: ${scans.join(', ')}`)
  })

  test('the fast path returns exactly what the full query would', async () => {
    // The whole optimisation rests on one claim: a tier-20 row cannot appear
    // on a page already filled by tier-40-and-better rows. If that stops being
    // true, searches quietly start returning a different answer.
    const db = await load()
    for (const q of ['naruto', 'one piece', 'attack on titan', 'steins', 'narutoo', 'zzzznope']) {
      for (const filters of [{ limit: 20 }, { limit: 5 }, { limit: 20, offset: 20 }]) {
        const fast = await searchAnime(db, q, filters)
        const full = buildSearchSql(filters)
        full.params[0] = q
        const { rows } = await db.query(full.sql, full.params)
        assert.deepEqual(
          fast.map(r => r.id),
          rows.map(r => r.id as string),
          `${q} ${JSON.stringify(filters)} diverged`
        )
      }
    }
  })
})
