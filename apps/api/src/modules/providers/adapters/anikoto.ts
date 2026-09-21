import { noResult, type AnimeProvider, type EpisodeRef, type ProviderEpisode, type ProviderMatch, type ProviderResult, type ProviderSource, type SourceVariant } from '../types.ts'
import { checkEmbedUrl } from '../embed-url.ts'
import { buildIndex, getIndex, peekIndex, type CatalogueIndex, type IndexEntry } from './anikoto-index.ts'
/*
 * A katalógus rekordja — az ÉLŐ válasz alapján, nem feltételezésből.
 *
 * Mérve a `/recent-anime`-on: `id` SZÁM, `ani_id` SZTRING, `episodes` SZTRING,
 * `year` SZÁM. A `title_english` és a `title_romaji` ezen a végponton NINCS
 * — helyettük `title`, `alternative`, `native` és egy `titles` nevű,
 * pontosvesszőkkel összefűzött blokk van.
 */
interface AnikotoAnime {
  id?: unknown
  title?: unknown
  title_english?: unknown
  title_romaji?: unknown
  alternative?: unknown
  native?: unknown
  titles?: unknown
  year?: unknown
  anilist_id?: unknown
  ani_id?: unknown
  mal_id?: unknown
  episodes?: unknown
}
interface AnikotoEpisode {
  /** A szolgáltató saját sorazonosítója (szám). */
  id?: unknown
  number?: unknown
  title?: unknown
  /** A stabil azonosító, amire a szolgáltató a beágyazást fűzi (sztring). */
  episode_embed_id?: unknown
  /*
   * BEÁGYAZÓ CÍM, NEM FORRÁS. Egy iframe-lap címe, nem HLS/DASH/MP4 — a
   * `resolve()` szándékosan nem csinál belőle `ProviderSource`-t.
   */
  embed_url?: {
    sub?: unknown
    dub?: unknown
  }
}
interface AnikotoSeries {
  id?: unknown
  title?: unknown
  episodes?: unknown
}
interface AnikotoSeriesResponse {
  anime?: AnikotoAnime
  episodes?: unknown
}
interface Config {
  apiBaseUrl?: string
  timeoutMs?: number
  searchPages?: number
  perPage?: number
  /**
   * Mely gazdagépek beágyazását fogadjuk el.
   *
   * BEÁLLÍTÁS, NEM KÓDBA ÉGETETT LISTA. A szolgáltató API-ja nem hirdeti
   * meg, melyik lejátszót fogja használni — ma a `megaplay.buzz`-ra mutat,
   * és ezt MÉRTÜK, nem feltételeztük. Ha holnap másikra vált, egy
   * beállítás igazítja, nem egy kiadás.
   *
   * Az alapérték a ma ténylegesen visszaadott gazdagép. Üres lista esetén
   * egyetlen beágyazás sem megy át — a szigorúbb irány a biztonságos.
   */
  embedHosts?: readonly string[]
  /** Hány lapot kérünk egyszerre az index építésekor. */
  indexConcurrency?: number
  /** Felső korlát a bejárt lapokra — a végtelen lapozás ellen. */
  indexMaxPages?: number
  /** Meddig várhat egy kérés a hideg index felépülésére. */
  indexBudgetMs?: number
}

/**
 * A mai gazdagép, MÉRVE (2026-09-21, `/series/8717`):
 *   `https://megaplay.buzz/stream/s-2/169846/sub`
 *
 * Nem vakon beírt érték: a `Config.embedHosts` és a
 * `YUME_ANIKOTO_EMBED_HOSTS` környezeti változó egyaránt felülírja.
 */
const ALAP_EMBED_HOSTOK: readonly string[] = ['megaplay.buzz']

