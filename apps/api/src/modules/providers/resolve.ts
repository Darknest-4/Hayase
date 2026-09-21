// A feloldás — a forró út.
//
// Ez fut le, amikor valaki megnyom egy lejátszás gombot. A sorrendje:
//
//   1. gyorsítótár — ha van érvényes válasz, azonnal;
//   2. a regiszterből a BEKAPCSOLT szolgáltatók, prioritás szerint;
//   3. akit a megszakító kizárt, azt átugorjuk (lásd `health.ts`);
//   4. mindegyiket időkorláttal kérdezzük;
//   5. az első, ami forrást ad, nyer — a többit meg sem kérdezzük.
//
// MIÉRT NEM KÉRDEZÜNK MINDENKIT PÁRHUZAMOSAN. Kísértő, és gyorsabb is lenne
// — de minden lejátszásindítás minden szolgáltatót megterhelne, akkor is,
// amikor az első azonnal válaszol. Egy sorban haladó lánc a jó polgár, és a
// megszakító úgyis kiveszi belőle azt, ami lassú.
//
// A LÁNC MINDEN LÉPÉSE A NAPLÓBA KERÜL. Egy „nincs forrás" válaszra a
// leggyakoribb kérdés az, hogy MIÉRT — és arra egy üres tömb nem felelet. A
// visszaadott `attempts` pontosan megmondja, kit kérdeztünk meg, mit
// válaszolt, és mennyi ideig tartott.

import { noResult } from './types.ts'
import { ranked } from './registry.ts'
import * as health from './health.ts'
import { recordAttempts } from './metrics.ts'

import type { EpisodeRef, ProviderResult, ProviderSource } from './types.ts'
import { scrubHeaders } from './scrub.ts'

/** Ennyi idő után feladjuk egy szolgáltatónál. */
const TIMEOUT_MS = 8_000

/**
 * A gyorsítótár alapértelmezett élettartama.
 *
 * Csak akkor számít, ha a szolgáltató NEM mond `expiresAt`-et. Ha mond, az
 * övé az erősebb: egy aláírt cím lejárata nem a mi döntésünk.
 */
const CACHE_MS = 5 * 60_000

/** Egy lépés a láncban — ez megy a válaszba és a naplóba. */
export interface Attempt {
  provider: string
  outcome: 'ok' | 'empty' | 'error' | 'skipped' | 'timeout'
  sources: number
  ms: number
  detail?: string
}

export interface Resolution extends ProviderResult {
  /** Melyik szolgáltatótól van az eredmény. `null`, ha egyiktől sem. */
  provider: string | null
  fromCache: boolean
  attempts: Attempt[]
}

interface CacheEntry { at: number, until: number, value: Resolution }
const cache = new Map<string, CacheEntry>()

/** Csak tesztekhez. */
export function clearCache (): void { cache.clear() }

/**
 * A gyorsítótár kulcsa.
 *
 * A VÁLTOZAT IS BENNE VAN. Enélkül egy feliratos kérés válaszát kapná vissza
 * az is, aki szinkronosat kért — ugyanarra az epizódra —, és a hiba csak a
 * lejátszóban derülne ki, rossz hangsávként.
 */
function keyOf (ref: EpisodeRef): string {
  return [ref.anilistId ?? ref.title.toLowerCase(), ref.number, ref.variant ?? 'any'].join('|')
}

/**
 * Mikor jár le ez az eredmény?
 *
 * A LEGKORÁBBI forrás lejárata dönt, nem a legkésőbbi: ha az egyik cím
 * három perc múlva érvénytelen, egy öt percig tárolt válasz felében halott
 * címeket adna vissza.
 */
function expiryOf (sources: ProviderSource[], now: number): number {
  const stamps = sources
    .map(s => s.expiresAt ? new Date(s.expiresAt).getTime() : null)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > now)
  return stamps.length ? Math.min(...stamps) : now + CACHE_MS
}

