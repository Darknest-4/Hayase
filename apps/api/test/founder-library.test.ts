// The founder's library: the whole catalogue, and the paging that makes it
// readable.
//
// Two things are checked together because they only make sense together. The
// seeder writes a library nothing else in this codebase produces — tens of
// thousands of entries — and the endpoint that reads it back had no limit at
// all until that library existed. A test for either alone would pass while the
// pair was unusable.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'founder-test-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '50'
process.env.RATE_LIMIT_MAX ??= '5000'

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
let seedFounderLibrary: typeof import('../src/modules/library/founder.ts').seedFounderLibrary
let levelFor: typeof import('../src/modules/library/founder.ts').levelFor

describe('the founder library', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  const username = 'fnd_' + randomBytes(5).toString('hex')
  let token = ''
  let profileId = ''
  let catalogue = 0

  before(async () => {
    const [{ buildApp }, db, founder] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/library/founder.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    seedFounderLibrary = founder.seedFounderLibrary
    levelFor = founder.levelFor
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, 'registration should succeed: ' + res.body)
    token = (res.json() as { accessToken: string }).accessToken

    const { rows } = await pool.query(
      'SELECT p.id FROM user_profiles p JOIN users u ON u.id = p.user_id WHERE u.username = $1', [username]
    )
    profileId = String(rows[0]!.id)
    const count = await pool.query('SELECT count(*)::int AS n FROM anime')
    catalogue = Number(count.rows[0]!.n)
    assert.ok(catalogue > 0, 'this test needs a catalogue to copy')
  })

  after(async () => {
    await pool?.query('DELETE FROM users WHERE username = $1', [username])
    await app?.close()
    await pool?.end()
  })

  const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}`, 'x-profile-id': profileId })

  /**
   * Seed, retrying a title that vanished underneath us.
   *
   * The suites run in parallel processes against one database and several of
   * them create and delete anime. A DELETE that commits between this
   * statement's scan and its foreign-key check fails the insert — which is a
   * real race the job also faces when an administrator removes a title mid-run,
   * and which the queue answers the same way: run it again. It is idempotent,
   * so a retry is free.
   */
  async function seed (
    options?: Parameters<typeof seedFounderLibrary>[1]
  ): Promise<Awaited<ReturnType<typeof seedFounderLibrary>>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await seedFounderLibrary(profileId, options)
      } catch (error) {
        if (attempt >= 3 || (error as { code?: string }).code !== '23503') throw error
      }
    }
  }

  test('fills the library with the whole catalogue, finished', async () => {
    const result = await seed()
    assert.ok(result.library > 0, 'nothing was written')

    // Not `=== catalogue`: a sibling suite may add a title a millisecond later
    // and it would be legitimately absent. What must hold is that nothing that
    // existed when this ran was left out.
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM anime a
                WHERE a.created_at <= now()
                  AND NOT EXISTS (SELECT 1 FROM library_entries le
                                   WHERE le.profile_id = $1 AND le.anime_id = a.id))          AS missing,
              (SELECT count(*)::int FROM library_entries WHERE profile_id = $1)               AS total,
              (SELECT count(*)::int FROM library_entries
                WHERE profile_id = $1 AND status <> 'COMPLETED')                              AS unfinished`,
      [profileId]
    )
    // Not `=== result.library`. That compares a count taken at one instant with
    // the work done over eleven seconds, while sibling suites are inserting and
    // deleting anime in the same database — the two cannot be equal by
    // construction, and asserting it failed about one run in five. The
    // properties that do hold under a concurrent writer are the ones that
    // matter, and they are asserted exactly.
    assert.ok(
      Number(rows[0]!.total) >= result.library,
      `the library holds ${rows[0]!.total} entries, fewer than the ${result.library} written`
    )
    assert.equal(rows[0]!.unfinished, 0, 'every entry should be marked completed')
    assert.ok(Number(rows[0]!.missing) <= 2, `${rows[0]!.missing} titles were left out of the library`)
  })

  test('marks every episode watched, and leaves nothing to continue', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT completed)::int AS unfinished
         FROM watch_progress WHERE profile_id = $1`, [profileId]
    )
    assert.ok(Number(rows[0]!.total) > 0, 'no episodes were written')
    // If any were left incomplete, "continue watching" would offer back a
    // catalogue's worth of episodes the account has finished.
    assert.equal(rows[0]!.unfinished, 0)

    const res = await app.inject({ url: '/v1/me/continue-watching', headers: auth() })
    assert.equal(res.statusCode, 200)
    assert.deepEqual((res.json() as { data: unknown[] }).data, [])
  })

  test('unlocks every achievement, once each', async () => {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM achievements)                                        AS available,
              (SELECT count(*)::int FROM profile_achievements WHERE profile_id = $1)          AS unlocked,
              (SELECT count(*)::int FROM xp_events WHERE profile_id = $1)                     AS events`,
      [profileId]
    )
    assert.equal(rows[0]!.unlocked, rows[0]!.available)
    assert.equal(rows[0]!.events, rows[0]!.available, 'one XP event per achievement, not a lump')
  })

  test('the stats agree with what was written', async () => {
    const { rows } = await pool.query(
      `SELECT s.*, (SELECT count(*)::int FROM library_entries
                     WHERE profile_id = $1 AND status = 'COMPLETED') AS completed_now
         FROM profile_stats s WHERE s.profile_id = $1`, [profileId]
    )
    const stats = rows[0]!
    assert.equal(Number(stats.anime_completed), Number(stats.completed_now))
    assert.ok(Number(stats.episodes_watched) > 0)
    assert.ok(Number(stats.minutes_watched) > 0)
    assert.equal(Number(stats.level), levelFor(Number(stats.xp_total)))
  })

  test('running it again changes nothing', async () => {
    const before = await pool.query(
      `SELECT (SELECT count(*)::int FROM library_entries WHERE profile_id = $1) AS lib,
              (SELECT count(*)::int FROM xp_events WHERE profile_id = $1)       AS xp,
              (SELECT xp_total FROM profile_stats WHERE profile_id = $1)        AS total`,
      [profileId]
    )
    const again = await seed()
    assert.equal(again.achievements, 0, 'no achievement should unlock twice')

    const after = await pool.query(
      `SELECT (SELECT count(*)::int FROM library_entries WHERE profile_id = $1) AS lib,
              (SELECT count(*)::int FROM xp_events WHERE profile_id = $1)       AS xp,
              (SELECT xp_total FROM profile_stats WHERE profile_id = $1)        AS total`,
      [profileId]
    )
    assert.deepEqual(after.rows[0], before.rows[0], 'a second run must not double anything')
  })

  test('pages through the catalogue rather than writing it in one statement', async () => {
    // The reason this is paged at all: one INSERT ... SELECT over 364,064
    // episodes is a single statement, and the pool sets statement_timeout to
    // 15 seconds. On the real VPS it hit exactly that — `canceling statement
    // due to statement timeout`, the transaction rolled back, nothing written.
    //
    // A small batch against the published subset is enough to prove the loop
    // pages, terminates and covers: the number of pages is what the timeout
    // cared about, not their size.
    const seenPages: Array<[string, number]> = []
    const result = await seed({
      onlyPublic: true,
      batchSize: 250,
      onProgress: (what, done) => seenPages.push([what, done])
    })

    const titlePages = seenPages.filter(([what]) => what === 'titles')
    const episodePages = seenPages.filter(([what]) => what === 'episodes')
    assert.ok(titlePages.length > 1, `titles were written in ${titlePages.length} page(s), so nothing was paged`)
    assert.ok(episodePages.length > 1, `episodes were written in ${episodePages.length} page(s)`)

    // The progress a page reports only ever grows, and ends at the total.
    for (const pages of [titlePages, episodePages]) {
      for (let i = 1; i < pages.length; i++) {
        assert.ok(pages[i]![1] > pages[i - 1]![1], 'progress went backwards')
      }
    }
    assert.equal(titlePages[titlePages.length - 1]![1], result.library)
    assert.equal(episodePages[episodePages.length - 1]![1], result.episodes)

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM anime a
        WHERE a.visibility = 'public'
          AND NOT EXISTS (SELECT 1 FROM library_entries le
                           WHERE le.profile_id = $1 AND le.anime_id = a.id)`,
      [profileId]
    )
    assert.equal(rows[0]!.n, 0, 'paging left published titles out of the library')
  })

  test('a run that stopped halfway is finished by running it again', async () => {
    // What resumability actually has to mean here. The previous test seeded
    // only the published subset — a partial run, of the shape a timeout or a
    // restart would leave behind. A full run must complete it rather than
    // trip over what is already there.
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM library_entries WHERE profile_id = $1', [profileId]
    )
    const result = await seed()
    const after = await pool.query(
      `SELECT (SELECT count(*)::int FROM library_entries WHERE profile_id = $1) AS lib,
              (SELECT count(*)::int FROM library_entries
                WHERE profile_id = $1 AND status <> 'COMPLETED')                AS unfinished`,
      [profileId]
    )
    assert.ok(Number(after.rows[0]!.lib) >= Number(before.rows[0]!.n))
    assert.equal(after.rows[0]!.unfinished, 0)
    assert.equal(result.library, Number(after.rows[0]!.lib))
  })

  test('the batch size changes how it runs, not what it writes', async () => {
    const big = await seed({ batchSize: 20_000 })
    const small = await seed({ batchSize: 500 })
    assert.equal(small.library, big.library)
    assert.equal(small.episodes, big.episodes)
    assert.equal(small.xp, big.xp)
    assert.equal(small.minutesWatched, big.minutesWatched)
  })

  // ---- reading it back ----

  test('one request no longer returns the whole library', async () => {
    const res = await app.inject({ url: '/v1/me/library?limit=100', headers: auth() })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { data: unknown[], next?: string }
    assert.equal(body.data.length, 100)
    assert.ok(body.next, 'a page that is not the last must say how to get the next')
  })

  test('walking the cursor sees every entry exactly once', async () => {
    // The cursor used to carry a millisecond-rounded timestamp while Postgres
    // kept microseconds, so `(updated_at, anime_id) < cursor` excluded every
    // remaining row and the walk stopped after one page. It only showed up on
    // a library written in one transaction, where every row shares a
    // timestamp — which is exactly what the seeder produces.
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    do {
      const url = '/v1/me/library?limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
      const res = await app.inject({ url, headers: auth() })
      assert.equal(res.statusCode, 200)
      const body = res.json() as { data: Array<{ anime_id: string }>, next?: string }
      for (const row of body.data) {
        assert.ok(!seen.has(row.anime_id), `${row.anime_id} came back on two pages`)
        seen.add(row.anime_id)
      }
      cursor = body.next
      pages++
      assert.ok(pages < 200, 'the walk did not terminate')
    } while (cursor)

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM library_entries WHERE profile_id = $1', [profileId]
    )
    assert.equal(seen.size, Number(rows[0]!.n), 'the walk must reach every entry')
    assert.ok(pages > 1, 'this library should not fit in one page')
  })

  test('a page carries no cursor scaffolding into the response', async () => {
    const res = await app.inject({ url: '/v1/me/library?limit=1', headers: auth() })
    const [row] = (res.json() as { data: Array<Record<string, unknown>> }).data
    assert.ok(row, 'no row returned')
    assert.equal('cursor_at' in row, false, 'cursor_at is internal')
    assert.ok('anime_id' in row && 'status' in row && 'updated_at' in row)
  })

  test('a malformed cursor is refused, not ignored', async () => {
    // Ignoring it would silently restart the walk, and a client paging through
    // would loop over the first page for ever.
    for (const cursor of ['nonsense', 'not-a-date,abc']) {
      const res = await app.inject({ url: '/v1/me/library?cursor=' + encodeURIComponent(cursor), headers: auth() })
      assert.equal(res.statusCode, 400, `${cursor} should be refused`)
    }
  })

  test('an oversized limit is refused by the schema', async () => {
    const res = await app.inject({ url: '/v1/me/library?limit=100000', headers: auth() })
    assert.equal(res.statusCode, 400)
  })

  test('filtering by status still works, and still pages', async () => {
    const res = await app.inject({ url: '/v1/me/library?status=COMPLETED&limit=10', headers: auth() })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { data: Array<{ status: string }>, next?: string }
    assert.equal(body.data.length, 10)
    assert.ok(body.data.every(row => row.status === 'COMPLETED'))
    assert.ok(body.next)
  })
})
