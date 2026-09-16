// Többdimenziós számlálók — a forró úton, memóriában.
//
// MIÉRT NEM REDIS (még):
// Egy app-példány fut. A `docs/redis.md` leírja, mikor nem lesz ez így, és
// mit kell akkor kicserélni. Ez a modul pontosan az a hely: a hívói felület
// (`hit`, `recent`) nem változik, csak a tároló mögötte. Redist bevezetni ma
// azért, mert egy „edge" rendszertől ezt várja az ember, egy második
// szolgáltatás lenne, amit üzemeltetni és menteni kell, azért a képességért,
// amire nincs második példány.
//
// MIÉRT NEM A MEGLÉVŐ RATE LIMIT:
// A `@fastify/rate-limit` IP szerint számol, és jól. Amit nem tud: fiók,
// munkamenet, API-kulcs és ezek KOMBINÁCIÓJA szerint, és nem tudja
// megkülönböztetni a rövid tüskét a tartós nyomástól. Egy IP-t váltó
// hitelesített visszaélő a meglévő korláton nem akad fenn. Ez a modul azt
// teszi hozzá, amit az nem tud — nem váltja le.
//
// CSÚSZÓ ABLAK, nem vödör: egy percenkénti vödör határán kétszeres tüske fér
// át észrevétlenül, és pont a határ az, amit egy gépi hívó eltalál.

/** Egy dimenzió, ami szerint számolunk. */
export type Dimension = 'ip' | 'user' | 'session' | 'api_key' | 'route' | 'ip+route' | 'user+route'

export interface Limit {
  /** Rövid ablak: a tüske. */
  burst: { max: number, seconds: number }
  /** Hosszú ablak: a tartós nyomás. */
  sustained: { max: number, seconds: number }
  /** Átlépés után ennyi ideig minden kérés elutasítva. 0 = nincs lehűlés. */
  cooldownSeconds: number
}

export interface Verdict {
  /** Belefér-e. */
  ok: boolean
  /** Melyik ablak telt be, ha nem fér bele. */
  window?: 'burst' | 'sustained' | 'cooldown'
  /** Hány másodperc múlva próbálkozhat újra. */
  retryAfter?: number
  /** Hány kérés volt a hosszú ablakban — a kockázati jelnek kell. */
  sustainedCount: number
  /** Ugyanez a rövid ablakban. */
  burstCount: number
}

/**
 * Egy kulcs eseményei.
 *
 * Időbélyegek tömbje, a legrégebbi elöl. Egy nagyságrenddel egyszerűbb, mint
 * bármi más, és a méretét a leghosszabb ablak korlátozza: ami kiesik belőle,
 * azt eldobjuk.
 */
interface Bucket {
  hits: number[]
  /** Meddig tart a lehűlés, ha van. */
  until: number
}

const buckets = new Map<string, Bucket>()
const MAX_KEYS = Number(process.env.EDGE_COUNTER_KEYS ?? 50_000)

/**
 * Takarítás.
 *
 * Egy nyilvános végpont számlálói egy támadás alatt gyorsan nőnek, és a
 * memória véges. Nem LRU: a lejárt bejegyzések mennek először, és ha az nem
 * elég, az egész ürül. A csere tudatos — a számlálás egy pillanatra elveszik,
 * a folyamat viszont nem eszi meg a memóriát.
 */
function sweep (now: number, horizon: number): void {
  if (buckets.size < MAX_KEYS) return
  for (const [key, bucket] of buckets) {
    if (bucket.until > now) continue
    const last = bucket.hits.at(-1)
    if (last === undefined || now - last > horizon) buckets.delete(key)
  }
  if (buckets.size >= MAX_KEYS) buckets.clear()
}

/**
 * Egy kérés beszámítása.
 *
 * A `count: false` azt jelenti, hogy csak MEGNÉZZÜK az állást, de nem írjuk
 * be — erre a kockázatszámításnak van szüksége, aminek tudnia kell az
 * ütemről anélkül, hogy maga is befolyásolná.
 */
