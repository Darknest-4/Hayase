import { noResult, type AnimeProvider, type EpisodeRef, type ProviderEpisode, type ProviderMatch, type ProviderResult, type SourceVariant } from '../types.ts'
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
function availableVariants(episode: AnikotoEpisode): SourceVariant[] {
  const embed = episode.embed_url
  if (!embed || typeof embed !== 'object') return []
  const out: SourceVariant[] = []
  for (const variant of ['sub', 'dub'] as const) {
    if (asString((embed as Record<string, unknown>)[variant])) out.push(variant)
  }
  return out
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

export const anikotoProvider: AnimeProvider = {
  id: 'anikoto',
  label: 'Anikoto',
  defaultPriority: 700,
  async search(
    query: string,
    hint?: { anilistId?: number | null; year?: number | null }
  ): Promise<ProviderMatch[]> {
    const config: Config = {}
    const perPage = 50
    const payload = await requestJson<unknown>(
      apiUrl(config, `/recent-anime?page=1&per_page=${perPage}`),
      8000
    )

    const anime = unwrapAnimeList(payload)
    const wanted = normalizeTitle(query)

    /*
     * PONTOZÁS, NEM SZŰRÉS.
     *
     * A régi változat egyetlen `filter`-rel döntött, és a sorrenddel nem
     * foglalkozott — így egy részleges egyezés megelőzhette a pontosat, a
     * hívó pedig az első elemet veszi. A pontszám rendezi is őket.
     *
     * A JELEK SÚLYA:
     *   AniList-azonosító  a legerősebb — ez az egyetlen, ami két hasonló
     *                      című évadot biztosan szétválaszt;
     *   pontos cím         erős;
     *   részleges cím      gyenge, de elég a megtaláláshoz;
     *   évszám             CSAK KIEGÉSZÍTŐ. Sosem zár ki: a katalógusok
     *                      évszáma gyakran a premier és nem a gyártás éve,
     *                      és egy téves év nem érhet annyit, hogy elvegye a
     *                      jó találatot.
     */
    const scored: Array<{ match: ProviderMatch, score: number }> = []

    for (const item of anime) {
      const id = asId(item.id)
      if (!id) continue

      const title = titleOf(item)
      const anilistId = asNumber(item.ani_id ?? item.anilist_id)

      let score = 0

      if (hint?.anilistId != null && anilistId != null && anilistId === hint.anilistId) {
        score += 100
      }

      for (const jelolt of titleCandidates(item)) {
        const normalized = normalizeTitle(jelolt)
        if (!normalized) continue
        if (normalized === wanted) { score = Math.max(score, score + 50); break }
        if (normalized.includes(wanted) || wanted.includes(normalized)) score = Math.max(score, score + 20)
      }

      // Kiegészítő jel — hozzáad, de önmagában sosem elég, és nem is vesz el.
      if (hint?.year != null && asNumber(item.year) === hint.year && score > 0) score += 5

      if (score === 0) continue

      scored.push({
        score,
        match: {
          id,
          title: title ?? '',
          anilistId,
          year: asNumber(item.year),
          episodeCount: asNumber(item.episodes)
        }
      })
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.match)
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
    const searchPages = Math.min(Math.max(config.searchPages ?? 1, 1), 3)
    const wanted = normalizeTitle(ref.title)
    const candidates: AnikotoAnime[] = []
    for (let page = 1; page <= searchPages; page++) {
      const payload = await requestJson<unknown>(
        apiUrl(config, `/recent-anime?page=${page}&per_page=${perPage}`),
        timeoutMs
      )
      candidates.push(...unwrapAnimeList(payload))
    }
    const ranked = candidates
      .filter(item => titleOf(item))
      .map(item => ({
        item,
        score: matchScore(item, ref, {
          anilistId: ref.anilistId,
          ...(ref.year !== undefined ? { year: ref.year } : {})
        })
      }))
      .sort((a, b) => b.score - a.score)
    const best = ranked[0]
    if (!best || best.score <= 0) {
      return noResult()
    }
    /*
     * `asId`, NEM `asString`. A katalógus `id` mezője SZÁM (`8717`), és az
     * `asString()` arra `null`-t ad — vagyis ez az ág eddig MINDIG itt lépett
     * ki, még a sorozat lekérése előtt. Ugyanaz a hiba, ami a `search()`-öt
     * is megbuktatta.
     */
    const seriesId = asId(best.item.id)
    if (!seriesId) return noResult()

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
     * ITT ÁLL MEG, ÉS EZ NEM HIÁNYOSSÁG, HANEM A HELYES VÁLASZ.
     *
     * A szolgáltató API-ja — a saját dokumentációja szerint is — KÉT
     * végpontot ismer (`/recent-anime`, `/series/{id}`), és egyik sem ad
     * közvetlenül lejátszható címet: az `embed_url.sub` és `embed_url.dub`
     * egy HARMADIK FÉL beágyazó LAPJÁRA mutat, nem `.m3u8`/`.mpd`/`.mp4`
     * fájlra.
     *
     * Egy beágyazó lap címét `kind: 'mp4'`-ként visszaadni azt jelentené,
     * hogy a lejátszó egy HTML-lapot próbál videóként dekódolni: néma fekete
     * doboz, és a naplóban „sikeres feloldás". A stream kinyerése a
     * beágyazásból viszont a harmadik fél védelmének megkerülése lenne —
     * azt nem csináljuk.
     *
     * Az üres eredmény a szerződés szerint SIKER („megkérdeztem, és nincs
     * mit adnom"), tehát a megszakítót sem nyitja ki, és a lánc szabályosan
     * továbblép a következő szolgáltatóra.
     */
    diagnose(
      `a(z) ${seriesId}/${ref.number}. részhez csak beágyazó cím van ` +
      `(${elerheto.join(', ')}) — az nem lejátszható forrás, ezért üres eredmény`
    )
    return noResult()
  }
}
