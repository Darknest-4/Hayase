// Run the artwork pass without the queue.
//
//   DATABASE_URL=… node --experimental-strip-types scripts/artwork-run.ts [limit]
//
// A limit of 0 (or none) means the whole catalogue.
//
// The queue is in the database and shared with the production worker, so
// driving a run through it from a development container means two workers
// racing for the same job — and the one that wins may be an older image that
// does not know the kind.
//
// It is *not* queue-free in the other sense: the run is recorded in
// metadata_runs exactly as the panel's own runs are, because the first version
// of this script was not, and the admin panel went on showing a throttled run
// from three days earlier as the latest word on the catalogue. A pass that
// leaves no record is a pass nobody can check afterwards.
//
// startRun() also brings the one-at-a-time guarantee with it: a partial unique
// index refuses a second run while one is queued or running, so this cannot
// collide with a run somebody started from the panel a minute ago.

import { ExternalSyncDisabled, handleMetadataJob, RunInProgress, startRun } from '../src/modules/metadata/worker.ts'
import { query } from '../src/infrastructure/database/index.ts'

import type { Job } from '../src/infrastructure/queue/index.ts'

const limit = Number(process.argv[2] ?? 0)

async function main (): Promise<void> {
  const started = Date.now()
  let run
  try {
    run = await startRun({ kind: 'artwork', scope: 'missing', limit: limit || null })
  } catch (err) {
    if (err instanceof RunInProgress) {
      console.error('another metadata run is queued or running — start this one when it finishes')
      process.exit(1)
    }
    if (err instanceof ExternalSyncDisabled) {
      console.error('external sync is switched off for this instance — turn it on in the admin panel first')
      process.exit(1)
    }
    throw err
  }

  // The same handler the worker calls, given the same shape the queue would
  // have handed it. Progress, cancellation and the finishing write are its
  // job, so this script cannot drift from what a panel-started run does.
  const job: Job = { id: `local:${run.id}`, queue: 'metadata', payload: { runId: run.id }, attempts: 0 }

  const ticker = setInterval(() => {
    void query<{ processed: number, total: number, counts: unknown }>(
      'SELECT processed, total, counts FROM metadata_runs WHERE id = $1', [run.id]
    ).then(rows => {
      const row = rows[0]
      if (row) console.log(`  ${row.processed}/${row.total}`, JSON.stringify(row.counts))
    })
  }, 10_000)

  try {
    await handleMetadataJob(job)
  } finally {
    clearInterval(ticker)
  }

  const rows = await query<{ status: string, processed: number, counts: unknown, error: string | null }>(
    'SELECT status, processed, counts, error FROM metadata_runs WHERE id = $1', [run.id])
  const row = rows[0]
  console.log(
    `${row?.status} in ${Math.round((Date.now() - started) / 1000)}s`,
    JSON.stringify(row?.counts),
    row?.error ?? ''
  )
}

await main()
process.exit(0)
