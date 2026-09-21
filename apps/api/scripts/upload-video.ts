// Egy videófájl feltöltése az R2 médiavödörbe, és — ha kérjük — a forrás
// bejegyzése az epizódhoz.
//
//   node --experimental-strip-types scripts/upload-video.ts <fájl> [opciók]
//
//     --episode <uuid>     a forrás bejegyzése ehhez az epizódhoz
//     --title <szöveg>     a kiadás neve, ahogy a néző látja
//     --provider <név>     alapértelmezés: YUME
//     --resolution <2160|1080|720|540|480>
//     --language <kód>     pl. ja, hu
//     --variant <sub|dub|raw>
//     --priority <szám>    kisebb szám: előbb próbálja a lejátszó
//     --key <kulcs>        kézzel adott tárhelykulcs a tartalomból származó helyett
//     --base <url>         nyilvános alap, ha a MEDIA_BASE_URL nincs beállítva
//     --part-mb <szám>     darabméret, alapértelmezés 64
//     --concurrency <szám> egyszerre ennyi darab, alapértelmezés 4
//     --dry-run            mindent kiszámol, de nem tölt fel és nem ír
//
// MIÉRT SZKRIPT ÉS NEM ADMIN VÉGPONT. A feltöltésnek a kiszolgálón kell
// történnie, nem a kiszolgálón KERESZTÜL: a Cloudflare ingyenes csomagja a
// kérés törzsét 100 MB-ban maximálja, egy epizód pedig ennek a sokszorosa. Egy
// „töltsd fel a böngészőből" végpont tehát nem lassú lenne, hanem 413-mal
// elhasalna. Az adminfelület azt regisztrálja, ami már fent van — ez teszi fel.
//
// MIÉRT KÉT MENETBEN OLVASSUK A FÁJLT. A kulcs a TARTALOMBÓL származik, mint a
// képtükörnél: azonos tartalom azonos kulcs, tehát egy megismételt futás nem
// tölt fel újra semmit, és a `Cache-Control: immutable` ígérete állja. Ehhez a
// hasított értéknek a feltöltés ELŐTT kész kell lennie. Egy menetben csak úgy
// menne, ha ideiglenes kulcsra töltenénk és utólag másolnánk — egy 1,4 GB-os
// másolás pedig drágább, mint még egyszer végigolvasni egy helyi lemezt.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'

import { mediaBaseUrl } from '../src/modules/media/public-url.ts'
import { MIN_PART_BYTES, headObject, mediaStorage, uploadStream } from '../src/infrastructure/storage/s3.ts'

function fail (message: string): never {
  console.error(`hiba: ${message}`)
  process.exit(1)
}

/*
 * AZ ELEMZÉS EXPLICIT, nem találgatás.
 *
 * Az első változat azt nézte, hogy az argumentum előtt áll-e kapcsoló, és
 * abból következtetett arra, hogy érték-e vagy fájlnév. Ez a
 * `--dry-run film.mp4` sorrendnél elromlik: a fájlnevet a `--dry-run`
 * értékének hitte, és „add meg a feltöltendő fájlt" hibával állt le egy
 * teljesen szabályos parancsra. Ezért van itt lista arról, MELYIK kapcsoló
 * vár értéket — az ismeretlen kapcsoló pedig hiba, nem csendes mellőzés.
 */
const VALUE_FLAGS = new Set([
  'episode', 'title', 'provider', 'resolution', 'language', 'variant',
  'priority', 'key', 'base', 'part-mb', 'concurrency'
])
const BOOL_FLAGS = new Set(['dry-run'])

const options = new Map<string, string>()
const flags = new Set<string>()
const positional: string[] = []

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!
  if (!arg.startsWith('--')) { positional.push(arg); continue }
  const name = arg.slice(2)
  if (BOOL_FLAGS.has(name)) { flags.add(name); continue }
  if (!VALUE_FLAGS.has(name)) fail(`ismeretlen kapcsoló: ${arg}`)
  const value = argv[++i]
  if (value === undefined) fail(`a ${arg} kapcsoló értéket vár`)
  options.set(name, value)
}

const option = (name: string): string | null => options.get(name) ?? null

if (positional.length === 0) fail('add meg a feltöltendő fájlt')
if (positional.length > 1) fail(`egyszerre egy fájl megy: ${positional.join(', ')}`)
const file = positional[0]!

/*
 * A TARTALOMTÍPUS, és ami mögötte van.
 *
 * A böngésző ebből tudja, mit kapott. A `.mkv` szándékosan szerepel, de
 * figyelmeztetéssel: a Matroska tárolót egyetlen böngésző sem játssza le
 * natívan, tehát a fájl feltöltve fent lesz, és lejátszva néma hibát adna. Ezt
 * jobb feltöltés előtt megtudni, mint egy néző hibajelentéséből.
 */
const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t'
}
const PLAYS_IN_BROWSER = new Set(['.mp4', '.m4v', '.webm', '.m3u8'])

