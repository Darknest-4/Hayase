// Enrich the catalogue from AniList (synopsis, cover/banner, score, genres,
// tags, studios, trailer) for every anime that has an anilist_id.
//   node --experimental-strip-types scripts/import-anilist.ts [--all] [--limit N]
//   --all    re-fetch every mapped anime (default: only rows missing a synopsis)
//   --limit  cap how many to process (useful for a first smoke run)
//   --deep   fetch cast, staff, relations and recommendations instead of the
//            scalar fields. Its own pass because it asks for far more per
//            title: ~10 media per request against 50, so a full catalogue is
//            hours, not minutes. Resumable — re-running skips what has a cast.
//   --retry-conflicts  only re-attempt external ids refused on an earlier run
//                      (run this after merging duplicates; the normal run
//                       cannot, because those rows already have a synopsis)
//
// The same thing is available without a shell: Admin → Metadata starts a run,
// shows its progress and can cancel it. Both go through one `metadata_runs`
// row, so only one pass can be in flight at a time and every pass is recorded.

import { pool, queryOne } from '../src/db.ts'
import { retryMappingConflicts } from '../src/workers/anilist.ts'
import { handleMetadataJob, RunInProgress, startRun } from '../src/workers/metadata.ts'

const args = process.argv.slice(2)

if (args.includes('--retry-conflicts')) {
  const { retried, attached } = await retryMappingConflicts()
  console.log(`retried ${retried} recorded collision(s); ${attached} could now be attached`)
  await pool.end()
  process.exit(0)
}

const onlyMissing = !args.includes('--all')
const deep = args.includes('--deep')
const limitArg = args.indexOf('--limit')
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : null

/*
 * The script goes through the same run row as the administration panel.
 *
 * Two reasons. The single-active-run rule is only a rule if both entry points
 * respect it — AniList publishes a rate limit and the pass is paced to stay
 * under it, so a script started next to a panel run doubles the request rate.
 * And a run nobody recorded is a run nobody can see afterwards: the panel
 * would show the catalogue as untouched while this was rewriting it.
 */
let run
try {
  run = await startRun({
    kind: deep ? 'deep' : 'basic',
    scope: onlyMissing ? 'missing' : 'all',
    limit
  })
} catch (err) {
  if (err instanceof RunInProgress) {
    console.error(err.message + ' — wait for it, or cancel it from the admin panel.')
    await pool.end()
    process.exit(1)
  }
  throw err
}

console.log(`${deep ? 'deep enrich' : 'enriching'} from AniList (${onlyMissing ? 'only what is missing' : 'every mapped title'}${limit ? `, limit ${limit}` : ''})`)
const started = Date.now()

// The handler writes progress to the row; this prints what it wrote, so the
// terminal and the panel cannot disagree about how far along it is.
const ticker = setInterval(() => {
  void (async () => {
    const row = await queryOne<{ processed: number, total: number, counts: Record<string, number> }>(
      'SELECT processed, total, counts FROM metadata_runs WHERE id = $1', [run.id])
    if (!row?.total) return
    const pct = Math.round(row.processed / row.total * 100)
    const counts = Object.entries(row.counts ?? {}).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ')
    console.log(`  ${row.processed}/${row.total} (${pct}%)${counts ? ' — ' + counts : ''}`)
  })()
}, 10_000)

try {
  await handleMetadataJob({ id: 'cli', queue: 'metadata', payload: { runId: run.id }, attempts: 1 })
} finally {
  clearInterval(ticker)
}

const result = await queryOne<{ status: string, processed: number, counts: Record<string, number>, error: string | null }>(
  'SELECT status, processed, counts, error FROM metadata_runs WHERE id = $1', [run.id])
console.log(`${result?.status} in ${Math.round((Date.now() - started) / 1000)}s:`, JSON.stringify(result?.counts ?? {}))
if (result?.error) console.error(result.error)

// Collisions are not failures and the exit code does not treat them as such —
// AniList splits a show into separate entries far more readily than MAL does,
// so two AniList ids sharing one MAL id is the normal shape of a multi-season
// show. They are printed because the pairs are also where duplicates in our
// own catalogue show up, and nobody goes looking in a table they were never
// told about.
if (result?.counts?.conflicts) {
  console.log(`\n${result.counts.conflicts} external id(s) could not be attached because another anime already held them.`)
  const { rows } = await pool.query<{ title: string, external_id: string, holder: string, seen_count: number }>(
    `SELECT a.canonical_title AS title, c.external_id, h.canonical_title AS holder, c.seen_count
       FROM mapping_conflicts c
       JOIN anime a ON a.id = c.anime_id
       LEFT JOIN anime h ON h.id = c.held_by
      WHERE c.source = 'anilist-enrich' AND c.resolved_at IS NULL
      ORDER BY c.last_seen DESC
      LIMIT 10`
  )
  for (const r of rows) {
    console.log(`  mal:${r.external_id}  ${r.title}  —  already held by ${r.holder ?? '(deleted)'}${r.seen_count > 1 ? ` (seen ${r.seen_count}x)` : ''}`)
  }
  console.log('  full list:  SELECT * FROM mapping_conflicts WHERE resolved_at IS NULL;')
  console.log('  once looked at:  UPDATE mapping_conflicts SET resolved_at = now(), resolution = \'...\' WHERE id = ...;')
}

// A row that failed keeps its synopsis NULL, so the default run picks it up
// again. Say so, rather than leaving the operator to work it out.
if (result?.counts?.rowFailures) {
  console.log(`\n${result.counts.rowFailures} row(s) failed individually — re-run the same command to retry just those.`)
}

await pool.end()