function embedHosts (config: Config): readonly string[] {
  if (config.embedHosts) return config.embedHosts
  const kornyezet = process.env.YUME_ANIKOTO_EMBED_HOSTS
  if (kornyezet && kornyezet.trim() !== '') {
    return kornyezet.split(',').map(x => x.trim()).filter(Boolean)
  }
  return ALAP_EMBED_HOSTOK
}
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}
/**
 * Azonosító sztringgé — SZÁMBÓL IS.
 *
 * EZ VOLT A HIBA. A katalógus `id` mezője szám (`8717`), az `asString()`
 * viszont csak sztringet fogad el, tehát `null`-t adott — a `search()` pedig
 * a záró `.filter(item => item.id.length > 0)` sorában kidobta a találatot.
 * Így a Liar Game benne volt az ötven elemű válaszban, és mégis üres lista
 * jött vissza.
 *
 * A `ProviderMatch.id` a szerződés szerint sztring, és a szolgáltatóé — a
 * YUME nem értelmezi, csak visszaadja. Ezért a szám elfogadása nem
 * engedékenység, hanem a helyes olvasat.
 */
function asId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return asString(value)
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}
function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
/**
 * MINDEN CÍM, AMIT A REKORD HORDOZ.
 *
 * A `/recent-anime` végponton nincs `title_english`/`title_romaji`; van
 * viszont `alternative`, `native`, és egy `titles` nevű blokk, amiben
 * pontosvesszővel és vesszővel elválasztva állnak a változatok. Ha csak a
 * `title`-t néznénk, egy másik nyelvű keresés nem találna rá — pedig a válasz
 * tartalmazza.
 */
function titleCandidates(anime: AnikotoAnime): string[] {
  const out: string[] = []
  for (const value of [anime.title_english, anime.title_romaji, anime.title, anime.alternative, anime.native]) {
    const t = asString(value)
    if (t) out.push(t)
  }
  const blokk = asString(anime.titles)
  if (blokk) {
    for (const darab of blokk.split(/[;,]/)) {
      const t = darab.trim()
      if (t) out.push(t)
    }
  }
  return out
}

function titleOf(anime: AnikotoAnime): string | null {
  return (
    asString(anime.title_english) ??
    asString(anime.title_romaji) ??
    asString(anime.title)
  )
}
function apiUrl(config: Config, path: string): string {
  const base = (config.apiBaseUrl ?? 'https://anikotoapi.site').replace(/\/+$/, '')
  return `${base}${path}`
}
/**
 * Egy kérés a szolgáltatóhoz.
 *
 * A 404 `null`-t ad vissza, MINDEN MÁS HIBA DOB — és ez a különbség nem
 * stílus, hanem a szerződés lényege:
 *
 *   `null` / üres eredmény  „megkérdeztem, és nincs ilyen rekord";
 *   kivétel                 „nem tudtam megkérdezni".
 *
 * Ezen múlik, hogy a körkörös megszakító kinyisson-e. Amíg a 404 is kivétel
 * volt, egy ismeretlen sorozatazonosító SZOLGÁLTATÓI HIBÁNAK számított — és
 * három ilyen után a megszakító kizárta az egész providert a láncból. Vagyis
 * elég volt három elgépelt vagy régi azonosító ahhoz, hogy a szolgáltató
 * percekre eltűnjön, pedig végig kifogástalanul működött.
 *
 * A 429 és az 5xx MARAD kivétel: azok valóban azt jelentik, hogy nem tudtuk
 * megkérdezni, és épp azokra való a megszakító.
 */
