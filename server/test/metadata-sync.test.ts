// Metadata synchronisation: the runs, and the row that records them.
//
// The AniList passes were reachable only from a shell script. Nothing recorded
// that a run had happened, how far it got, or what it changed — so an operator
// could not answer "is the catalogue current?" and one without SSH could not
// start a pass at all.
//
// The passes themselves are not exercised here: both talk to AniList, which is
// rate-limited and not ours to hammer from a test suite. What is exercised is
// everything around them — the single-active-run rule, progress reaching the
// database, a cancel being honoured, and a run finishing exactly once.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { passes, handleMetadataJob, activeRun, coverage, requestCancel } from '../src/workers/metadata.ts'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'metadata-sync-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('metadata synchronisation', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  let token = ''
  const realBasic = passes.basic

  async function account (role?: string): Promise<string> {
    const username = 'meta_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    if (role) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = $2
         ON CONFLICT DO NOTHING`, [username, role])
      const auth = await import('../src/plugins/auth.ts')
      auth.invalidatePermissions()
    }
    return (res.json() as { accessToken: string }).accessToken
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
    token = await account('admin')
  })

  after(async () => {
    passes.basic = realBasic
    await pool.query("DELETE FROM metadata_runs WHERE started_by IS NULL OR started_by IN (SELECT id FROM users WHERE username = ANY($1))", [usernames])
    if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    await app?.close()
    await pool?.end()
  })

  const headers = (): Record<string, string> => ({ authorization: `Bearer ${token}` })

  async function clearRuns (): Promise<void> {
    await pool.query('DELETE FROM metadata_runs')
    // And the jobs that pointed at them. The database outlives the process, so
    // without this a job left by an earlier run of this file is indistinguish-
    // able from the one the test under way just enqueued.
    await pool.query("DELETE FROM jobs WHERE queue = 'metadata'")
  }

  test('reports coverage as numbers, not as a promise of one', async () => {
    const stats = await coverage()
    for (const key of ['total', 'mapped', 'withSynopsis', 'withCover', 'withCast', 'withRelations', 'openConflicts']) {
      assert.equal(typeof stats[key], 'number', `${key} is ${typeof stats[key]}`)
    }
    // Coverage cannot exceed the catalogue.
    assert.ok(stats.withSynopsis <= stats.total)
    assert.ok(stats.mapped <= stats.total)
  })

  test('the status endpoint answers with coverage, the active run and the history', async () => {
    await clearRuns()
    const res = await app.inject({ url: '/v1/admin/catalogue/metadata', headers: headers() })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { coverage: Record<string, number>, active: unknown, runs: unknown[] }
    assert.equal(typeof body.coverage.total, 'number')
    assert.equal(body.active, null)
    assert.deepEqual(body.runs, [])
  })

  test('starting a run queues it and records who asked', async () => {
    await clearRuns()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalogue/metadata/runs',
      headers: headers(),
      payload: { kind: 'basic', scope: 'missing', limit: 5 }
    })
    assert.equal(res.statusCode, 202, res.body)
    const { id } = res.json() as { id: string }

    const row = (await pool.query('SELECT * FROM metadata_runs WHERE id = $1', [id])).rows[0]
    assert.equal(row.status, 'queued')
    assert.equal(row.max_items, 5)
    assert.ok(row.started_by, 'the run does not say who started it')

    // And the worker has something to pick up. A row nobody runs is worse than
    // no row: the panel would show a run that never moves.
    const job = (await pool.query(
      "SELECT * FROM jobs WHERE queue = 'metadata' AND done_at IS NULL AND payload->>'runId' = $1", [id])).rows[0]
    assert.ok(job, 'no job was enqueued for this run')
  })

  test('a second run is refused while one is in flight', async () => {
    // AniList publishes a rate limit and the pass is paced to stay under it.
    // Two runs at once would double the request rate, so this is enforced by a
    // partial unique index rather than by a disabled button.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalogue/metadata/runs',
      headers: headers(),
      payload: { kind: 'deep', scope: 'all' }
    })
    assert.equal(res.statusCode, 409, res.body)
    assert.equal((await pool.query('SELECT count(*) FROM metadata_runs')).rows[0].count, '1')
  })

  test('cancelling a queued run stops it from ever starting', async () => {
    const active = await activeRun()
    assert.ok(active)
    assert.equal(await requestCancel(active.id), true)

    // The handler must respect a cancel that landed before it claimed the job,
    // or "cancel" only works while somebody is watching.
    let called = false
    passes.basic = (async () => { called = true; return { processed: 0, updated: 0, failed: 0, rowFailures: 0, conflicts: 0 } }) as typeof passes.basic
    await handleMetadataJob({ id: 'j1', queue: 'metadata', payload: { runId: active.id }, attempts: 1 })
    passes.basic = realBasic

    assert.equal(called, false, 'a cancelled run still ran')
    const row = (await pool.query('SELECT status FROM metadata_runs WHERE id = $1', [active.id])).rows[0]
    assert.equal(row.status, 'cancelled')
  })

  test('a run records its progress and its result', async () => {
    await clearRuns()
    const started = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalogue/metadata/runs',
      headers: headers(),
      payload: { kind: 'basic', scope: 'missing' }
    })
    const { id } = started.json() as { id: string }

    passes.basic = (async (opts: Parameters<typeof passes.basic>[0]) => {
      // The final report is written whatever the throttle says, which is what
      // makes the bar reach the end instead of stopping at the last tick.
      await opts?.onProgress?.(120, 120, 118)
      return { processed: 120, updated: 118, failed: 0, rowFailures: 2, conflicts: 3 }
    }) as typeof passes.basic
    await handleMetadataJob({ id: 'j2', queue: 'metadata', payload: { runId: id }, attempts: 1 })
    passes.basic = realBasic

    const row = (await pool.query('SELECT * FROM metadata_runs WHERE id = $1', [id])).rows[0]
    assert.equal(row.status, 'done')
    assert.equal(row.processed, 120)
    assert.equal(row.updated_rows, 118)
    assert.equal(row.counts.rowFailures, 2)
    assert.equal(row.counts.conflicts, 3)
    assert.ok(row.started_at && row.finished_at, 'a finished run with no timestamps')
    // And the slot is free again.
    assert.equal(await activeRun(), undefined)
  })

  test('a cancel mid-run is seen by the pass and ends the row', async () => {
    await clearRuns()
    const started = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalogue/metadata/runs',
      headers: headers(),
      payload: { kind: 'basic', scope: 'all' }
    })
    const { id } = started.json() as { id: string }

    let batches = 0
    passes.basic = (async (opts: Parameters<typeof passes.basic>[0]) => {
      // Two batches, with the cancel arriving between them — the shape the
      // real pass has, where stopping lands on a batch boundary rather than
      // inside a transaction.
      for (let i = 0; i < 10; i++) {
        batches++
        await opts?.onProgress?.((i + 1) * 50, 500, (i + 1) * 50)
        if (i === 1) await requestCancel(id)
        if (await opts?.shouldStop?.()) break
      }
      return { processed: batches * 50, updated: batches * 50, failed: 0, rowFailures: 0, conflicts: 0 }
    }) as typeof passes.basic
    await handleMetadataJob({ id: 'j3', queue: 'metadata', payload: { runId: id }, attempts: 1 })
    passes.basic = realBasic

    assert.equal(batches, 2, `the pass ran ${batches} batches after a cancel`)
    const row = (await pool.query('SELECT * FROM metadata_runs WHERE id = $1', [id])).rows[0]
    // Cancelled stays cancelled: the finishing write must not quietly promote
    // it to 'done' because the pass returned normally.
    assert.equal(row.status, 'cancelled')
    assert.ok(row.finished_at, 'a cancelled run left hanging with no end time')
  })

  test('a failing pass leaves the reason on the row', async () => {
    await clearRuns()
    const started = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalogue/metadata/runs',
      headers: headers(),
      payload: { kind: 'basic', scope: 'missing' }
    })
    const { id } = started.json() as { id: string }

    passes.basic = (async () => { throw new Error('AniList HTTP 503') }) as typeof passes.basic
    await assert.rejects(handleMetadataJob({ id: 'j4', queue: 'metadata', payload: { runId: id }, attempts: 1 }))
    passes.basic = realBasic

    const row = (await pool.query('SELECT * FROM metadata_runs WHERE id = $1', [id])).rows[0]
    assert.equal(row.status, 'failed')
    assert.match(row.error, /503/)
    // A failed run must not hold the slot: the fix for a transient failure is
    // to press start again.
    assert.equal(await activeRun(), undefined)
  })

  test('the whole surface is hidden from an account without the permission', async () => {
    const plain = await account()
    for (const url of ['/v1/admin/catalogue/metadata', '/v1/admin/catalogue/metadata/conflicts']) {
      const res = await app.inject({ url, headers: { authorization: `Bearer ${plain}` } })
      assert.equal(res.statusCode, 404, `${url} answered ${res.statusCode}`)
    }
    const post = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalogue/metadata/runs',
      headers: { authorization: `Bearer ${plain}` },
      payload: { kind: 'basic' }
    })
    assert.equal(post.statusCode, 404, post.body)
  })

  test('unresolved collisions are listed and can be marked reviewed', async () => {
    const anime = (await pool.query('SELECT id FROM anime LIMIT 2')).rows
    if (anime.length < 2) return // an empty catalogue has nothing to collide

    const external = String(900000000 + Math.floor(Math.random() * 1e6))
    const inserted = (await pool.query(
      `INSERT INTO mapping_conflicts (anime_id, provider, external_id, held_by, source)
       VALUES ($1, 'mal', $2, $3, 'test') RETURNING id`,
      [anime[0].id, external, anime[1].id]
    )).rows[0]

    try {
      const list = await app.inject({ url: '/v1/admin/catalogue/metadata/conflicts', headers: headers() })
      assert.equal(list.statusCode, 200, list.body)
      const found = (list.json() as Array<{ id: string, external_id: string, holder_title: string }>)
        .find(c => c.external_id === external)
      assert.ok(found, 'the collision was not listed')
      // Both sides of the pair, because the pair is the point: it is where a
      // real duplicate in our own catalogue shows up.
      assert.ok(found.holder_title, 'the row does not say who holds the id')

      const resolve = await app.inject({
        method: 'POST',
        url: `/v1/admin/catalogue/metadata/conflicts/${inserted.id}/resolve`,
        headers: headers(),
        payload: { resolution: 'a season split, not a duplicate' }
      })
      assert.equal(resolve.statusCode, 200, resolve.body)

      const row = (await pool.query('SELECT resolved_at, resolution FROM mapping_conflicts WHERE id = $1', [inserted.id])).rows[0]
      assert.ok(row.resolved_at)
      assert.match(row.resolution, /season split/)

      // Resolving it twice is not a second act.
      const again = await app.inject({
        method: 'POST',
        url: `/v1/admin/catalogue/metadata/conflicts/${inserted.id}/resolve`,
        headers: headers(),
        payload: {}
      })
      assert.equal(again.statusCode, 404)
    } finally {
      await pool.query('DELETE FROM mapping_conflicts WHERE id = $1', [inserted.id])
    }
  })
})
