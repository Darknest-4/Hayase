// Run the artwork pass without the queue.
//
//   DATABASE_URL=… node --experimental-strip-types scripts/artwork-run.ts [limit]
//
// The queue is in the database and shared with the production worker, so
// driving a run through it from a development container means two workers
// racing for the same job — and the one that wins may be an older image that
// does not know the kind. This calls the pass directly instead, which is what
// a first look at the results wants anyway.

import { syncArtwork } from '../src/integrations/anizip/sync.ts'

const limit = Number(process.argv[2] ?? 50)

async function main (): Promise<void> {
  const started = Date.now()
  const counts = await syncArtwork({
    limit,
    onlyMissing: true,
    onProgress: (done, total, c) => console.log(`  ${done}/${total}`, JSON.stringify(c))
  })
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`, JSON.stringify(counts))
}

await main()
process.exit(0)
