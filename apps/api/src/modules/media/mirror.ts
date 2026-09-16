// A katalógus képeinek tükrözése saját tárhelyre.
//
// MIÉRT: a YUME minden képe idegen CDN-ről jön (AniList, TheTVDB, MyAnimeList).
// Ez ma ingyen van — a látogató böngészője tölti —, de azon a napon, amikor
// bármelyik szolgáltató letiltja a hotlinkelést, a katalógus képek nélkül
// marad, és akkor már letükrözni sem lehet őket. Ez a modul azt a másolatot
// készíti el, amit utólag nem lehetne.
//
// AMIT NEM CSINÁL: nem változtat azon, honnan szolgáljuk ki a képeket. A
// tükrözés és az átkapcsolás két külön döntés — lásd `media_mirror_serve`.
//
// A FUTÁS UDVARIAS. Nem azért, mert lassúnak kell lennie, hanem mert harmincezer
// kérés egy idegen CDN-re rövid idő alatt pontosan az a viselkedés, amiért a
// hotlinkelést letiltják. Kis kötegek, korlátozott párhuzamosság, és a hibás
// URL-t háromszori próbálkozás után elengedjük.

import { createHash } from 'node:crypto'

import { mediaStorage, putObject, type S3Config } from '../../infrastructure/storage/s3.ts'
import { query, queryOne } from '../../infrastructure/database/index.ts'

/** Egy futás mérlege. Ez megy a naplóba és a panelre. */
export interface MirrorResult {
  examined: number
  mirrored: number
  failed: number
  bytes: number
  skipped: string
}

/** Amit tükrözünk, és milyen sorrendben. A borító a legfontosabb: minden kártyán ott van. */
const KIND_ORDER = ['cover', 'banner', 'backdrop', 'logo']

/**
 * A tárhelykulcs egy forrás-URL-ből.
 *
 * TARTALOMCÍMZETT, a forrás URL-jének hasításából: ugyanaz a kép ugyanazt a
 * kulcsot kapja, tehát egy megismételt futás nem hoz létre duplikátumot, és a
 * kulcs SOSEM változik.
 *
 * TÖBB KATALÓGUSSOR OSZTOZHAT EGY KULCSON, és ezt először elrontottam: ugyanaz
 * a borító két bejegyzéshez ugyanazt a forrás-URL-t viseli, tehát ugyanazt a
 * kulcsot kapja. A soron lévő egyedi index emiatt 119 tükrözést bukott el
 * 3 624-ből — a kép megérkezett, csak a sor nem tudta feljegyezni. Lásd a
 * 0056-os migrációt. Ez utóbbi azért számít, mert így a kiszolgálásnál
 * `immutable` gyorsítótárazás adható rá — egy kulcs mögött sosem lesz más kép.
 *
 * A kiterjesztés a forrásból jön, mert a böngésző és a tárhely is ebből dönti
 * el a típust; ha nincs, `jpg` a feltételezés, mert a katalógus képei azok.
 */
export function mirrorKeyFor (kind: string, sourceUrl: string): string {
  const digest = createHash('sha256').update(sourceUrl).digest('hex')
  const match = /\.([a-z0-9]{3,4})(?:\?|$)/i.exec(sourceUrl)
  const ext = (match?.[1] ?? 'jpg').toLowerCase()
  return `media/${kind}/${digest.slice(0, 2)}/${digest}.${ext}`
}

/** A letöltött tartalom típusa, megszorítva arra, ami kép lehet. */
function imageTypeOf (headerValue: string | null, key: string): string | null {
  const declared = headerValue?.split(';')[0]?.trim().toLowerCase()
  if (declared && declared.startsWith('image/')) return declared
  // Néhány CDN `application/octet-stream`-et mond. A kiterjesztés ilyenkor
  // többet tud — de csak akkor fogadjuk el, ha kép-kiterjesztés.
  const ext = key.split('.').pop()
  const byExt: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', avif: 'image/avif'
  }
  return ext ? byExt[ext] ?? null : null
}

