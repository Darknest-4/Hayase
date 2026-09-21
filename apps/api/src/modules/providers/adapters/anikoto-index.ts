/**
 * Az Anikoto katalógusának indexe.
 *
 * MIÉRT KELL. A szolgáltató API-jának NINCS kereső végpontja — ezt megmértük:
 * a `/search`, `/anime?q=`, `/series?q=` mind 404, a `/recent-anime`-on pedig
 * a `q`, `search`, `keyword` és `title` paramétert a kiszolgáló FIGYELMEN
 * KÍVÜL HAGYJA (szűretlen alaplapot ad vissza). Egyetlen dolgot tud: lapozni.
 *
 * Az adapter eddig EGY lapot kért le, és abban keresett. Ez a legfrissebb
 * ötven címre működött, minden másra üres eredményt adott — a nézőnek pedig
 * ez „ezt a részt egyik forrásból sem sikerült lejátszani"-ként jelent meg,
 * miközben a cím ott volt a katalógusban, csak a huszadik lapon.
 *
 * MÉRVE (2026-09-21): 180 lap, 8958 tétel, teljes bejárás nyolc párhuzamos
 * kéréssel 1,6 másodperc. Ezért az index nem optimalizálás, hanem a
 * működés feltétele — és elég olcsó ahhoz, hogy óránként újraépüljön.
 *
 * AMIT AZ INDEX TUD, ÉS A CÍMKERESÉS NEM: a tételek `ani_id` és `mal_id`
 * mezőt hordoznak (4802, illetve 8810 egyedi érték a 8958-ból). Egy
 * azonosító-egyezés biztosan szétválasztja az azonos című évadokat, amire a
 * cím önmagában sosem képes.
 */

/** Egy katalógustétel, a párosításhoz szükséges mezőkre szűkítve. */
export interface IndexEntry {
  id: string
  title: string
  titles: string[]
  anilistId: number | null
  malId: number | null
  year: number | null
  episodeCount: number | null
}

export interface CatalogueIndex {
  byAnilist: Map<number, IndexEntry[]>
  byMal: Map<number, IndexEntry[]>
  byTitle: Map<string, IndexEntry[]>
  all: IndexEntry[]
  builtAt: number
}

/** Meddig jó egy index. Egy óra: a katalógus naponta bővül, nem percenként. */
export const TTL_MS = 60 * 60_000

/**
 * Hány lapot kérünk egyszerre.
 *
 * Nyolc — mérve ennyivel 1,6 másodperc az egész. Nem azért ennyi, mert
 * gyorsabb nem lehetne, hanem mert egy idegen kiszolgálót nem illik
 * korlátlan párhuzamossággal elárasztani egy gyorsítótár feltöltéséért.
 */
export const CONCURRENCY = 8

/**
 * Felső korlát a lapokra.
 *
 * Ha a kiszolgáló egyszer sosem adna üres lapot (hiba, végtelen lapozás), ez
 * állítja meg a bejárást. 400 lap a mai méret kétszerese fölött van.
 */
export const MAX_PAGES = 400

export const PER_PAGE = 50

