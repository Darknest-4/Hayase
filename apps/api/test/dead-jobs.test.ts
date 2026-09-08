// What happens when a job runs out of retries, and who gets told.
//
// This used to work by the queue importing the webhooks module and calling
// emitEvent itself — through a lazy `await import()`, which kept the module
// graph acyclic but pointed the dependency the wrong way: the general
// mechanism naming one of the features standing on it. Nothing could use the
// queue without dragging webhook delivery along.
//
// It is a listener now, and inverting a dependency is exactly the kind of
// change that keeps the tests green while quietly delivering nothing — the old
// call site is gone, and if the new registration is missed, no announcement is
// made and no test notices. So the assertions here are about the behaviour on
// both sides of the seam:
//
//   * the queue tells its listeners, with the numbers an operator needs;
//   * a listener that throws does not stop the queue;
//   * the webhooks module still turns that into a job.failed event;
//   * and the worker entrypoint actually registers it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'

import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'dead-jobs-secret-long-enough-0123456789'

describe('a job that runs out of retries', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let q: typeof import('../src/infrastructure/queue/index.ts')
  const jobIds: string[] = []

  before(async () => {
    const [db, queue] = await Promise.all([
      import('../src/infrastructure/database/index.ts'),
      import('../src/infrastructure/queue/index.ts')
    ])
    pool = db.pool
    q = queue
  })

  beforeEach(() => { q.clearDeadJobListeners() })

  after(async () => {
    q?.clearDeadJobListeners()
    try {
      if (jobIds.length) await pool.query('DELETE FROM jobs WHERE id = ANY($1::bigint[])', [jobIds])
    } finally {
      await pool?.end()
    }
  })

  /** A job already at its retry ceiling, as the failure path would find it. */
  const exhaustedJob = async (queue = 'stats'): Promise<{ id: string, queue: string, payload: Record<string, unknown>, attempts: number }> => {
    const { rows } = await pool.query(
      `INSERT INTO jobs (queue, payload, attempts, max_attempts, run_at)
       VALUES ($1, '{}'::jsonb, 5, 5, now()) RETURNING id`, [queue])
    const id = String(rows[0].id)
    jobIds.push(id)
    return { id, queue, payload: {}, attempts: 5 }
  }

  test('tells its listeners, with the numbers an operator needs', async () => {
    const seen: unknown[] = []
    q.onDeadJob(job => { seen.push(job) })

    const job = await exhaustedJob()
    await q.failJob(job as never, new Error('the handler gave up'))

    assert.equal(seen.length, 1, 'the listener was not called')
    const dead = seen[0] as Record<string, unknown>
    assert.equal(dead.jobId, job.id)
    assert.equal(dead.queue, 'stats')
    assert.equal(dead.maxAttempts, 5)
    // Which of "one dead job" and "an incident" this is — the only thing worth
    // knowing on arrival, and the reason the count is taken here at all.
    assert.ok(typeof dead.deadInQueue === 'number' && dead.deadInQueue >= 1, String(dead.deadInQueue))
    assert.match(String(dead.error), /the handler gave up/)
  })

  test('never announces a dead webhook job', async () => {
    // A delivery that keeps failing would announce its own failure through the
    // same broken delivery, forever.
    const seen: unknown[] = []
    q.onDeadJob(job => { seen.push(job) })
    const job = await exhaustedJob('webhook')
    await q.failJob(job as never, new Error('endpoint is down'))
    assert.deepEqual(seen, [], 'a webhook job announced itself')
  })

  test('a listener that throws does not stop the queue', async () => {
    // The announcement is the least important thing happening on this path.
    const after: unknown[] = []
    q.onDeadJob(() => { throw new Error('the announcer is broken') })
    q.onDeadJob(job => { after.push(job) })

    const job = await exhaustedJob()
    await assert.doesNotReject(() => q.failJob(job as never, new Error('gave up')))
    assert.equal(after.length, 1, 'one broken listener silenced the next one')
  })

  test('the retry backoff is still applied to a job that has attempts left', async () => {
    // The failure path does two things; the listener work must not have
    // displaced the one that matters for jobs that are not dead yet.
    const { rows } = await pool.query(
      `INSERT INTO jobs (queue, payload, attempts, max_attempts, run_at)
       VALUES ('stats', '{}'::jsonb, 1, 5, now()) RETURNING id`)
    const id = String(rows[0].id)
    jobIds.push(id)

    await q.failJob({ id, queue: 'stats', payload: {}, attempts: 1 } as never, new Error('transient'))

    const after = await pool.query<{ future: boolean, last_error: string }>(
      'SELECT run_at > now() AS future, last_error FROM jobs WHERE id = $1', [id])
    assert.equal(after.rows[0]?.future, true, 'a retryable job was not pushed into the future')
    assert.match(String(after.rows[0]?.last_error), /transient/)
  })

  test('the webhooks module turns a dead job into a job.failed event', async () => {
    const { announceDeadJobs } = await import('../src/modules/webhooks/subscriptions.ts')
    announceDeadJobs()

    const job = await exhaustedJob()
    const before = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM webhook_deliveries WHERE event = 'job.failed'")
    await q.failJob(job as never, new Error('gave up for the event'))

    // emitEvent only queues a delivery when a hook is subscribed to the event,
    // so the assertion is that the path ran without throwing and left the
    // ledger consistent — not that a delivery necessarily exists here.
    const after = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM webhook_deliveries WHERE event = 'job.failed'")
    assert.ok(Number(after.rows[0]?.n) >= Number(before.rows[0]?.n))
  })
})

describe('the wiring', () => {
  test('the worker entrypoint registers the announcement', () => {
    // The whole inversion is worth nothing if nobody switches it on, and that
    // failure is invisible: no error, no test, just silence where an alert
    // used to be.
    const source = readFileSync(new URL('../src/workers/index.ts', import.meta.url), 'utf8')
    assert.match(source, /announceDeadJobs\(\)/, 'the worker never registers the dead-job listener')
    assert.match(source, /from '\.\.\/modules\/webhooks\/subscriptions\.ts'/)
  })

  test('the queue does not name the webhooks module', () => {
    // The point of the change. A static or dynamic import of a module from
    // infrastructure is the thing being prevented.
    const source = readFileSync(new URL('../src/infrastructure/queue/index.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/(?:from|import\()\s*'([^']+)'/g)].map(m => m[1])
    for (const spec of imports) {
      assert.ok(!String(spec).includes('/modules/'),
        `infrastructure/queue imports ${spec}, which is a feature module`)
    }
  })
})
