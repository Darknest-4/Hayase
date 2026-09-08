// Job queue over the jobs table (0008). enqueue() is called from routes;
// runWorker() is the poll loop used by the worker entrypoint.
// Payloads carry ids, not data — handlers re-read state from the DB.
//
// This file is infrastructure, and infrastructure does not know what a webhook
// is. It used to: when a job ran out of retries it reached into the webhooks
// module to announce it, through a lazy `await import()` that kept the module
// graph acyclic but left the dependency pointing the wrong way — the general
// mechanism naming one of the features built on top of it. Nothing could use
// the queue without the webhook delivery code coming along behind it.
//
// The direction is inverted with a listener instead. The queue reports that a
// job died and says nothing about who cares; app.ts and the worker entrypoint
// register the webhook announcement at startup. Anything else that wants to
// know later — an alert, a metric, a mail — registers alongside it and this
// file does not change.

import { pool, query, queryOne } from '../database/index.ts'

export type QueueName = 'stats' | 'notify' | 'maintenance' | 'import' | 'search-index' | 'ext-review' | 'webhook' | 'monitor' | 'metadata'

export interface Job {
  id: string
  queue: QueueName
  payload: Record<string, unknown>
  attempts: number
}

export type JobHandler = (job: Job) => Promise<void>

/** What a dead job looks like to anyone who asked to hear about them. */
export interface DeadJob {
  queue: QueueName
  jobId: string
  attempts: number
  maxAttempts: number
  /** How many jobs in this queue are dead and unhandled, this one included. */
  deadInQueue: number
  error: string
}

const deadJobListeners: Array<(job: DeadJob) => void | Promise<void>> = []

/**
 * Be told when a job exhausts its retries.
 *
 * Listeners are called from the worker's error path, so a throwing or slow one
 * would hold up the queue. Each is isolated and its failure swallowed: a
 * broken announcement must not stop jobs from draining, and it is not worth
 * failing a second time over.
 */
export function onDeadJob (listener: (job: DeadJob) => void | Promise<void>): void {
  deadJobListeners.push(listener)
}

/** Drop every listener. For tests, which register their own. */
export function clearDeadJobListeners (): void {
  deadJobListeners.length = 0
}

/**
 * Enqueue a job. Set payload.dedupe to coalesce: while a job with the same
 * (queue, dedupe) is pending, further enqueues are no-ops.
 */
export async function enqueue (queue: QueueName, payload: Record<string, unknown> = {}, runAt?: Date): Promise<void> {
  await query(
    `INSERT INTO jobs (queue, payload, run_at) VALUES ($1, $2, coalesce($3, now()))
     ON CONFLICT DO NOTHING`,
    [queue, payload, runAt ?? null]
  )
}

/**
 * How long a lease may go without a heartbeat before another worker may take
 * the job. This is NOT a job duration limit: a running handler renews its
 * lease, so a legitimately long job (the AniList import runs 15-30 minutes)
 * keeps its claim. Before the heartbeat existed, a fixed five-minute reclaim
 * meant a second worker started duplicating exactly those long jobs.
 */
export const LEASE_TIMEOUT_MS = Number(process.env.JOB_LEASE_TIMEOUT_MS ?? 120_000)
const HEARTBEAT_MS = Math.max(5_000, Math.floor(LEASE_TIMEOUT_MS / 3))

/**
 * Hard ceiling on one handler. Without it a hung fetch blocked the single
 * worker loop forever - and since partition creation runs on that same loop,
 * a stuck job eventually turned into failing inserts on every partitioned
 * table, not merely late background work.
 */
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 600_000)

/** How many jobs may run at once. */
export const JOB_CONCURRENCY = Math.max(1, Number(process.env.JOB_CONCURRENCY ?? 4))