export function normalizeTitle (value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function asString (value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asId (value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return asString(value)
}

function asNumber (value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Minden cím, amit egy rekord hordoz — a `titles` blokkot is szétbontva. */
function titlesOf (item: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['title_english', 'title_romaji', 'title', 'alternative', 'native']) {
    const t = asString(item[key])
    if (t) out.push(t)
  }
  const blokk = asString(item.titles)
  if (blokk) {
    for (const darab of blokk.split(/[;,]/)) {
      const t = darab.trim()
      if (t) out.push(t)
    }
  }
  return out
}

function toEntry (item: Record<string, unknown>): IndexEntry | null {
  const id = asId(item.id)
  if (!id) return null
  const titles = titlesOf(item)
  return {
    id,
    title: titles[0] ?? '',
    titles,
    anilistId: asNumber(item.ani_id ?? item.anilist_id),
    malId: asNumber(item.mal_id),
    year: asNumber(item.year),
    episodeCount: asNumber(item.episodes)
  }
}

function push<K> (map: Map<K, IndexEntry[]>, key: K, entry: IndexEntry): void {
  const lista = map.get(key)
  if (lista) lista.push(entry)
  else map.set(key, [entry])
}

export function buildIndex (items: Array<Record<string, unknown>>): CatalogueIndex {
  const index: CatalogueIndex = {
    byAnilist: new Map(),
    byMal: new Map(),
    byTitle: new Map(),
    all: [],
    builtAt: Date.now()
  }
  for (const item of items) {
    const entry = toEntry(item)
    if (!entry) continue
    index.all.push(entry)
    if (entry.anilistId != null) push(index.byAnilist, entry.anilistId, entry)
    if (entry.malId != null) push(index.byMal, entry.malId, entry)
    for (const cim of entry.titles) {
      const n = normalizeTitle(cim)
      if (n) push(index.byTitle, n, entry)
    }
  }
  return index
}

/** Egy lap lekérése. A hívó adja a kérőt, hogy a modul tesztelhető legyen. */
export type PageFetcher = (page: number, perPage: number) => Promise<unknown>

function unwrapList (payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>
  const data = (payload as { data?: unknown })?.data
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>
  return []
}

/**
 * A teljes katalógus bejárása.
 *
 * KORLÁTOZOTT PÁRHUZAMOSSÁGGAL, és a végét az üres lap jelzi. Egy köteg
 * bármelyik lapja hibázhat: a hiba NEM szakítja meg a bejárást, mert egy
 * hiányzó lap rosszabb, mint egy hiányos index — de nem annyival rosszabb,
 * hogy az egészet eldobjuk érte.
 */
export async function crawl (fetchPage: PageFetcher, options: {
  concurrency?: number
  maxPages?: number
  perPage?: number
} = {}): Promise<Array<Record<string, unknown>>> {
  const concurrency = options.concurrency ?? CONCURRENCY
  const maxPages = options.maxPages ?? MAX_PAGES
  const perPage = options.perPage ?? PER_PAGE

  const items: Array<Record<string, unknown>> = []
  let page = 1
  let vege = false

  while (!vege && page <= maxPages) {
    const koteg: number[] = []
    for (let i = 0; i < concurrency && page + i <= maxPages; i++) koteg.push(page + i)
    page += koteg.length

    const eredmenyek = await Promise.all(koteg.map(async p => {
      try {
        return unwrapList(await fetchPage(p, perPage))
      } catch {
        // Egy elveszett lap nem dönti össze az indexet; a következő
        // újraépítés úgyis megpróbálja megint.
        return null
      }
    }))

    for (const lista of eredmenyek) {
      if (lista === null) continue
      if (lista.length === 0) { vege = true; continue }
      items.push(...lista)
    }
  }

  return items
}

// ---------------------------------------------------------------- tárolás

let cache: CatalogueIndex | null = null
let inFlight: Promise<CatalogueIndex> | null = null

/** Teszthez és újratöltéshez. */
export function clearIndex (): void {
  cache = null
  inFlight = null
}

/** A jelenlegi index, ha van és friss. Nem épít újat. */
export function peekIndex (): CatalogueIndex | null {
  if (!cache) return null
  return Date.now() - cache.builtAt < TTL_MS ? cache : null
}

/**
 * Az index — épít, ha kell.
 *
 * EGYSZERRE EGY ÉPÍTÉS FUT. Enélkül tíz egyidejű kérés tízszer járná be a
 * teljes katalógust: ezerhatszáz HTTP-kérés egyetlen epizód lejátszásáért.
 */
export async function getIndex (fetchPage: PageFetcher, options?: {
  concurrency?: number
  maxPages?: number
  perPage?: number
}): Promise<CatalogueIndex> {
  const friss = peekIndex()
  if (friss) return friss
  if (inFlight) return await inFlight

  inFlight = (async () => {
    try {
      const items = await crawl(fetchPage, options ?? {})
      // ÜRES BEJÁRÁST NEM TÁROLUNK. Ha a kiszolgáló épp nem elérhető, egy
      // üres index egy órára kizárná az egész szolgáltatót.
      if (!items.length) {
        if (cache) return cache
        return buildIndex([])
      }
      cache = buildIndex(items)
      return cache
    } finally {
      inFlight = null
    }
  })()

  return await inFlight
}