const path = resolve(file)
const info = await stat(path).catch(() => fail(`nincs ilyen fájl: ${path}`))
if (!info.isFile()) fail(`nem fájl: ${path}`)
if (info.size === 0) fail('a fájl üres')

const ext = extname(path).toLowerCase()
const contentType = TYPES[ext]
if (!contentType) {
  fail(`ismeretlen kiterjesztés (${ext || 'nincs'}); ismertek: ${Object.keys(TYPES).join(', ')}`)
}
if (!PLAYS_IN_BROWSER.has(ext)) {
  console.warn(`FIGYELEM: a ${ext} tárolót a böngészők nem játsszák le natívan. ` +
    'A fájl feltölthető, de a lejátszó nem fogja tudni megnyitni.')
}

const dryRun = flags.has('dry-run')
const concurrency = Number(option('concurrency') ?? 4)
if (!Number.isFinite(concurrency) || concurrency <= 0) fail('a --concurrency pozitív szám legyen')

/*
 * A DARABMÉRET ITT KAPJA MEG AZ ALSÓ KORLÁTJÁT, nem csak a feltöltőben.
 *
 * Az `uploadStream` amúgy is 5 MiB-ra emelné — az S3 szabálya —, de ha ez a
 * szkript a nyers kért értékkel számolna, a száraz futás TERVE nem az lenne,
 * ami tényleg történne: `--part-mb 1` mellett „3 darabot" ígért egy 3 MB-os
 * fájlra, a valóságban pedig egy darab ment volna. Egy száraz futás, ami mást
 * mond, mint az éles, rosszabb a semminél.
 */
const requestedPartBytes = Math.round(Number(option('part-mb') ?? 64) * 1024 * 1024)
if (!Number.isFinite(requestedPartBytes) || requestedPartBytes <= 0) {
  fail('a --part-mb pozitív szám legyen')
}
const partBytes = Math.max(MIN_PART_BYTES, requestedPartBytes)
if (partBytes !== requestedPartBytes) {
  console.warn(`FIGYELEM: a darabméret legalább ${MIN_PART_BYTES / 1024 / 1024} MiB lehet, ` +
    `ezért a kért ${requestedPartBytes / 1024 / 1024} MiB helyett ennyivel megyünk`)
}

/*
 * A FELSOROLT ÉRTÉKEKET AZONNAL ELLENŐRIZZÜK, nem a bejegyzésnél.
 *
 * Egy elgépelt felbontás korábban csak a legvégén derült ki — egy 1,4 GB-os
 * fájl végigolvasása és feltöltése UTÁN. Ami elgépelés, az az első
 * másodpercben derüljön ki.
 */
const resolution = option('resolution')
if (resolution && !['2160', '1080', '720', '540', '480'].includes(resolution)) {
  fail(`ismeretlen felbontás: ${resolution}`)
}
const variant = option('variant')
if (variant && !['sub', 'dub', 'raw'].includes(variant)) fail(`ismeretlen változat: ${variant}`)

const config = mediaStorage()
if (!config && !dryRun) fail('nincs médiatárhely beállítva (R2_ENDPOINT, R2_ACCESS_KEY_ID, …)')

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

// ---------------------------------------------------------------------------
// 1. menet — a kulcs a tartalomból
// ---------------------------------------------------------------------------

async function digestOf (source: string): Promise<string> {
  const hash = createHash('sha256')
  const started = Date.now()
  let read = 0
  for await (const chunk of createReadStream(source, { highWaterMark: 4 * 1024 * 1024 })) {
    hash.update(chunk as Buffer)
    read += (chunk as Buffer).length
  }
  const seconds = (Date.now() - started) / 1000
  console.log(`ujjlenyomat: ${mb(read)} MB ${seconds.toFixed(1)} s alatt`)
  return hash.digest('hex')
}

const digest = await digestOf(path)
const key = option('key') ?? `video/${digest.slice(0, 2)}/${digest}${ext}`
console.log(`kulcs: ${key}`)

// ---------------------------------------------------------------------------
// A nyilvános cím
// ---------------------------------------------------------------------------
//
// A `mediaBaseUrl()` az az EGYETLEN hely, ami eldönti, honnan jön a média — a
// katalógus képei is onnan kapják a címüket. Itt nem írunk mellé másikat:
// ugyanaz a beállítás, ugyanaz a forrás. Ha az nincs beállítva (alapból egy
// relatív `/media/` útvonal), akkor nyilvános URL-t sem tudunk mondani, és ezt
// KIMONDJUK, nem tippelünk helyette.

const base = (option('base') ?? mediaBaseUrl()).replace(/\/?$/, '/')
const absoluteBase = /^https:\/\//i.test(base)
const publicUrl = absoluteBase ? base + key : null

// ---------------------------------------------------------------------------
// 2. menet — a feltöltés
// ---------------------------------------------------------------------------

