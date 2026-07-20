// Job queue over the jobs table (0008). enqueue() is called from routes;
// runWorker() is the poll loop used by the worker entrypoint.
// Payloads carry ids, not data — handlers re-read state from the DB.

import { pool, query, queryOne } from '../db.ts'

export type QueueName = 'stats' | 'notify' | 'maintenance' | 'import' | 'search-index' | 'ext-review' | 'webhook'

export interface Job {
  id: string
  queue: QueueName
  payload: Record<string, unknown>
  attempts: number
}

export type JobHandler = (job: Job) => Promise<void>

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

/** Claim one runnable job (oldest first), reclaiming stale leases (>5 min). */
async function claim (queues: QueueName[]): Promise<Job | undefined> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<Job & { payload: Record<string, unknown> }>(
      `SELECT id, queue, payload, attempts FROM jobs
       WHERE queue = ANY($1) AND done_at IS NULL AND run_at <= now()
         AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
         AND attempts < max_attempts
       ORDER BY run_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [queues]
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

async function complete (job: Job): Promise<void> {
  await query('UPDATE jobs SET done_at = now(), locked_at = NULL WHERE id = $1', [job.id])
}

async function fail (job: Job, error: Error): Promise<void> {
  // exponential backoff: 30s, 2m, 8m, 32m
  await query(
    `UPDATE jobs SET locked_at = NULL, last_error = $2,
       run_at = now() + (interval '30 seconds' * power(4, attempts - 1))
     WHERE id = $1`,
    [job.id, error.message.slice(0, 2000)]
  )

  // retries exhausted → surface it (never for webhook jobs: avoids loops)
  const exhausted = await queryOne<{ done: boolean }>(
    'SELECT attempts >= max_attempts AS done FROM jobs WHERE id = $1', [job.id]
  )
  if (exhausted?.done && job.queue !== 'webhook') {
    const { emitEvent } = await import('./webhooks.ts')
    await emitEvent('job.failed', { queue: job.queue, jobId: job.id, error: error.message.slice(0, 300) }).catch(() => {})
  }
}

export interface WorkerOptions {
  pollMs?: number
  signal?: AbortSignal
  onError?: (job: Job, error: Error) => void
}

/**
 * Poll-and-execute loop. Runs until the signal aborts; drains all runnable
 * jobs, then sleeps pollMs. Returns the number of jobs executed (useful for
 * one-shot drains in tests and cron-style invocations).
 */
export async function runWorker (
  handlers: Partial<Record<QueueName, JobHandler>>,
  { pollMs = 2000, signal, onError }: WorkerOptions = {}
): Promise<number> {
  const queues = Object.keys(handlers) as QueueName[]
  let executed = 0

  while (!signal?.aborted) {
    const job = await claim(queues)
    if (!job) {
      if (!signal) break // no signal → drain mode: stop when empty
      await new Promise(resolve => setTimeout(resolve, pollMs))
      continue
    }

    try {
      await handlers[job.queue]!(job)
      await complete(job)
      executed++
    } catch (err) {
      const error = err as Error
      await fail(job, error)
      onError?.(job, error)
    }
  }
  return executed
}

/** Drain helper used by tests and the maintenance cron: run until empty. */
export async function drain (handlers: Partial<Record<QueueName, JobHandler>>): Promise<number> {
  return runWorker(handlers)
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