/** Claim one runnable job (oldest first), reclaiming leases that stopped beating. */
async function claim (queues: QueueName[]): Promise<Job | undefined> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<Job & { payload: Record<string, unknown> }>(
      `SELECT id, queue, payload, attempts FROM jobs
       WHERE queue = ANY($1) AND done_at IS NULL AND run_at <= now()
         AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $2))
         AND attempts < max_attempts
       ORDER BY run_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [queues, LEASE_TIMEOUT_MS / 1000]
    )
    const job = rows[0]
    if (job) {
      await client.query('UPDATE jobs SET locked_at = now(), attempts = attempts + 1 WHERE id = $1', [job.id])
    }
    await client.query('COMMIT')
    return job
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Renew a lease so a long-running job is not reclaimed underneath us. */
async function beat (jobId: string): Promise<void> {
  await query('UPDATE jobs SET locked_at = now() WHERE id = $1 AND done_at IS NULL', [jobId])
}

/**
 * Run one handler with a heartbeat and a hard timeout.
 *
 * The timeout rejects the wrapper but cannot unwind the handler itself - no
 * such mechanism exists in-process - so the lease is deliberately released on
 * timeout and the job becomes retryable. That is the right trade: a job that
 * exceeded the ceiling has almost certainly wedged, and the alternative is a
 * worker that never processes anything again.
 */
async function runWithGuards (job: Job, handler: JobHandler): Promise<void> {
  const heartbeat = setInterval(() => { void beat(job.id).catch(() => {}) }, HEARTBEAT_MS)
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      handler(job),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`job exceeded ${JOB_TIMEOUT_MS} ms and was abandoned`)),
          JOB_TIMEOUT_MS
        )
      })
    ])
  } finally {
    clearInterval(heartbeat)
    if (timer) clearTimeout(timer)
  }
}

async function complete (job: Job): Promise<void> {
  await query('UPDATE jobs SET done_at = now(), locked_at = NULL WHERE id = $1', [job.id])
}

/**
 * Record a failed attempt: back off, or declare the job dead and tell whoever
 * asked to hear about it.
 *
 * Exported because the dead-job announcement is a contract between two layers
 * that no other test can reach deterministically — driving it through drain()
 * means racing whatever else is in the queue.
 */
export async function failJob (job: Job, error: Error): Promise<void> {
  // exponential backoff: 30s, 2m, 8m, 32m
  await query(
    `UPDATE jobs SET locked_at = NULL, last_error = $2,
       run_at = now() + (interval '30 seconds' * power(4, attempts - 1))
     WHERE id = $1`,
    [job.id, error.message.slice(0, 2000)]
  )

  // retries exhausted → surface it (never for webhook jobs: avoids loops)
  const exhausted = await queryOne<{ done: boolean, attempts: number, max_attempts: number }>(
    'SELECT attempts >= max_attempts AS done, attempts, max_attempts FROM jobs WHERE id = $1', [job.id]
  )
  if (exhausted?.done && job.queue !== 'webhook' && deadJobListeners.length) {
    // One dead job is noise; the tenth in an hour is an incident, and the
    // difference is the only thing worth knowing on arrival. Counted in the
    // same breath so a listener can say which of the two this is.
    const depth = await queryOne<{ dead: number }>(
      `SELECT count(*)::int AS dead FROM jobs
        WHERE queue = $1 AND attempts >= max_attempts AND done_at IS NULL`, [job.queue])
    const dead: DeadJob = {
      queue: job.queue,
      jobId: job.id,
      attempts: Number(exhausted.attempts),
      maxAttempts: Number(exhausted.max_attempts),
      deadInQueue: Number(depth?.dead ?? 0),
      error: error.message.slice(0, 300)
    }
    for (const listener of deadJobListeners) {
      try {
        await listener(dead)
      } catch {
        // An announcement that cannot be made is not a reason to stop draining.
      }
    }
  }
}

export interface WorkerOptions {
  pollMs?: number
  signal?: AbortSignal
  onError?: (job: Job, error: Error) => void
  /** Jobs to run at once. Defaults to JOB_CONCURRENCY. */
  concurrency?: number
}

/**
 * Poll-and-execute loop. Runs until the signal aborts; drains all runnable
 * jobs, then sleeps pollMs. Returns the number of jobs executed (useful for
 * one-shot drains in tests and cron-style invocations).
 */
export async function runWorker (
  handlers: Partial<Record<QueueName, JobHandler>>,
  { pollMs = 2000, signal, onError, ...options }: WorkerOptions = {}
): Promise<number> {
  const queues = Object.keys(handlers) as QueueName[]
  const concurrency = Math.max(1, options.concurrency ?? JOB_CONCURRENCY)
  let executed = 0

  const runOne = async (job: Job): Promise<void> => {
    try {
      await runWithGuards(job, handlers[job.queue]!)
      await complete(job)
      executed++
    } catch (err) {
      const error = err as Error
      await failJob(job, error)
      onError?.(job, error)
    }
  }

  // One lane per concurrent slot. Each claims and runs independently, so a
  // slow job occupies its own lane instead of stalling every other queue.
  const lane = async (): Promise<void> => {
    while (!signal?.aborted) {
      const job = await claim(queues)
      if (!job) {
        if (!signal) return // no signal → drain mode: stop when empty
        await new Promise(resolve => setTimeout(resolve, pollMs))
        continue
      }
      await runOne(job)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, lane))
  return executed
}

/** Drain helper used by tests and the maintenance cron: run until empty. */
export async function drain (handlers: Partial<Record<QueueName, JobHandler>>): Promise<number> {
  return runWorker(handlers)
}

/**
 * Jobs that exhausted their retries. They were previously invisible and
 * immortal: never completed so never pruned, and re-examined by every claim.
 */
export async function deadLetters (limit = 100): Promise<Job[]> {
  return query<Job>(
    `SELECT id, queue, payload, attempts, last_error, run_at
       FROM jobs
      WHERE done_at IS NULL AND attempts >= max_attempts
      ORDER BY run_at DESC
      LIMIT $1`,
    [limit]
  )
}

/** Give a dead-lettered job one more life, once the cause has been addressed. */
export async function retryJob (jobId: string): Promise<boolean> {
  const rows = await query(
    `UPDATE jobs SET attempts = 0, locked_at = NULL, last_error = NULL, run_at = now()
      WHERE id = $1 AND done_at IS NULL AND attempts >= max_attempts
      RETURNING id`,
    [jobId]
  )
  return rows.length > 0
}

/** Drop dead letters old enough that nobody is going to act on them. */
export async function pruneDeadLetters (olderThanDays = 30): Promise<number> {
  const res = await queryOne<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM jobs
        WHERE done_at IS NULL AND attempts >= max_attempts
          AND run_at < now() - make_interval(days => $1)
       RETURNING 1
     ) SELECT count(*) FROM deleted`,
    [olderThanDays]
  )
  return Number(res?.count ?? 0)
}

export async function pruneDoneJobs (olderThanDays = 7): Promise<number> {
  const res = await queryOne<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM jobs WHERE done_at IS NOT NULL AND done_at < now() - make_interval(days => $1) RETURNING 1
     ) SELECT count(*) FROM deleted`,
    [olderThanDays]
  )
  return Number(res?.count ?? 0)
}
