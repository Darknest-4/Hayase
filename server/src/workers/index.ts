// Worker entrypoint: node --run worker  (or --once to drain and exit).
// Schedules its own recurring jobs (maintenance hourly, trending hourly,
// daily rollup) by enqueueing with dedupe keys.

import { pool } from '../db.ts'
import { recordError } from '../lib/errors.ts'
import { drain, enqueue, runWorker } from '../lib/queue.ts'
import { handleWebhookJob } from '../lib/webhooks.ts'
import { handleImportJob } from './importer.ts'
import { handleMaintenanceJob } from './maintenance.ts'
import { handleMetadataJob } from './metadata.ts'
import { handleMonitorJob } from './monitor.ts'
import { handleNotifyJob } from './notify.ts'
import { handleReviewJob } from './review.ts'
import { handleStatsJob } from './stats.ts'

const handlers = {
  stats: handleStatsJob,
  notify: handleNotifyJob,
  maintenance: handleMaintenanceJob,
  metadata: handleMetadataJob,
  monitor: handleMonitorJob,
  import: handleImportJob,
  'ext-review': handleReviewJob,
  webhook: handleWebhookJob
} as const

async function scheduleRecurring (): Promise<void> {
  await enqueue('maintenance', { dedupe: 'maintenance' })
  await enqueue('stats', { trending: true, dedupe: 'trending' })
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  await enqueue('stats', { rollupDay: yesterday, dedupe: `rollup:${yesterday}` })
  await enqueue('stats', { dailyDigest: true, dedupe: `digest:${yesterday}` })
}

/**
 * VPS metrics need a much tighter cadence than the hourly jobs, so they get
 * their own timer. The dedupe key means a slow cycle can never pile up.
 */
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS ?? 60_000)

async function scheduleMonitor (): Promise<void> {
  await enqueue('monitor', { dedupe: 'monitor' })
}

const once = process.argv.includes('--once')

if (once) {
  await scheduleRecurring()
  await scheduleMonitor()
  const executed = await drain(handlers)
  console.log(`drained ${executed} jobs`)
  await pool.end()
} else {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => controller.abort())
  }

  await scheduleRecurring()
  setInterval(() => { void scheduleRecurring() }, 60 * 60 * 1000).unref()

  await scheduleMonitor()
  setInterval(() => { void scheduleMonitor() }, MONITOR_INTERVAL_MS).unref()

  console.log('worker running:', Object.keys(handlers).join(', '))
  await runWorker(handlers, {
    signal: controller.signal,
    onError: (job, error) => {
      console.error(`job ${job.queue}#${job.id} failed:`, error.message)
      void recordError('worker', error, { queue: job.queue, jobId: job.id })
    }
  })
  await pool.end()
}
