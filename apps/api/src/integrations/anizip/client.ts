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

export interface AniZipRecord {
  titles?: Record<string, string>
  images?: AniZipImage[]
  mappings?: AniZipMappings
  episodeCount?: number
}

const BASE = process.env.ANIZIP_URL ?? 'https://api.ani.zip'

/**
 * One title, or null when ani.zip has nothing for it.
 *
 * Null rather than throwing for a 404: a catalogue of thirty thousand contains
 * plenty of obscure entries nobody has mapped, and a pass that stops on the
 * first of them is a pass that never finishes.
 */
export async function fetchMapping (anilistId: number, signal?: AbortSignal): Promise<AniZipRecord | null> {
  let res: Response
  try {
    res = await fetch(`${BASE}/mappings?anilist_id=${anilistId}`, {
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {})
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  try {
    return await res.json() as AniZipRecord
  } catch {
    return null
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
