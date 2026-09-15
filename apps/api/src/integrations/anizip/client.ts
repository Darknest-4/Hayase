// ani.zip — the mapping and artwork service, keyed by AniList id.
//
// Why this and not TheTVDB directly: TheTVDB needs an API key, and more
// awkwardly it needs a TheTVDB id to ask with. `anime_mappings.tvdb_id` is
// NULL in all 32 390 rows, so that route begins with an identity problem
// rather than an artwork one. ani.zip answers both from one free, keyless
// request — and the artwork it returns is TheTVDB's, served from
// artworks.thetvdb.com.
//
// Measured: ~53ms per request sequentially, ~14ms at five in flight. The 22 418
// titles holding an AniList id are therefore about five minutes of wall clock,
// which is why this is worth doing as a pass rather than lazily per page view.

export interface AniZipImage { coverType?: string, url?: string }

export interface AniZipMappings {
  thetvdb_id?: number | null
  themoviedb_id?: number | string | null
  imdb_id?: string | null
  anidb_id?: number | null
  kitsu_id?: number | null
  mal_id?: number | null
  anilist_id?: number | null
}

/** Egy epizód, ahogy ani.zip küldi. A kulcs a lekérdezésben az epizódszám. */
export interface AniZipEpisode {
  title?: Record<string, string>
  overview?: string | null
  summary?: string | null
  image?: string | null
  runtime?: number | null
  length?: number | null
  airDate?: string | null
  tvdbId?: number | null
  anidbEid?: number | null
  episodeNumber?: number | null
  absoluteEpisodeNumber?: number | null
}

export interface AniZipRecord {
  titles?: Record<string, string>
  images?: AniZipImage[]
  mappings?: AniZipMappings
  episodes?: Record<string, AniZipEpisode>
  episodeCount?: number
}

const BASE = process.env.ANIZIP_URL ?? 'https://api.ani.zip'

/** Miért nem jött adat. A kettő nem ugyanaz, és eddig az volt. */
export type FetchOutcome =
  | { kind: 'ok', record: AniZipRecord }
  /** A szolgáltatás válaszolt, és nincs erről a címről semmije. */
  | { kind: 'absent' }
  /** Fojtás vagy hiba: van adat, csak most nem adják ide. */
  | { kind: 'refused', status: number }

/**
 * Egy cím.
 *
 * A 404 és a 429 **nem** ugyanaz, pedig korábban mindkettő `null` lett. Egy
 * 32 000 soros katalógusban bőven van olyan, amit soha senki nem képezett le
 * — az „absent", és nem baj. A 429 viszont azt jelenti, hogy túl gyorsan
 * kérdezünk, és ha azt is hiányzó adatnak vesszük, a futás sikert jelent
 * miközben elveszti a munkája nagy részét. Pontosan ez történt: 20 510
 * címből 18 152 „hiányzott" három perc alatt.
 */
export async function fetchMapping (anilistId: number, signal?: AbortSignal): Promise<FetchOutcome> {
  let res: Response
  try {
    res = await fetch(`${BASE}/mappings?anilist_id=${anilistId}`, {
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {})
    })
  } catch {
    // Hálózati hiba: nem tudjuk, van-e adat. Elutasításnak vesszük, mert a
    // biztonságosabb feltételezés az, hogy még jöhetne.
    return { kind: 'refused', status: 0 }
  }
  if (res.status === 404) return { kind: 'absent' }
  if (!res.ok) return { kind: 'refused', status: res.status }
  try {
    return { kind: 'ok', record: await res.json() as AniZipRecord }
  } catch {
    return { kind: 'absent' }
  }
}

/**
 * ani.zip's cover types, mapped onto the kinds `anime_images.kind` accepts.
 *
 * `Fanart` is wide key art, not a still from an episode, so it is `backdrop`
 * rather than `screenshot` — see migration 0043. `Clearlogo` is the
 * transparent wordmark, which the catalogue has none of and which is what a
 * banner card wants written across it.
 */
export const IMAGE_KIND: Record<string, string> = {
  Poster: 'cover',
  Banner: 'banner',
  Fanart: 'backdrop',
  Clearlogo: 'logo'
}

/** An absolute http(s) URL, or null. Guards against a relative or junk value. */
export function usableUrl (url: unknown): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : null
}

/** TheTVDB ids arrive as numbers; TMDB's sometimes as a string. */
export function asId (value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value)
    return n > 0 ? n : null
  }
  return null
}