/**
 * Egy kép áthozása.
 *
 * Kivételt nem dob: a hívó kötegben dolgozik, és egy halott URL nem viheti
 * magával a köteg többi képét. A visszatérés a feltöltött bájtok száma, vagy
 * `null`, ha nem sikerült.
 */
async function mirrorOne (
  config: S3Config, id: string, kind: string, sourceUrl: string, timeoutMs: number
): Promise<number | null> {
  const key = mirrorKeyFor(kind, sourceUrl)
  try {
    const res = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Megmondjuk, kik vagyunk. Egy névtelen tömeges letöltés az, amit egy
        // CDN üzemeltetője joggal blokkol.
        'user-agent': 'YUME image mirror (https://yumee.duckdns.org)',
        accept: 'image/*'
      }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const body = Buffer.from(await res.arrayBuffer())
    if (body.length === 0) throw new Error('üres válasz')

    const type = imageTypeOf(res.headers.get('content-type'), key)
    if (!type) throw new Error(`nem kép: ${res.headers.get('content-type') ?? 'ismeretlen típus'}`)

    await putObject(config, key, body, type)
    await query(
      'UPDATE anime_images SET mirror_key = $2, mirrored_at = now() WHERE id = $1', [id, key])
    return body.length
  } catch (error) {
    await query(
      'UPDATE anime_images SET mirror_attempts = mirror_attempts + 1 WHERE id = $1', [id])
    console.warn(`kép tükrözése nem sikerült (${kind} ${id}): ${(error as Error).message}`)
    return null
  }
}

/**
 * Egy köteg tükrözése.
 *
 * `batch` képet hoz át, `concurrency` szálon. Az alapértékek szándékosan
 * szerények: ez egy háttérfeladat, aminek nincs határideje, és a cél nem az,
 * hogy gyors legyen, hanem hogy egyszer lefusson anélkül, hogy kitiltanának
 * minket a forrásról.
 */
export async function mirrorBatch ({
  batch = Number(process.env.MEDIA_MIRROR_BATCH ?? 200),
  concurrency = Number(process.env.MEDIA_MIRROR_CONCURRENCY ?? 4),
  timeoutMs = Number(process.env.MEDIA_MIRROR_TIMEOUT_MS ?? 20_000),
  kinds = KIND_ORDER
}: { batch?: number, concurrency?: number, timeoutMs?: number, kinds?: string[] } = {}
): Promise<MirrorResult> {
  // A MÉDIAVÖDÖR, nem a mentéseké. A kettő szándékosan külön: ezt a tartalmat
  // egy nyilvános útvonal szolgálja ki, a mentéseket soha semmi.
  const config = mediaStorage()
  if (!config) {
    return { examined: 0, mirrored: 0, failed: 0, bytes: 0, skipped: 'nincs tárhely beállítva' }
  }

  /*
   * A kiválasztás sorrendje a `kinds` tömbé, nem az azonosítóé: a borítókat
   * előbb akarjuk, mert minden kártyán ott vannak, és mert a katalógus 32 390
   * borítója már önmagában is használható tükör, ha a többi soha nem készül el.
   */
  const rows = await query<{ id: string, kind: string, object_key: string }>(
    `SELECT id::text, kind, object_key
       FROM anime_images
      WHERE mirror_key IS NULL
        AND mirror_attempts < 3
        AND object_key LIKE 'http%'
        AND kind = ANY($1)
      ORDER BY array_position($1::text[], kind), id
      LIMIT $2`,
    [kinds, batch]
  )
  if (!rows.length) {
    return { examined: 0, mirrored: 0, failed: 0, bytes: 0, skipped: 'nincs tükrözendő kép' }
  }

  let mirrored = 0
  let failed = 0
  let bytes = 0

  // Egyszerű munkamegosztás: `concurrency` darab futó, mind ugyanabból a
  // sorból vesz. Nincs szükség könyvtárra ahhoz, hogy négy dolog egyszerre
  // menjen.
  const queue = [...rows]
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const row = queue.shift()
      if (!row) return
      const size = await mirrorOne(config, row.id, row.kind, row.object_key, timeoutMs)
      if (size === null) failed++
      else { mirrored++; bytes += size }
    }
  })
  await Promise.all(workers)

  return { examined: rows.length, mirrored, failed, bytes, skipped: '' }
}