if (dryRun) {
  console.log(`[száraz] ${mb(info.size)} MB menne fel ${mb(partBytes)} MB-os darabokban, ` +
    `${Math.ceil(info.size / partBytes)} darab`)
} else {
  // Ami már fent van, azt nem töltjük fel újra. Ettől egy megszakadt futás
  // megismételhető: a kulcs a tartalomból jön, tehát ugyanaz a fájl ugyanoda
  // menne — és a HEAD megmondja, hogy ott van-e már.
  const existing = await headObject(config!, key)
  if (existing && (existing.size === null || existing.size === info.size)) {
    console.log(`már fent van (${existing.size === null ? 'méret ismeretlen' : `${mb(existing.size)} MB`}), ` +
      'a feltöltés kimarad')
  } else {
    if (existing) {
      console.warn(`FIGYELEM: a kulcson más méretű objektum van (${existing.size} bájt ` +
        `a várt ${info.size} helyett); felülírjuk`)
    }
    const started = Date.now()
    let lastReport = 0
    const result = await uploadStream(
      config!, key, createReadStream(path, { highWaterMark: 4 * 1024 * 1024 }), contentType,
      {
        partBytes,
        concurrency,
        onProgress: (bytes, parts) => {
          const now = Date.now()
          if (now - lastReport < 2000 && bytes < info.size) return
          lastReport = now
          const seconds = (now - started) / 1000
          const percent = ((bytes / info.size) * 100).toFixed(1)
          const rate = bytes / seconds / 1024 / 1024
          const left = rate > 0 ? (info.size - bytes) / 1024 / 1024 / rate : 0
          console.log(`  ${percent}% — ${mb(bytes)}/${mb(info.size)} MB, ${parts} darab, ` +
            `${rate.toFixed(1)} MB/s, még ~${Math.round(left)} s`)
        }
      })

    const seconds = (Date.now() - started) / 1000
    console.log(`feltöltve: ${mb(result.bytes)} MB, ${result.parts} darab, ${seconds.toFixed(1)} s`)

    // A FELTÖLTÉS UTÁNI ELLENŐRZÉS nem formalitás: a többrészes lezárás akkor
    // is 200-at adhat, ha a darabok összefűzése hibás volt, és az eredmény egy
    // csendben sérült videó. A méret az első dolog, ami ilyenkor nem stimmel.
    const check = await headObject(config!, key)
    if (!check) fail('a feltöltés után nem találjuk az objektumot a vödörben')
    if (check.size !== null && check.size !== info.size) {
      fail(`a feltöltött méret ${check.size} bájt, a fájlé ${info.size} — a feltöltés hibás`)
    }
    console.log(`ellenőrizve: ${check.size === null ? 'létezik (méret ismeretlen)' : `${check.size} bájt`}`)
  }
}

if (publicUrl) console.log(`cím: ${publicUrl}`)
else {
  console.warn('a MEDIA_BASE_URL nincs abszolút címre állítva, ezért nyilvános URL-t nem tudok mondani; ' +
    'add meg a --base kapcsolóval, ha regisztrálni akarod a forrást')
}

// ---------------------------------------------------------------------------
// A forrás bejegyzése
// ---------------------------------------------------------------------------

const episodeId = option('episode')
if (!episodeId) {
  console.log('a forrás nincs bejegyezve (nem adtál --episode azonosítót)')
  process.exit(0)
}
if (!publicUrl) fail('nyilvános URL nélkül nem tudom bejegyezni a forrást')
if (dryRun) {
  console.log(`[száraz] bejegyzés ide: epizód ${episodeId}, http, ${publicUrl}`)
  process.exit(0)
}

// Az adatbázist CSAK itt kérjük: enélkül a feltöltés futhat olyan gépen is,
// ahol nincs adatbázis-hozzáférés.
const { pool, queryOne } = await import('../src/infrastructure/database/index.ts')

try {
  const episode = await queryOne<{ id: string, number: number, anime: string }>(
    `SELECT e.id, e.number, a.canonical_title AS anime
       FROM episodes e JOIN anime a ON a.id = e.anime_id
      WHERE e.id = $1`, [episodeId])
  if (!episode) fail(`nincs ilyen epizód: ${episodeId}`)

  const title = option('title') ?? basename(path, ext)

  const row = await queryOne<{ id: string }>(
    `INSERT INTO video_sources
       (episode_id, kind, ref, title, provider, resolution, language, variant,
        enabled, priority, is_batch, size_bytes)
     VALUES ($1, 'http', $2, $3, $4, $5, $6, $7, true, $8, false, $9)
     RETURNING id`,
    [episodeId, publicUrl, title, option('provider') ?? 'YUME', resolution,
      option('language'), variant, Number(option('priority') ?? 0), info.size])

  console.log(`bejegyezve: ${episode.anime} ${episode.number}. rész — forrás ${row?.id}`)
} catch (error) {
  // A (episode_id, kind, ref) egyedi. Ugyanaz a fájl ugyanahhoz az epizódhoz
  // kétszer nem két forrás — és ez a futás így is elérte a célját: fent van.
  if ((error as { code?: string }).code === '23505') {
    console.log('ez a forrás már be van jegyezve ehhez az epizódhoz')
  } else {
    throw error
  }
} finally {
  await pool.end()
}