async function requestJson<T>(
  url: string,
  timeoutMs: number
): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'YUME-Provider/1.0'
      },
      signal: controller.signal
    })
    // NINCS ILYEN REKORD — nem hiba. A hívók `unwrapAnimeList`/`unwrapSeries`
    // útján dolgozzák fel, és mindkettő üres eredményt ad a `null`-ra.
    if (response.status === 404) {
      return null
    }
    if (response.status === 429) {
      throw new Error('Anikoto API rate limit reached (429)')
    }
    if (!response.ok) {
      throw new Error(`Anikoto API returned HTTP ${response.status}`)
    }
    return await response.json() as T
  } finally {
    clearTimeout(timer)
  }
}
function unwrapAnimeList(payload: unknown): AnikotoAnime[] {
  if (Array.isArray(payload)) return payload as AnikotoAnime[]
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>
    for (const key of ['anime', 'animes', 'results', 'data']) {
      if (Array.isArray(value[key])) {
        return value[key] as AnikotoAnime[]
      }
    }
  }
  return []
}
function unwrapSeries(payload: unknown): AnikotoSeriesResponse {
  if (!payload || typeof payload !== 'object') {
    return {}
  }
  const value = payload as Record<string, unknown>
  if (value.data && typeof value.data === 'object') {
    return value.data as AnikotoSeriesResponse
  }
  return value as AnikotoSeriesResponse
}
function unwrapEpisodes(series: AnikotoSeriesResponse): AnikotoEpisode[] {
  return Array.isArray(series.episodes)
    ? series.episodes as AnikotoEpisode[]
    : []
}
function matchScore(
  anime: AnikotoAnime,
  ref: EpisodeRef,
  hint?: { anilistId?: number | null; year?: number | null }
): number {
  let score = 0
  const anilistId = asNumber(anime.ani_id ?? anime.anilist_id)
  if (hint?.anilistId != null && anilistId === hint.anilistId) {
    score += 1000
  }
  const title = titleOf(anime)
  if (title) {
    const wanted = normalizeTitle(ref.title)
    const candidate = normalizeTitle(title)
    if (candidate === wanted) score += 500
    else if (candidate.includes(wanted) || wanted.includes(candidate)) score += 100
  }
  const year = asNumber(anime.year)
  if (ref.year != null && year === ref.year) score += 50
  if (hint?.year != null && year === hint.year) score += 25
  return score
}
/**
 * Melyik változathoz van egyáltalán beágyazás ennél a résznél.
 *
 * Nem azt mondja meg, hogy LEJÁTSZHATÓ — azt, hogy a szolgáltató szerint
 * létezik. A kettő különbsége a `resolve()` végén dől el.
 */
/**
 * A BEÁGYAZHATÓ VÁLTOZATOK ZÁRT HALMAZA: `sub` és `dub`.
 *
 * Szűkebb, mint a `SourceVariant`, és ez szándékos. Az `embed_url`-nek nincs
 * `raw` kulcsa, tehát ha ez `SourceVariant`-ot adna vissza, a fordító
 * kénytelen lenne elhinni, hogy a `raw` is kiolvasható belőle — és a hiba
 * futásidőben, `undefined` címként bukna ki.
 */
type EmbedVariant = 'sub' | 'dub'

function availableVariants(episode: AnikotoEpisode): EmbedVariant[] {
  const embed = episode.embed_url
  if (!embed || typeof embed !== 'object') return []
  const out: EmbedVariant[] = []
  for (const variant of ['sub', 'dub'] as const) {
    if (asString(embed[variant])) out.push(variant)
  }
  return out
}

/**
 * Lapkérő az indexnek. Ugyanazt az utat használja, mint a többi hívás.
 */
function pageFetcher (config: Config, timeoutMs: number) {
  return async (page: number, perPage: number): Promise<unknown> =>
    await requestJson<unknown>(
      apiUrl(config, `/recent-anime?page=${page}&per_page=${perPage}`),
      timeoutMs
    )
}

/**
 * A katalógusindex — de csak addig várunk rá, ameddig szabad.
 *
 * A HIDEG INDULÁS A KOCKÁZAT. Az első kérés még építi az indexet (mérve 1,6
 * másodperc), de ha a szolgáltató épp lassú, az építés elvihetné az egész
 * időkeretet, és a feloldás időtúllépéssel bukna — ami a megszakítót is
 * kinyitná, pedig a szolgáltatóval semmi baj.
 *
 * Ezért a várakozás KORLÁTOS. Ha az index nem készül el időben, ez a kérés
 * index nélkül megy tovább (az első lapra szűkülve), az építés viszont fut
 * tovább a háttérben — a következő kérés már a teljes katalógust látja.
 */
async function indexWithin (config: Config, timeoutMs: number, budgetMs: number): Promise<CatalogueIndex | null> {
  const kesz = peekIndex()
  if (kesz) return kesz

  const epul = getIndex(pageFetcher(config, timeoutMs), {
    ...(config.indexConcurrency !== undefined ? { concurrency: config.indexConcurrency } : {}),
    ...(config.indexMaxPages !== undefined ? { maxPages: config.indexMaxPages } : {})
  })
  // A háttérben futó építés hibáját itt nyeljük el: a hívó az index
  // hiányát látja, nem egy kivételt.
  epul.catch(() => {})

  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      epul,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), budgetMs) })
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A legjobb katalógustétel egy kereséshez.
 *
 * A JELEK SÚLYA — azonosító, cím, évszám, ebben a sorrendben. Az azonosító a
 * legerősebb, mert ez az EGYETLEN, ami két azonos című évadot biztosan
 * szétválaszt; az évszám csak kiegészítő, és sosem zár ki: a katalógusok
 * évszáma gyakran a premier és nem a gyártás éve.
 */
