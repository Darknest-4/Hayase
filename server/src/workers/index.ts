// Worker entrypoint: node --run worker  (or --once to drain and exit).
// Schedules its own recurring jobs (maintenance hourly, trending hourly,
// daily rollup) by enqueueing with dedupe keys.

import { pool } from '../db.ts'
import { drain, enqueue, runWorker } from '../lib/queue.ts'
import { handleImportJob } from './importer.ts'
import { handleMaintenanceJob } from './maintenance.ts'
import { handleNotifyJob } from './notify.ts'
import { handleReviewJob } from './review.ts'
import { handleStatsJob } from './stats.ts'

const handlers = {
  stats: handleStatsJob,
  notify: handleNotifyJob,
  maintenance: handleMaintenanceJob,
  import: handleImportJob,
  'ext-review': handleReviewJob
} as const

async function scheduleRecurring (): Promise<void> {
  await enqueue('maintenance', { dedupe: 'maintenance' })
  await enqueue('stats', { trending: true, dedupe: 'trending' })
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  await enqueue('stats', { rollupDay: yesterday, dedupe: `rollup:${yesterday}` })
}

const once = process.argv.includes('--once')

if (once) {
  await scheduleRecurring()
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

  console.log('worker running:', Object.keys(handlers).join(', '))
  await runWorker(handlers, {
    signal: controller.signal,
    onError: (job, error) => console.error(`job ${job.queue}#${job.id} failed:`, error.message)
  })
  await pool.end()
}
