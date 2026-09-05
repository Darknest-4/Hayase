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

import { pool } from '../src/db.ts'
import { enrichFromAniList, retryMappingConflicts } from '../src/workers/anilist.ts'
import { enrichDeepFromAniList } from '../src/workers/anilist-deep.ts'

const args = process.argv.slice(2)

if (args.includes('--retry-conflicts')) {
  const { retried, attached } = await retryMappingConflicts()
  console.log(`retried ${retried} recorded collision(s); ${attached} could now be attached`)
  await pool.end()
  process.exit(0)
}

const onlyMissing = !args.includes('--all')

if (args.includes('--deep')) {
  const deepLimitArg = args.indexOf('--limit')
  const deepLimit = deepLimitArg >= 0 ? Number(args[deepLimitArg + 1]) : undefined
  console.log(`deep enrich from AniList (${onlyMissing ? 'only titles with no cast yet' : 'every mapped title'}${deepLimit ? `, limit ${deepLimit}` : ''})`)
  const deepStarted = Date.now()
  const deep = await enrichDeepFromAniList({
    onlyMissing,
    ...(deepLimit ? { limit: deepLimit } : {}),
    onProgress: (done, total, counts) => {
      if (done % 100 === 0 || done >= total) {
        console.log(`  ${done}/${total} — ${counts.characters} cast, ${counts.voices} voices, ${counts.staff} staff, ${counts.relations} relations, ${counts.recommendations} recommendations`)
      }
    }
  })
  console.log(`done in ${Math.round((Date.now() - deepStarted) / 1000)}s:`, JSON.stringify(deep))
  await pool.end()
  process.exit(0)
}
const limitArg = args.indexOf('--limit')
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined

console.log(`enriching from AniList (${onlyMissing ? 'only rows missing a synopsis' : 'all mapped rows'}${limit ? `, limit ${limit}` : ''})`)
const started = Date.now()

const onProgress = (done: number, total: number, updated: number): void => {
  if (done % 500 === 0 || done === total) {
    const pct = total ? Math.round(done / total * 100) : 100
    console.log(`  ${done}/${total} (${pct}%) — ${updated} updated`)
  }
}
const result = await enrichFromAniList(limit ? { onlyMissing, limit, onProgress } : { onlyMissing, onProgress })

console.log(`done in ${Math.round((Date.now() - started) / 1000)}s:`, JSON.stringify(result))

// Collisions are not failures and the exit code does not treat them as such —
// AniList splits a show into separate entries far more readily than MAL does,
// so two AniList ids sharing one MAL id is the normal shape of a multi-season
// show. They are printed because the pairs are also where duplicates in our
// own catalogue show up, and nobody goes looking in a table they were never
// told about.
if (result.conflicts) {
  console.log(`\n${result.conflicts} external id(s) could not be attached because another anime already held them.`)
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
if (result.rowFailures) {
  console.log(`\n${result.rowFailures} row(s) failed individually — re-run the same command to retry just those.`)
}

await pool.end()
