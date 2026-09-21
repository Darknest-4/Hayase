// Egy objektum eltávolítása a médiavödörből — üzemeltetői eszköz.
//
//   node --experimental-strip-types scripts/media-remove.ts <kulcs> [--dry-run] [--force]
//
// MIÉRT VAN GUARD RAJTA. A vödörben két fajta tartalom van: amire az oldal
// MUTAT (a tükrözött borítók `mirror_key`-e, a lejátszási források `ref`-je),
// és ami ottfelejtett — egy elgépelt kulcs, egy lecserélt karbantartási videó.
// A kettő ránézésre ugyanolyan, és a különbség csak az adatbázisból derül ki.
//
// Egy törlés, ami ezt nem nézi meg, pont akkor sül el, amikor takarítani
// akarunk: eltűnik egy borító, és a hiba hetekkel később, egy látogató
// képernyőjén jelenik meg. Ezért a szkript ALAPBÓL VISSZAUTASÍT mindent, amire
// az adatbázis hivatkozik, és a `--force`-ot ki kell mondani.
//
// A TÖRLÉS VISSZAVONHATATLAN. A `--dry-run` megmutatja, mi történne.

import { deleteObject, headObject, mediaStorage } from '../src/infrastructure/storage/s3.ts'
import { mediaBaseUrl } from '../src/modules/media/public-url.ts'

const argv = process.argv.slice(2)

function fail (message: string): never {
  console.error(`hiba: ${message}`)
  process.exit(1)
}

const keys: string[] = []
let dryRun = false
let force = false
for (const arg of argv) {
  if (arg === '--dry-run') dryRun = true
  else if (arg === '--force') force = true
  else if (arg.startsWith('--')) fail(`ismeretlen kapcsoló: ${arg}`)
  else keys.push(arg)
}

if (keys.length !== 1) fail('pontosan egy kulcsot adj meg')
const key = keys[0]!
if (key.startsWith('/')) fail('a kulcs nem kezdődhet perjellel')

const config = mediaStorage()
if (!config) fail('nincs médiatárhely beállítva')

const object = await headObject(config, key)
if (!object) {
  console.log(`nincs ilyen objektum a(z) ${config.bucket} vödörben: ${key}`)
  process.exit(0)
}
console.log(`vödör: ${config.bucket}`)
console.log(`kulcs: ${key}${object.size === null ? '' : ` (${(object.size / 1024 / 1024).toFixed(1)} MB)`}`)

// ---------------------------------------------------------------------------
// Hivatkozik-e rá bármi
// ---------------------------------------------------------------------------

const { pool, query } = await import('../src/infrastructure/database/index.ts')
const references: string[] = []
try {
  const images = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM anime_images WHERE mirror_key = $1', [key])
  if (Number(images[0]?.n ?? 0) > 0) references.push(`${images[0]!.n} kép (anime_images.mirror_key)`)

  // A források a TELJES URL-t tárolják, nem a kulcsot. A `like` azért van, mert
  // az alap idővel változhatott — ami erre a kulcsra végződik, az erre mutat.
  const sources = await query<{ n: string }>(
    "SELECT count(*)::text AS n FROM video_sources WHERE ref LIKE '%' || $1", [key])
  if (Number(sources[0]?.n ?? 0) > 0) {
    references.push(`${sources[0]!.n} lejátszási forrás (video_sources.ref)`)
  }
} catch (error) {
  // Ha az adatbázist nem érjük el, NEM törlünk: az ellenőrzés hiánya nem
  // ugyanaz, mint a „semmi nem hivatkozik rá".
  await pool.end()
  fail(`az ellenőrzés nem futott le (${(error as Error).message}); törlés nélkül állok le`)
}

if (references.length > 0) {
  console.log(`hivatkozik rá: ${references.join(', ')}`)
  console.log(`cím: ${mediaBaseUrl()}${key}`)
  if (!force) {
    await pool.end()
    fail('az oldal még mutat rá; ha tényleg törölni akarod, add meg a --force kapcsolót')
  }
  console.warn('FIGYELEM: --force — a hivatkozás ettől nem szűnik meg, csak a fájl tűnik el')
} else {
  console.log('semmi nem hivatkozik rá az adatbázisban')
}

if (dryRun) {
  console.log('[száraz] a törlés nem történt meg')
  await pool.end()
  process.exit(0)
}

await deleteObject(config, key)

// Visszaolvasás: egy „törölve" üzenet ellenőrzés nélkül csak reménykedés.
const after = await headObject(config, key)
if (after) fail('a törlés után is ott van')
console.log('törölve')
await pool.end()
