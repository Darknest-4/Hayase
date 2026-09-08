// What this module wants to be told about, and by whom.
//
// The queue used to announce a dead job by importing this module itself, which
// pointed the dependency the wrong way round: the general mechanism naming one
// of the features built on it. It now reports dead jobs to whoever asked, and
// the asking happens here — in the module that cares — and is switched on by
// the worker entrypoint at startup.
//
// Adding a second interested party (an alert, a metric, a mail) is a new
// listener beside this one; neither the queue nor this file changes.

import { onDeadJob, type DeadJob } from '../../infrastructure/queue/index.ts'

import { emitEvent } from './delivery.ts'

/**
 * Announce exhausted jobs as `job.failed`.
 *
 * Webhook jobs are already excluded by the queue: a delivery that keeps
 * failing would otherwise announce its own failure through the same broken
 * delivery, forever.
 *
 * Failures are swallowed. A webhook endpoint being down is not a reason for
 * the queue to stop draining, and the caller isolates listeners for the same
 * reason — this is belt and braces on the path that matters most.
 */
export function announceDeadJobs (): void {
  onDeadJob(async (job: DeadJob) => {
    await emitEvent('job.failed', {
      queue: job.queue,
      jobId: job.jobId,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      deadInQueue: job.deadInQueue,
      error: job.error
    }).catch(() => {})
  })
}