export function hit (dimension: Dimension, subject: string, limit: Limit, count = true): Verdict {
  const key = dimension + ' ' + subject
  const now = Date.now()
  const horizon = limit.sustained.seconds * 1000

  sweep(now, horizon)

  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = { hits: [], until: 0 }
    buckets.set(key, bucket)
  }

  if (bucket.until > now) {
    return {
      ok: false,
      window: 'cooldown',
      retryAfter: Math.ceil((bucket.until - now) / 1000),
      sustainedCount: bucket.hits.length,
      burstCount: 0
    }
  }

  // Ami kiesett a leghosszabb ablakból, az eldobható.
  const cutoff = now - horizon
  const oldest = bucket.hits[0]
  if (oldest !== undefined && oldest < cutoff) {
    bucket.hits = bucket.hits.filter(at => at >= cutoff)
  }

  const burstCutoff = now - limit.burst.seconds * 1000
  const burstCount = bucket.hits.reduce((n, at) => at >= burstCutoff ? n + 1 : n, 0)
  const sustainedCount = bucket.hits.length

  if (count) bucket.hits.push(now)

  if (burstCount >= limit.burst.max) {
    if (limit.cooldownSeconds > 0) bucket.until = now + limit.cooldownSeconds * 1000
    return {
      ok: false,
      window: 'burst',
      retryAfter: limit.cooldownSeconds > 0 ? limit.cooldownSeconds : limit.burst.seconds,
      sustainedCount,
      burstCount
    }
  }

  if (sustainedCount >= limit.sustained.max) {
    if (limit.cooldownSeconds > 0) bucket.until = now + limit.cooldownSeconds * 1000
    return {
      ok: false,
      window: 'sustained',
      retryAfter: limit.cooldownSeconds > 0 ? limit.cooldownSeconds : limit.sustained.seconds,
      sustainedCount,
      burstCount
    }
  }

  return { ok: true, sustainedCount, burstCount }
}

/** Hány kérés jött ettől a kulcstól az elmúlt N másodpercben. */
export function recent (dimension: Dimension, subject: string, seconds: number): number {
  const bucket = buckets.get(dimension + ' ' + subject)
  if (!bucket) return 0
  const cutoff = Date.now() - seconds * 1000
  return bucket.hits.reduce((n, at) => at >= cutoff ? n + 1 : n, 0)
}

/**
 * Az ütem egyenletessége.
 *
 * Ember nem kattint metronómra. Ha az egymást követő kérések közti szünetek
 * szórása a saját átlagukhoz képest elenyésző, az gépi ütem — és ezt sokkal
 * nehezebb elrejteni, mint egy böngészőazonosítót.
 *
 * A visszatérési érték 0 (teljesen szabálytalan) és 1 (tökéletes metronóm)
 * között van. Kevesebb mint öt kérésből nem mondunk semmit: három egyenletes
 * kattintás egy emberé is lehet.
 */
export function cadence (dimension: Dimension, subject: string): number {
  const bucket = buckets.get(dimension + ' ' + subject)
  if (!bucket || bucket.hits.length < 5) return 0

  const gaps: number[] = []
  for (let i = 1; i < bucket.hits.length; i++) {
    const previous = bucket.hits[i - 1]
    const current = bucket.hits[i]
    if (previous === undefined || current === undefined) continue
    gaps.push(current - previous)
  }
  if (gaps.length < 4) return 0

  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  if (mean <= 0) return 1
  const variance = gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length
  const cv = Math.sqrt(variance) / mean

  // cv = 0 → tökéletesen egyenletes. cv >= 1 → emberi szórás.
  return Math.max(0, Math.min(1, 1 - cv))
}

/** Teszthez: felejtse el, amit számolt. */
export function reset (): void { buckets.clear() }

/** Hány kulcsot tartunk — a panel és a memóriafigyelés kérdése. */
export function size (): number { return buckets.size }
