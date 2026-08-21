// Full catalogue seed:
//   node --experimental-strip-types scripts/seed.ts [<file-or-url>]
//
// With no argument it downloads the official anime-offline-database dump,
// so a Docker one-shot (`docker compose --profile seed run --rm seed`) needs
// no local file. A local path or a URL can be passed explicitly too.
//
// 1. imports the full anime-offline-database dump (titles, synonyms,
//    external ids, covers, genres/tags, relation graph)
// 2. generates episode rows from real episode counts with season-anchored
//    weekly air dates
// 3. downloads real filler data (filler-scrape) and flags filler episodes
// 4. refreshes trending/denormalised stats

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pool } from '../src/db.ts'
import { applyFillerData, generateEpisodes, importFile } from '../src/workers/importer.ts'
import { recomputeTrending } from '../src/workers/stats.ts'

// official dump (published as a GitHub release asset); overridable via
// SEED_URL or a CLI arg (a local file path also works)
const DEFAULT_URL = process.env.SEED_URL ??
  'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json'

// Resolve the seed source to a local file path, downloading if it's a URL
// (or if no argument was given → the default dump).
async function resolveSource (arg: string | undefined): Promise<string> {
  const src = arg ?? DEFAULT_URL
  if (!/^https?:\/\//.test(src)) return src // already a local path
  console.log('0/4 downloading catalogue dump from', src)
  const res = await fetch(src)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const dest = join(tmpdir(), 'anime-offline-database.json')
  await writeFile(dest, buf)
  console.log(`     saved ${(buf.length / 1_048_576).toFixed(1)} MB → ${dest}`)
  return dest
}

const file = await resolveSource(process.argv[2])

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
