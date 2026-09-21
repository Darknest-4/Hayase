/**
 * AnimeParadise — HLS a szolgáltató saját, dokumentált API-jából.
 *
 * MINDEN, AMI ITT ÁLL, MÉRVE VAN AZ ÉLŐ API-N (2026-09-21), nem az
 * `anime-sdk` dokumentációjából átvéve. Ez nem óvatoskodás: az SDK a
 * találati rekordból `item.year`-t és `item.released`-et olvas, és EGYIK SEM
 * LÉTEZIK a mai válaszban — helyettük `animeSeason.year` és `startDate` van.
 * Aki a doksit másolja, annál minden találat évszám nélkül marad.
 *
 * A HÁROM VÉGPONT:
 *
 *   GET /search?q=&limit=       → { data: [ { _id, title, alternativeTitle,
 *                                   link, episodes, episodeCount,
 *                                   animeSeason{season,year}, startDate } ] }
 *   GET /anime/{_id}/episode    → { data: [ { _id, uid, number, title,
 *                                   origin } ] }
 *   GET /ep/{uid}?origin={_id}  → { data: { episode: { streamLink, subData,
 *                                   skipData, … } } }
 *
 * A LEJÁTSZHATÓ CÍM ÚTJA. A `streamLink` NEM URL, hanem egy átlátszatlan,
 * aláírt token. A szolgáltató saját stream-kiszolgálója csinál belőle
 * manifesztet:
 *
 *   https://stream.animeparadise.moe/m3u8?url=<token>
 *
 * Ez nem kinyerés és nem megkerülés: a szolgáltató SAJÁT végpontja, amit az
 * SDK és a saját webes lejátszójuk is így hív. Mérve, amit visszaad:
 *
 *   HTTP 200, content-type: application/x-mpegURL
 *   #EXTM3U / #EXT-X-STREAM-INF … RESOLUTION=1920x1080
 *   access-control-allow-origin: *
 *
 * Vagyis valódi HLS master playlist, nyitott CORS-szal — a böngésző
 * `hls.js`-e közvetlenül le tudja kérni.
 *
 * FEJLÉC NEM KELL, és ez MÉRÉS, nem feltételezés. Az SDK
 * `Referer: https://animeparadise.moe/` fejlécet ad vissza; a mérés szerint a
 * manifeszt és a szegmens is 200-at ad fejléc nélkül, sőt a mi origónkkal is.
 * Ez fontos: a böngészőből `Referer`-t NEM lehet állítani (tiltott fejléc),
 * tehát ha tényleg kellene, a lejátszás a böngészőben elbukna. Nem kell —
 * ezért nem adunk vissza fejlécet.
 *
 * CSAK FELIRATOS. A szolgáltató egyetlen hangsávot ad; a `dub` és a `raw`
 * kérésre ÜRES eredmény jár, nem helyettesítés.
 */

import {
  noResult,
  type AnimeProvider, type EpisodeRef, type ProviderEpisode,
  type ProviderMatch, type ProviderResult, type ProviderSource,
  type ProviderSubtitle
} from '../types.ts'
import { checkUpstreamUrl } from '../upstream-url.ts'

const API_BASE = 'https://api.animeparadise.moe'
const STREAM_BASE = 'https://stream.animeparadise.moe'

/**
 * Amely gazdagépekről elfogadunk címet.
 *
 * SSRF ÉS ÁTIRÁNYÍTÁS ELLEN. A manifeszt címét MI állítjuk össze rögzített
 * gazdagéppel, tehát onnan nem jöhet idegen cím — a feliratok viszont a
 * szolgáltató válaszából jönnek, nyersen. Egy `subData` bejegyzés
 * tetszőleges címet hordozhat, és az a néző böngészőjében töltődik be.
 */
const ALLOWED_HOSTS: readonly string[] = ['stream.animeparadise.moe', 'animeparadise.moe']

interface Config {
  apiBaseUrl?: string
  streamBaseUrl?: string
  timeoutMs?: number
  searchLimit?: number
  /** Gazdagépek, amelyekről címet elfogadunk. Üres lista = egy sem. */
  allowedHosts?: readonly string[]
}

// ---------------------------------------------------------------- segédek

