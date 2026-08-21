// Enrich the catalogue from AniList (synopsis, cover/banner, score, genres,
// tags, studios, trailer) for every anime that has an anilist_id.
//   node --experimental-strip-types scripts/import-anilist.ts [--all] [--limit N]
//   --all    re-fetch every mapped anime (default: only rows missing a synopsis)
//   --limit  cap how many to process (useful for a first smoke run)

import { pool } from '../src/db.ts'
import { enrichFromAniList } from '../src/workers/anilist.ts'

const args = process.argv.slice(2)
const onlyMissing = !args.includes('--all')
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
await pool.end()