/** Hol tart a tükrözés. A panel és a napló ebből olvas. */
export async function mirrorProgress (): Promise<Array<{
  kind: string, total: number, mirrored: number, failed: number
}>> {
  return await query(
    `SELECT kind,
            count(*)::int AS total,
            count(*) FILTER (WHERE mirror_key IS NOT NULL)::int AS mirrored,
            count(*) FILTER (WHERE mirror_key IS NULL AND mirror_attempts >= 3)::int AS failed
       FROM anime_images
      WHERE object_key LIKE 'http%'
      GROUP BY kind
      ORDER BY array_position($1::text[], kind)`,
    [KIND_ORDER]
  )
}

/**
 * Kell-e még egy köteg, és ütemezhető-e.
 *
 * KÜLÖNVÁLASZTVA a tükrözéstől, mert két külön kérdés: „mit hoztunk át" és
 * „mi legyen ezután". A második maga is elromolhat — és el is romlott.
 *
 * AZ ELSŐ VÁLTOZAT NÉMÁN NEM CSINÁLT SEMMIT. Az utódot a szokásos
 * `dedupe: 'media-mirror'` kulccsal ütemeztem, mint minden más ismétlődő
 * feladatot. Csakhogy a `jobs_dedupe_idx` a `done_at IS NULL` sorokra szóló
 * részleges egyedi index, és amíg a kezelő fut, a SAJÁT feladata még nincs
 * késznek jelölve: az utód önmagával ütközött, az `ON CONFLICT DO NOTHING`
 * eldobta. Élesben ez 200 letükrözött képet jelentett a 32 390-ből, egyetlen
 * hibaüzenet nélkül.
 *
 * Az utód ezért saját kulcsot kap, a feltorlódás ellen pedig nem a kulcs véd,
 * hanem a számolás: ha már várakozik egy tükrözés, ez a futás nem tesz hozzá
 * másikat.
 *
 * Igazzal tér vissza, ha ütemezett egyet.
 */
export async function scheduleNext (
  jobId: string, result: MirrorResult, kinds?: string[]
): Promise<boolean> {
  if (result.examined === 0) return false

  const waiting = await queryOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM jobs WHERE queue = 'media' AND done_at IS NULL AND id <> $1",
    [jobId]
  )
  if (Number(waiting?.n ?? 0) > 0) return false

  const { enqueue } = await import('../../infrastructure/queue/index.ts')
  await enqueue('media', {
    ...(kinds ? { kinds } : {}),
    dedupe: `media-mirror:${Date.now()}`
  })
  return true
}

/**
 * A feladatsor kezelője.
 *
 * Kötegenként fut, és magát ütemezi újra, amíg van mit tükrözni. Ez azért így
 * van, és nem egyetlen hosszú futásként, mert 57 012 kép letöltése óra
 * nagyságrend: egy megszakadt futás így nem kezdi elölről, és a sor többi
 * feladata sem áll meg mögötte.
 */
export async function handleMediaJob (job: { id: string, payload: Record<string, unknown> }): Promise<void> {
  const kinds = Array.isArray(job.payload.kinds)
    ? (job.payload.kinds as string[])
    : undefined

  const result = await mirrorBatch(kinds ? { kinds } : {})
  if (result.skipped) {
    console.log(`képtükör: ${result.skipped}`)
    return
  }

  console.log(
    `képtükör: ${result.mirrored} kép (${(result.bytes / 1024 / 1024).toFixed(1)} MB)` +
    `${result.failed ? `, ${result.failed} nem sikerült` : ''}`
  )

  await scheduleNext(job.id, result, kinds)
}