function scoreEntry (
  entry: IndexEntry,
  wanted: string,
  hint: { anilistId?: number | null, malId?: number | null, year?: number | null }
): number {
  let score = 0
  if (hint.anilistId != null && entry.anilistId != null && entry.anilistId === hint.anilistId) score += 100
  if (hint.malId != null && entry.malId != null && entry.malId === hint.malId) score += 90

  if (wanted) {
    for (const cim of entry.titles) {
      const n = normalizeTitle(cim)
      if (!n) continue
      if (n === wanted) { score += 50; break }
      if (n.includes(wanted) || wanted.includes(n)) { score += 20; break }
    }
  }

  if (hint.year != null && entry.year === hint.year && score > 0) score += 5
  return score
}

/**
 * Keresés az indexben.
 *
 * A JELÖLTEK KÖRE SZŰKÍTETT, nem a teljes katalógus: az azonosító- és
 * címkulcsok szerint kiszedett tételeket pontozzuk. Enélkül minden kérés
 * végigpontozná mind a nyolcezret — működne, de fölöslegesen.
 */
function searchIndex (
  index: CatalogueIndex,
  query: string,
  hint: { anilistId?: number | null, malId?: number | null, year?: number | null }
): IndexEntry[] {
  const wanted = normalizeTitle(query)
  const jeloltek = new Set<IndexEntry>()

  if (hint.anilistId != null) for (const e of index.byAnilist.get(hint.anilistId) ?? []) jeloltek.add(e)
  if (hint.malId != null) for (const e of index.byMal.get(hint.malId) ?? []) jeloltek.add(e)
  if (wanted) {
    for (const e of index.byTitle.get(wanted) ?? []) jeloltek.add(e)
    /*
     * RÉSZLEGES CÍMEGYEZÉS. A kulcs szerinti keresés csak a pontos címet
     * találja meg; egy „Attack on Titan" kérés nem találná meg az „Attack on
     * Titan Season 2"-t. Ez a menet végigmegy a címkulcsokon — nyolcezer
     * rövid sztring, ezredmásodperc nagyságrend.
     */
    for (const [kulcs, lista] of index.byTitle) {
      if (kulcs.includes(wanted) || wanted.includes(kulcs)) {
        for (const e of lista) jeloltek.add(e)
      }
    }
  }

  return [...jeloltek]
    .map(entry => ({ entry, score: scoreEntry(entry, wanted, hint) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .map(x => x.entry)
}

/** Katalógustétel → a szerződés szerinti találat. */
function toMatch (entry: IndexEntry): ProviderMatch {
  return {
    id: entry.id,
    title: entry.title,
    anilistId: entry.anilistId,
    year: entry.year,
    episodeCount: entry.episodeCount
  }
}

/** Egy lapnyi nyers tételből index — az építés alatti sekély útnak. */
function buildIndexFromItems (items: AnikotoAnime[]): CatalogueIndex {
  return buildIndex(items as Array<Record<string, unknown>>)
}

/**
 * Diagnosztika — a naplóba, nem a nézőnek.
 *
 * A „nincs forrás" válasz leggyakoribb kérdése az, hogy MIÉRT, és arra egy
 * üres tömb nem felelet. Ez a sor mondja meg, meddig jutottunk: megvolt-e a
 * sorozat, megvolt-e a rész, és mi hiányzott.
 *
 * SOHA nem tartalmaz címet vagy fejlécet — csak azonosítót és változatnevet.
 */
function diagnose(message: string): void {
  console.info(`[anikoto] ${message}`)
}

/**
 * A katalógusindex felépítése ELŐRE, a háttérben.
 *
 * MIÉRT NEM ELÉG A LUSTA ÉPÍTÉS. Az első kérés elindítja az építést, de csak
 * korlátozott ideig vár rá — így az újraindítás utáni ELSŐ néző a sekély
 * úton megy, és egy régebbi címre üres eredményt kap. Ez pontosan az a hiba,
 * amit javítunk, csak ritkábban.
 *
 * SZÁNDÉKOSAN NEM A `buildApp()`-BÓL HÍVJUK. Azt a tesztek is meghívják, és
 * egy tesztfuttatás nem indíthat el százhetven HTTP-kérést egy idegen
 * kiszolgáló felé. A hely a szerver belépési pontja: ott a folyamat
 * tényleg kiszolgálni indul.
 *
 * A hibát elnyeli: ha a szolgáltató épp nem elérhető, az indulás nem
 * bukhat el rajta — a lusta út úgyis megpróbálja majd újra.
 */
export function warmUpAnikoto (config: Config = {}): void {
  const timeoutMs = config.timeoutMs ?? 8000
  void getIndex(pageFetcher(config, timeoutMs), {
    ...(config.indexConcurrency !== undefined ? { concurrency: config.indexConcurrency } : {}),
    ...(config.indexMaxPages !== undefined ? { maxPages: config.indexMaxPages } : {})
  }).then(
    index => { diagnose(`katalógusindex kész: ${index.all.length} tétel`) },
    error => { diagnose(`a katalógusindex nem épült fel: ${String((error as Error)?.message ?? error)}`) }
  )
}

export const anikotoProvider: AnimeProvider = {
  id: 'anikoto',
  label: 'Anikoto',
  defaultPriority: 700,
  /*
   * ALAPBÓL KIKAPCSOLVA — mert ez az adapter minden feloldásnál IDEGEN
   * KISZOLGÁLÓT hív, és a katalógusindexhez 180 lapot kér le.
   *
   * Enélkül minden telepítés és minden TESZTFUTTATÁS azonnal forgalmat
   * küldene a szolgáltatónak, pusztán attól, hogy a kód frissült — mérve: a
   * teljes API-készlet élő kéréseket indított az anikotoapi.site felé.
   *
   * Az éles bekapcsolást a 0064-es áttérés végzi, kifejezett sorral.
   */
  defaultEnabled: false,
  async search(
    query: string,
    hint?: { anilistId?: number | null; malId?: number | null; year?: number | null }
  ): Promise<ProviderMatch[]> {
    const config: Config = {}
    /*
     * AZ EGÉSZ KATALÓGUSBAN KERESÜNK, NEM AZ ELSŐ LAPON.
     *
     * Itt korábban egyetlen `/recent-anime?page=1&per_page=50` hívás állt. Az
     * API-nak nincs kereső végpontja — ezt megmértük: a `/search` 404, a
     * `q`/`search`/`keyword`/`title` paramétert pedig a `/recent-anime`
     * figyelmen kívül hagyja. Egy lap tehát a legfrissebb ötven címet
     * jelentette, és MINDEN MÁSRA üres eredményt adott: a Shingeki no Kyojin
     * és a Kimetsu no Yaiba benne van a katalógusban, csak nem az első lapon.
     *
     * A nézőnek ez „ezt a részt egyik forrásból sem sikerült lejátszani"-ként
     * jelent meg — vagyis a hiba pont úgy nézett ki, mint egy hiányzó cím.
     */
    const index = await indexWithin(config, config.timeoutMs ?? 8000, config.indexBudgetMs ?? 6000)

    if (!index) {
      // Az index még épül. Ez a kérés a régi, sekély úton megy — jobb egy
      // szűkebb találat, mint egy elhasalt kérés.
      diagnose('a katalógusindex még épül — ez a keresés csak az első lapot látja')
      const payload = await requestJson<unknown>(
        apiUrl(config, `/recent-anime?page=1&per_page=50`),
        config.timeoutMs ?? 8000
      )
      const sekely = buildIndexFromItems(unwrapAnimeList(payload))
      return searchIndex(sekely, query, hint ?? {}).map(toMatch)
    }

    return searchIndex(index, query, hint ?? {}).map(toMatch)
  },
  async episodes(matchId: string): Promise<ProviderEpisode[]> {
    if (!matchId.trim()) return []

    const payload = await requestJson<unknown>(
      apiUrl({}, `/series/${encodeURIComponent(matchId)}`),
      8000
    )
    const series = unwrapSeries(payload)

    return unwrapEpisodes(series)
      .map((episode, index) => {
        const number = asNumber(episode.number)
        /*
         * AZ AZONOSÍTÓ A SZOLGÁLTATÓÉ, NEM A MIÉNK.
         *
         * A régi változat egy `${matchId}:${number}` alakú SAJÁT azonosítót
         * gyártott — abból viszont nem lehet visszatalálni a szolgáltató
         * rekordjára, és ha a számozás eltolódik (különkiadás, átsorszámozás),
         * két különböző epizód kaphatja ugyanazt.
         *
         * A válaszban két stabil azonosító is van: az `episode_embed_id`
         * (sztring) és az `id` (szám). Az elsőt vesszük, mert az a
         * szolgáltató saját, epizódra mutató kulcsa; a sorszám csak akkor
         * kerül elő, ha egyik sincs.
         */
        const id =
          asId(episode.episode_embed_id) ??
          asId(episode.id) ??
          `${matchId}:${number ?? index + 1}`

        return {
          id,
          number: number ?? index + 1,
          title: asString(episode.title)
        }
      })
      // A válasz sorrendje nem szerződés. A hívó a részszámra számít.
      .sort((a, b) => a.number - b.number)
  },
  async resolve(
    ref: EpisodeRef,
    configInput?: Record<string, unknown>
  ): Promise<ProviderResult> {
    const config = (configInput ?? {}) as Config
    const timeoutMs = config.timeoutMs ?? 8000
    const perPage = Math.min(Math.max(config.perPage ?? 50, 1), 50)
    /*
     * UGYANAZ AZ INDEX, MINT A `search()`-NÉL — és ez a lényeg.
     *
     * Itt korábban egy saját, egy-három lapos bejárás állt, külön
     * pontozással. Két baja volt: ugyanazt a hiányt hozta, mint a `search()`
     * (a katalógus 180 lapjából hármat látott), és külön kódúton — vagyis a
     * lejátszó és a keresés MÁS eredményt adhatott ugyanarra a címre.
     */
    const index = await indexWithin(config, timeoutMs, config.indexBudgetMs ?? 6000)

    let talalatok: IndexEntry[]
    if (index) {
      talalatok = searchIndex(index, ref.title, {
        anilistId: ref.anilistId,
        ...(ref.malId !== undefined ? { malId: ref.malId } : {}),
        ...(ref.year !== undefined ? { year: ref.year } : {})
      })
    } else {
      diagnose('a katalógusindex még épül — ez a feloldás csak az első lapot látja')
      const payload = await requestJson<unknown>(
        apiUrl(config, `/recent-anime?page=1&per_page=${perPage}`),
        timeoutMs
      )
      talalatok = searchIndex(buildIndexFromItems(unwrapAnimeList(payload)), ref.title, {
        anilistId: ref.anilistId,
        ...(ref.malId !== undefined ? { malId: ref.malId } : {}),
        ...(ref.year !== undefined ? { year: ref.year } : {})
      })
    }

    const best = talalatok[0]
    if (!best) {
      diagnose(`nincs katalógustalálat: „${ref.title}" (anilist=${ref.anilistId ?? '-'}, mal=${ref.malId ?? '-'})`)
      return noResult()
    }

    const seriesId = best.id

    const seriesPayload = await requestJson<unknown>(
      apiUrl(config, `/series/${encodeURIComponent(seriesId)}`),
      timeoutMs
    )
    const series = unwrapSeries(seriesPayload)
    const episode = unwrapEpisodes(series).find(
      item => asNumber(item.number) === ref.number
    )
    if (!episode) {
      diagnose(`nincs ilyen rész a(z) ${seriesId} sorozatnál: ${ref.number}.`)
      return noResult()
    }

    /*
     * A KÉRT VÁLTOZATOT NEM HELYETTESÍTJÜK MÁSIKKAL.
     *
     * Aki szinkronosat kért, annak a feliratos NEM jó válasz — rossz
     * hangsávval induló lejátszó lenne belőle, amit a naplóban semmi nem
     * jelez. A hiányzó változat helyes válasza az üres eredmény.
     *
     * `raw`: az Anikoto csak `sub`/`dub` beágyazást ad, tehát nyers sávot
     * nem tud kiszolgálni — ezt is üres eredmény jelenti, nem helyettesítés.
     */
    const elerheto = availableVariants(episode)
    const kert = ref.variant ?? null

    if (kert === 'raw') {
      diagnose(`a(z) ${seriesId}/${ref.number}. részhez nyers (raw) sáv nem érhető el — a szolgáltató csak sub/dub beágyazást ad`)
      return noResult()
    }
    if (kert !== null && !elerheto.includes(kert)) {
      diagnose(`a(z) ${seriesId}/${ref.number}. részhez a kért „${kert}" változat nincs meg (elérhető: ${elerheto.join(', ') || 'egy sem'})`)
      return noResult()
    }
    if (!elerheto.length) {
      diagnose(`a(z) ${seriesId}/${ref.number}. részhez egyetlen változat sincs`)
      return noResult()
    }

    /*
     * BEÁGYAZÁS, NEM FOLYAM — és a különbséget a `kind` mondja ki.
     *
     * A szolgáltató API-ja két végpontot ismer (`/recent-anime`,
     * `/series/{id}`), és egyik sem ad `.m3u8`/`.mpd`/`.mp4` címet: az
     * `embed_url` egy harmadik fél LEJÁTSZÓ LAPJÁRA mutat. Ezt a lapot
     * `iframe`-be tesszük, ahogy a szolgáltató szánta.
     *
     * A `kind: 'embed'` nem formalitás. Nélküle — bármelyik folyam-fajta
     * nevén — a lejátszó a `<video>`-ba töltené a HTML-lapot: néma fekete
     * doboz, a naplóban „sikeres feloldás" felirattal. A stream kinyerése a
     * lapból pedig a harmadik fél védelmének megkerülése lenne, azt nem
     * csináljuk: a cím marad beágyazó cím.
     *
     * A VÁLASZ NEM MEGBÍZHATÓ ADAT. Ami ide bekerül, az a felhasználó
     * lapján `iframe`-ben fut, ezért minden cím átmegy a `checkEmbedUrl`
     * határon — https, engedélyezett gazdagép, hitelesítő adat nélkül.
     */
    const hostok = embedHosts(config)
    const sources: ProviderSource[] = []

    for (const variant of elerheto) {
      // A kért változaton kívül semmit nem adunk vissza: ha a néző `dub`-ot
      // kért, egy `sub` forrás a listában csendben elindulhatna helyette.
      if (kert !== null && variant !== kert) continue

      const nyers = (episode.embed_url ?? {})[variant]
      const ellenorzes = checkEmbedUrl(nyers, hostok)
      if (!ellenorzes.url) {
        // A CÍMET NEM NAPLÓZZUK, csak az okot: egy elutasított cím
        // tetszőleges tartalom, és a napló nem a helye.
        diagnose(`a(z) ${seriesId}/${ref.number}. rész „${variant}" beágyazása elutasítva (${ellenorzes.reason})`)
        continue
      }

      sources.push({
        kind: 'embed',
        url: ellenorzes.url,
        variant,
        label: 'Anikoto',
        /*
         * A FELBONTÁS SZÁNDÉKOSAN `null`. Az idegen lejátszó dönti el,
         * milyen minőséget ad; egy kitalált `1080p` a forrásválasztóban
         * hazugság lenne, amit semmi nem vált be.
         */
        quality: null,
        language: variant === 'dub' ? 'en' : 'ja'
      })
    }

    if (!sources.length) {
      diagnose(`a(z) ${seriesId}/${ref.number}. részhez egyetlen beágyazás sem ment át az ellenőrzésen`)
      return noResult()
    }

    diagnose(`a(z) ${seriesId}/${ref.number}. részhez ${sources.length} beágyazás (${sources.map(s => s.variant).join(', ')})`)
    return { sources, subtitles: [] }
  }
}