/** Időkorlát egy ígéretre — a szolgáltatónak nem kell tudnia róla. */
async function withTimeout<T> (work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT')), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Forrás keresése egy epizódhoz, a bekapcsolt szolgáltatók láncán.
 *
 * SOHA NEM DOB. Egy szolgáltató hibája nem a néző hibája: ilyenkor üres
 * eredmény jön vissza, az `attempts`-ben pedig ott áll, mi történt.
 */
export async function resolveEpisode (ref: EpisodeRef): Promise<Resolution> {
  const now = Date.now()
  const key = keyOf(ref)

  const hit = cache.get(key)
  if (hit && hit.until > now) {
    return { ...hit.value, fromCache: true }
  }
  if (hit) cache.delete(key)

  const attempts: Attempt[] = []
  let entries: Awaited<ReturnType<typeof ranked>> = []
  try {
    entries = await ranked()
  } catch (error) {
    // A regiszter maga hasalt el. Ez nem a szolgáltatók hibája, és nem is
    // gyorsítótárazható eredmény.
    console.error('a szolgáltatók regisztere nem olvasható', error)
    return { ...noResult(), provider: null, fromCache: false, attempts }
  }

  for (const { provider, config } of entries) {
    if (!health.usable(provider.id)) {
      attempts.push({ provider: provider.id, outcome: 'skipped', sources: 0, ms: 0, detail: 'a megszakító kizárta' })
      continue
    }

    const started = Date.now()
    try {
      // A beállítás a REGISZTERBŐL jön, minden feloldásnál frissen — így egy
      // adminfelületen átírt érték a következő kérésre már hat.
      const result = await withTimeout(provider.resolve(ref, config), TIMEOUT_MS)
      const ms = Date.now() - started
      const sources = result.sources?.length ?? 0

      if (sources > 0) {
        /*
         * A FEJLÉCEK MEGTISZTÍTÁSA — itt, a lánc határán.
         *
         * A `headers` kimegy a böngészőnek (ez a mező értelme), tehát ami ide
         * bekerül, azt minden néző látja. Volt rá ellenőrzés, de az TESZT-segéd
         * volt: csak akkor futott, ha az adapter szerzője megírta hozzá a
         * tesztet. Itt viszont minden eredmény átmegy rajta.
         *
         * Nem csendben: az eltávolított fejléc NEVE a naplóba kerül (az értéke
         * soha), mert az adapter szerzőjének meg kell tudnia, hogy amit beírt,
         * nem megy ki.
         */
        const eltavolitott = new Set<string>()
        for (const forras of result.sources) {
          const { kept, removed } = scrubHeaders(forras.headers)
          forras.headers = kept
          for (const nev of removed) eltavolitott.add(nev)
        }
        for (const felirat of result.subtitles ?? []) {
          const { kept, removed } = scrubHeaders(felirat.headers)
          felirat.headers = kept
          for (const nev of removed) eltavolitott.add(nev)
        }
        if (eltavolitott.size) {
          console.warn(
            `a(z) ${provider.id} szolgáltató érzékeny fejlécet adott vissza, ` +
            `ezért nem megy ki a böngészőnek: ${[...eltavolitott].join(', ')}`
          )
        }

        health.succeeded(provider.id, ms, sources)
        attempts.push({ provider: provider.id, outcome: 'ok', sources, ms })
        const value: Resolution = {
          sources: result.sources,
          subtitles: result.subtitles ?? [],
          provider: provider.id,
          fromCache: false,
          attempts
        }
        cache.set(key, { at: now, until: expiryOf(result.sources, Date.now()), value })
        // A MÉRÉS A VÁLASZ ELŐTT, de nem a válasz ÁRÁN: memóriába gyűl,
        // kötegben megy ki. Lásd `metrics.ts`.
        recordAttempts(attempts)
        return value
      }

      /*
       * ÜRES VÁLASZ NEM HIBA. A szolgáltató elérhető volt és felelt — csak
       * ehhez az epizódhoz nincs nála semmi. A megszakító szempontjából ez
       * SIKER, különben egy ritka cím kizárná az egész szolgáltatót.
       */
      health.succeeded(provider.id, ms, 0)
      attempts.push({ provider: provider.id, outcome: 'empty', sources: 0, ms })
    } catch (error) {
      const ms = Date.now() - started
      const timeout = error instanceof Error && error.message === 'TIMEOUT'
      const detail = timeout ? `nem válaszolt ${TIMEOUT_MS} ms alatt` : String((error as Error)?.message ?? error).slice(0, 200)
      health.failed(provider.id, detail, ms)
      attempts.push({ provider: provider.id, outcome: timeout ? 'timeout' : 'error', sources: 0, ms, detail })
    }
  }

  /*
   * SENKI NEM ADOTT SEMMIT — és ezt NEM tároljuk el.
   *
   * Egy üres eredmény gyorsítótárazása azt jelentené, hogy amikor öt perc
   * múlva egy szolgáltató helyreáll, a néző még mindig azt látja, hogy nincs
   * forrás. A hiányt olcsóbb újrakérdezni, mint tévesen fenntartani.
   */
  recordAttempts(attempts)
  return { ...noResult(), provider: null, fromCache: false, attempts }
}
