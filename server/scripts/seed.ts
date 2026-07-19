// Full catalogue seed:
//   node --experimental-strip-types scripts/seed.ts <anime-offline-database.json>
//
// 1. imports the full anime-offline-database dump (titles, synonyms,
//    external ids, covers, genres/tags, relation graph)
// 2. generates episode rows from real episode counts with season-anchored
//    weekly air dates
// 3. downloads real filler data (filler-scrape) and flags filler episodes
// 4. refreshes trending/denormalised stats

import { pool } from '../src/db.ts'
import { applyFillerData, generateEpisodes, importFile } from '../src/workers/importer.ts'
import { recomputeTrending } from '../src/workers/stats.ts'

const file = process.argv[2]
if (!file) {
  console.error('usage: seed.ts <anime-offline-database.json>')
  process.exit(1)
}

console.log('1/4 importing catalogue from', file)
const started = Date.now()
const stats = await importFile(file, (done, total) => {
  if (done % 5000 === 0 || done === total) console.log(`    ${done}/${total} entries`)
})
console.log('    ', JSON.stringify(stats))

console.log('2/4 generating episodes from real counts')
const episodes = await generateEpisodes()
console.log(`     ${episodes} episode rows created`)

console.log('3/4 applying real filler data (filler-scrape)')
try {
  const res = await fetch('https://raw.githubusercontent.com/ThaUnknown/filler-scrape/master/filler.json')
  const filler = await res.json() as Record<string, number[]>
  const flagged = await applyFillerData(filler)
  console.log(`     ${flagged} episodes flagged as filler across ${Object.keys(filler).length} shows`)
} catch (err) {
  console.log('     filler source unreachable, skipped:', (err as Error).message)
}

console.log('4/4 refreshing trending scores')
await recomputeTrending()

console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`)
await pool.end()