function asString (value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asNumber (value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function normalizeTitle (value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * HTTP + JSON, a lánc szabályai szerint.
 *
 * A 404 `null`-t ad („nincs ilyen rekord"), MINDEN MÁS HIBA DOB. Ezen múlik,
 * hogy a körkörös megszakító kinyisson-e: amíg a 404 is kivétel, három
 * ismeretlen cím ugyanúgy leírná a szolgáltatót, mint három leállás.
 */
async function requestJson<T> (url: string, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    })
    if (response.status === 404) return null
    if (response.status === 429) {
      throw new Error('AnimeParadise API rate limit reached (429)')
    }
    if (!response.ok) {
      throw new Error(`AnimeParadise API returned HTTP ${response.status}`)
    }
    return await response.json() as T
  } finally {
    clearTimeout(timer)
  }
}

function apiUrl (config: Config, path: string): string {
  return `${(config.apiBaseUrl ?? API_BASE).replace(/\/+$/, '')}${path}`
}

function hostsOf (config: Config): readonly string[] {
  return config.allowedHosts ?? ALLOWED_HOSTS
}

/**
 * Egy listamező kicsomagolása. Hibás alakra ÜRES, nem kivétel.
 *
 * A NEM-OBJEKTUM ELEMEKET IS KISZŰRI, és ez nem paranoia: egy `[null, 7]`
 * alakú tömbön a címolvasó `null.alternativeTitle`-re szaladt, vagyis egy
 * elrontott válasz KIVÉTELT dobott a `search()`-ből. A lánc azt
 * szolgáltatóhibának látja, és kinyitja a megszakítót — pedig a szolgáltató
 * válaszolt, csak mást, mint vártunk. A két eset nem ugyanaz.
 */
function unwrapList (payload: unknown): Array<Record<string, unknown>> {
  const nyers = Array.isArray(payload)
    ? payload
    : (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(nyers)) return []
  return nyers.filter(
    (x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
  )
}

/** Minden cím, amit egy találat hordoz. */
function titlesOf (item: Record<string, unknown>): string[] {
  const out: string[] = []
  const alt = item.alternativeTitle as Record<string, unknown> | undefined
  for (const value of [alt?.english, alt?.romaji, item.title, alt?.native]) {
    const t = asString(value)
    if (t) out.push(t)
  }
  return out
}

/**
 * Az évszám — `animeSeason.year`, majd `startDate`.
 *
 * AZ SDK EZT ELRONTJA: `item.year ?? new Date(item.released)`, és egyik mező
 * sem létezik a mai válaszban. Az eredmény csendes: minden találat évszám
 * nélkül marad, és az évszám mint rangsorjel eltűnik.
 */
function yearOf (item: Record<string, unknown>): number | null {
  const season = item.animeSeason as Record<string, unknown> | undefined
  const fromSeason = asNumber(season?.year)
  if (fromSeason !== null) return fromSeason
  const start = asString(item.startDate)
  if (start) {
    const parsed = Number(start.slice(0, 4))
    if (Number.isFinite(parsed) && parsed > 1900) return parsed
  }
  return null
}

/**
 * AZ ANILIST-AZONOSÍTÓT NEM TALÁLJUK KI.
 *
 * Az API nem ad ilyen mezőt. A poszter viszont az AniList CDN-jéről jön, és
 * annak az útvonala tartalmazza a média azonosítóját (`…/bx154587-….jpg`).
 * Ez VALÓDI jel, de nem dokumentált mező — a CDN útvonalsémája bármikor
 * változhat, és egy téves párosításból rossz epizód lesz.
 *
 * Ezért ezt SOSEM adjuk vissza `ProviderMatch.anilistId`-ként. Egyetlen
 * dologra használjuk: ha a hívó MÁR HOZOTT egy AniList-azonosítót, és az
 * egyezik az itt találttal, az MEGERŐSÍTI a találatot. Megerősíteni egy
 * kapott azonosítót nem ugyanaz, mint kitalálni egyet.
 */
function anilistHintFromPoster (item: Record<string, unknown>): number | null {
  const poster = item.posterImage as Record<string, unknown> | undefined
  for (const value of [poster?.large, poster?.medium, poster?.small]) {
    const url = asString(value)
    if (!url) continue
    const m = /^https:\/\/s4\.anilist\.co\/.*\/bx(\d+)-/.exec(url)
    if (m?.[1]) {
      const id = Number(m[1])
      if (Number.isFinite(id) && id > 0) return id
    }
  }
  return null
}

interface Hint { anilistId?: number | null, year?: number | null }

/**
 * Egy találat pontszáma.
 *
 * A JELEK SÚLYA: pontos cím a legerősebb, mert az AniList-azonosító itt csak
 * MEGERŐSÍT (lásd fent), nem azonosít. Az évszám CSAK RANGSORJEL, és sosem
 * zár ki: a katalógusok évszáma gyakran a premier és nem a gyártás éve, és
 * egy téves év nem érhet annyit, hogy elvegye a jó találatot.
 */
function scoreItem (item: Record<string, unknown>, wanted: string, hint: Hint): number {
  let score = 0

  for (const cim of titlesOf(item)) {
    const n = normalizeTitle(cim)
    if (!n) continue
    if (n === wanted) { score += 60; break }
    if (n.includes(wanted) || wanted.includes(n)) { score += 25; break }
  }

  if (hint.anilistId != null) {
    const poster = anilistHintFromPoster(item)
    if (poster !== null && poster === hint.anilistId) score += 40
  }

  if (hint.year != null && score > 0 && yearOf(item) === hint.year) score += 5
  return score
}

function toMatch (item: Record<string, unknown>): ProviderMatch | null {
  const id = asString(item._id)
  if (!id) return null
  const titles = titlesOf(item)
  return {
    id,
    title: titles[0] ?? '',
    // Az API nem ad AniList-azonosítót, és nem találunk ki egyet.
    anilistId: null,
    year: yearOf(item),
    episodeCount: asNumber(item.episodeCount) ?? asNumber(item.episodes)
  }
}

// ------------------------------------------------------------- feliratok

/**
 * A `subData` → `ProviderSubtitle[]`.
 *
 * AMIT KI KELL DOBNI, ÉS MIÉRT. A mérés szerint a `subData` VEGYES: hét
 * bejegyzésből négy nem cím, hanem Google Drive fájlazonosító
 * (`1ZvDDo79ZE7bc8UFxs0Yn3ShLJP-V_4Ng`, `type: "ass"`), és csak három
 * valódi `https://stream.animeparadise.moe/captions?url=…` cím.
 *
 * Egy fájlazonosítót címként továbbadni annyit tenne, hogy a lejátszó egy
 * értelmezhetetlen relatív útvonalat próbálna betölteni — néma hiba, üres
 * feliratsáv. Ezért minden bejegyzés átmegy ugyanazon a határon, mint a
 * stream: https, engedélyezett gazdagép, hitelesítő adat nélkül.
 *
 * A FÁJLT NEM TÖLTJÜK LE ÉS NEM PROXYZZUK — az upstream címet adjuk vissza,
 * ahogy a réteg többi része is teszi.
 */
const LABEL_TO_BCP47: Record<string, string> = {
  english: 'en', japanese: 'ja', hungarian: 'hu', spanish: 'es', italian: 'it',
  portuguese: 'pt', 'portuguese-brazil': 'pt-BR', french: 'fr', german: 'de',
  arabic: 'ar', russian: 'ru', chinese: 'zh', korean: 'ko', dutch: 'nl',
  polish: 'pl', turkish: 'tr', indonesian: 'id', thai: 'th', vietnamese: 'vi'
}

function languageOf (label: string): string {
  const key = label.trim().toLowerCase()
  return LABEL_TO_BCP47[key] ?? key.slice(0, 2)
}

function formatOf (raw: unknown, url: string): 'vtt' | 'ass' | 'srt' | null {
  const declared = asString(raw)?.toLowerCase()
  if (declared === 'vtt' || declared === 'ass' || declared === 'srt') return declared
  const path = url.split('?')[0]?.toLowerCase() ?? ''
  if (path.endsWith('.vtt')) return 'vtt'
  if (path.endsWith('.ass') || path.endsWith('.ssa')) return 'ass'
  if (path.endsWith('.srt')) return 'srt'
  return null
}

function subtitlesOf (subData: unknown, hosts: readonly string[]): ProviderSubtitle[] {
  if (!Array.isArray(subData)) return []
  const out: ProviderSubtitle[] = []
  let elso = true
  for (const entry of subData) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const url = checkUpstreamUrl(rec.src ?? rec.url ?? rec.file, hosts).url
    if (!url) continue

    const label = asString(rec.label) ?? asString(rec.language) ?? 'Unknown'
    const format = formatOf(rec.type ?? rec.format, url)
    // Ismeretlen formátumot nem tippelünk: a szerződés zárt halmazt vár, és
    // egy rosszul megnevezett sáv némán nem jelenik meg a lejátszóban.
    if (!format) continue

    out.push({
      language: languageOf(label),
      kind: 'subtitles',
      format,
      url,
      isDefault: elso
    })
    elso = false
  }
  return out
}

// ---------------------------------------------------------------- adapter

interface EpisodeRecord {
  uid?: unknown
  _id?: unknown
  number?: unknown
  title?: unknown
  origin?: unknown
}

export const animeparadiseProvider: AnimeProvider = {
  id: 'animeparadise',
  label: 'AnimeParadise',
  /*
   * A `yume-local` (10) elé semmi nem mehet: a saját katalógusunk sorai
   * erősebb állítást tesznek arról, hogy ez a helyes videó. A 600 a külső
   * szolgáltatók sávja.
   */
  defaultPriority: 600,
  /*
   * ALAPBÓL KIKAPCSOLVA. Ez az adapter minden feloldásnál idegen kiszolgálót
   * hív; a bekapcsolása legyen kifejezett döntés, ne egy kódfrissítés
   * mellékhatása. Lásd `AnimeProvider.defaultEnabled`.
   */
  defaultEnabled: false,

  async search (query: string, hint?: Hint): Promise<ProviderMatch[]> {
    const config: Config = {}
    const limit = Math.min(Math.max(config.searchLimit ?? 20, 1), 50)
    const payload = await requestJson<unknown>(
      apiUrl(config, `/search?q=${encodeURIComponent(query)}&limit=${limit}`),
      config.timeoutMs ?? 8000
    )

    const wanted = normalizeTitle(query)
    return unwrapList(payload)
      .map(item => ({ item, score: scoreItem(item, wanted, hint ?? {}) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(x => toMatch(x.item))
      .filter((m): m is ProviderMatch => m !== null)
  },

  async episodes (matchId: string): Promise<ProviderEpisode[]> {
    if (!matchId.trim()) return []
    const config: Config = {}
    const payload = await requestJson<unknown>(
      apiUrl(config, `/anime/${encodeURIComponent(matchId)}/episode`),
      config.timeoutMs ?? 8000
    )

    return unwrapList(payload)
      .map(raw => {
        const ep = raw as EpisodeRecord
        /*
         * A SZOLGÁLTATÓ SAJÁT AZONOSÍTÓJA, nem gyártott. A `uid` az, amivel a
         * `/ep/{uid}` hívható; a `number` a válaszban SZTRING („1"), ezért
         * megy `asNumber`-en át.
         */
        const id = asString(ep.uid) ?? asString(ep._id)
        const number = asNumber(ep.number)
        if (!id || number === null) return null
        const out: ProviderEpisode = { id, number, title: asString(ep.title) }
        return out
      })
      .filter((e): e is ProviderEpisode => e !== null)
      .sort((a, b) => a.number - b.number)
  },

  async resolve (ref: EpisodeRef, rawConfig?: Record<string, unknown>): Promise<ProviderResult> {
    const config = (rawConfig ?? {}) as Config
    const timeoutMs = config.timeoutMs ?? 8000
    const hosts = hostsOf(config)

    /*
     * CSAK FELIRATOS SÁV VAN.
     *
     * A kért változatot NEM helyettesítjük: aki `dub`-ot kért, annak a
     * feliratos nem jó válasz — rossz hangsávval induló lejátszó lenne
     * belőle, amit a naplóban semmi nem jelez.
     */
    const kert = ref.variant ?? null
    if (kert !== null && kert !== 'sub') {
      diagnose(`a(z) „${kert}" változat nem érhető el — ez a szolgáltató csak feliratosat ad`)
      return noResult()
    }

    // 1. a sorozat megkeresése
    const limit = Math.min(Math.max(config.searchLimit ?? 20, 1), 50)
    const payload = await requestJson<unknown>(
      apiUrl(config, `/search?q=${encodeURIComponent(ref.title)}&limit=${limit}`),
      timeoutMs
    )
    const wanted = normalizeTitle(ref.title)
    const ranked = unwrapList(payload)
      .map(item => ({
        item,
        score: scoreItem(item, wanted, {
          anilistId: ref.anilistId,
          ...(ref.year !== undefined ? { year: ref.year } : {})
        })
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)

    const best = ranked[0]
    if (!best) {
      diagnose(`nincs katalógustalálat: „${ref.title}"`)
      return noResult()
    }
    const seriesId = asString(best.item._id)
    if (!seriesId) return noResult()

    // 2. az epizód megkeresése sorszám szerint
    const epPayload = await requestJson<unknown>(
      apiUrl(config, `/anime/${encodeURIComponent(seriesId)}/episode`),
      timeoutMs
    )
    const episode = unwrapList(epPayload).find(
      raw => asNumber((raw as EpisodeRecord).number) === ref.number
    ) as EpisodeRecord | undefined

    if (!episode) {
      diagnose(`nincs ilyen rész a(z) ${seriesId} sorozatnál: ${ref.number}.`)
      return noResult()
    }
    const uid = asString(episode.uid)
    if (!uid) {
      diagnose(`a(z) ${seriesId}/${ref.number}. résznek nincs uid-je`)
      return noResult()
    }

    // 3. a stream-token lekérése
    const streamPayload = await requestJson<{ data?: { episode?: Record<string, unknown> } }>(
      apiUrl(config, `/ep/${encodeURIComponent(uid)}?origin=${encodeURIComponent(seriesId)}`),
      timeoutMs
    )
    const detail = streamPayload?.data?.episode
    const token = asString(detail?.streamLink)
    if (!token) {
      diagnose(`a(z) ${seriesId}/${ref.number}. részhez nincs streamLink`)
      return noResult()
    }

    /*
     * A TOKEN NEM URL, ÉS EZT ELLENŐRIZZÜK.
     *
     * Egy `?url=` paraméterbe kerülő, szolgáltatótól kapott érték a
     * klasszikus SSRF-felület. Nálunk a gazdagép RÖGZÍTETT, tehát idegen
     * kiszolgálóra nem tud átvinni — de ha az érték maga URL volna, az azt
     * jelentené, hogy az API contractje megváltozott, és akkor inkább
     * megállunk, mint hogy találgassunk.
     */
    if (/^[a-z][a-z0-9+.-]*:/i.test(token) || /[\s<>"']/.test(token)) {
      diagnose(`a(z) ${seriesId}/${ref.number}. rész streamLink mezője nem token alakú — kihagyva`)
      return noResult()
    }

    const streamBase = (config.streamBaseUrl ?? STREAM_BASE).replace(/\/+$/, '')
    const manifest = `${streamBase}/m3u8?url=${encodeURIComponent(token)}`

    /*
     * A KÉSZ CÍM IS ÁTMEGY A HATÁRON. A gazdagépet mi írtuk bele, de a
     * `streamBaseUrl` beállításból is jöhet — egy elrontott konfiguráció ne
     * tudjon tetszőleges címet a néző lejátszójába juttatni.
     */
    const ellenorzott = checkUpstreamUrl(manifest, hosts)
    if (!ellenorzott.url) {
      diagnose(`a stream címe elutasítva (${ellenorzott.reason})`)
      return noResult()
    }

    const source: ProviderSource = {
      kind: 'hls',
      url: ellenorzott.url,
      variant: 'sub',
      label: 'AnimeParadise',
      /*
       * Egyetlen master playlist, saját minőséglétrával — a rendition-lista
       * a manifesztben van, nem itt. Az `auto` az egyetlen őszinte válasz.
       */
      quality: 'auto',
      /** A hangsáv japán; a felirat nyelvét a `ProviderSubtitle` mondja meg. */
      language: 'ja'
      /*
       * FEJLÉC NINCS, ÉS EZ MÉRÉS.
       *
       * Az `anime-sdk` `Referer: https://animeparadise.moe/` fejlécet ad
       * vissza. A mérés szerint a manifeszt ÉS a szegmens is 200-at ad
       * fejléc nélkül, sőt a mi origónkkal is, és a CORS-válasz
       * `access-control-allow-origin: *`.
       *
       * Ez nem apróság: a böngészőből a `Referer` NEM állítható (tiltott
       * fejléc), tehát ha tényleg kellene, a lejátszás a böngészőben
       * elbukna — egy olyan fejléc mellett, ami a naplóban ott figyel.
       *
       * `expiresAt` SINCS: az API nem mond lejáratot, és nem találunk ki
       * egyet. A gyorsítótár a réteg alapértelmezett szabálya szerint megy.
       */
    }

    return {
      sources: [source],
      subtitles: subtitlesOf(detail?.subData, hosts)
    }
  }
}

/** Diagnosztika a naplóba — azonosítók és változatnevek, cím és fejléc SOHA. */
function diagnose (message: string): void {
  console.info(`[animeparadise] ${message}`)
}
