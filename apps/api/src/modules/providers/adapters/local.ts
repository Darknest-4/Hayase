// A SAJÁT forrásaink, szolgáltatóként.
//
// MIÉRT ADAPTER EGY SAJÁT TÁBLA. Mert enélkül a providerréteg egy üres váz
// lenne, amit csak egy külső szolgáltató bekötésekor lehetne először
// kipróbálni — vagyis a lánc, a gyorsítótár, a megszakító és a rangsor
// mind bizonyítatlan maradna. Így viszont a rendszer MA is működik, és
// pontosan azt az utat járja, amit egy holnap bekötött adapter fog.
//
// És van egy másik haszna is: a saját, feltöltött tartalom így ugyanolyan
// elsőosztályú forrás, mint bármi más — nem egy külön ág a kódban, hanem egy
// szolgáltató, aminek magas a prioritása.
//
// A `defaultPriority` 10, tehát a láncban ELÖL áll: ha valami a mi
// tárolónkban van, azt adjuk, nem egy idegen kiszolgálót.

import { query } from '../../../infrastructure/database/index.ts'
import { noResult } from '../types.ts'

import type {
  AnimeProvider, EpisodeRef, ProviderEpisode, ProviderMatch, ProviderResult,
  ProviderSource, ProviderSubtitle, SourceKind, SourceVariant
} from '../types.ts'

/**
 * A tárolt `kind` a szállítási formára fordítva.
 *
 * A tábla `kind`-ja tágabb fogalom (`http`, `torrent`, `magnet`); a lejátszót
 * viszont csak az érdekli, melyik motort indítsa. Amit nem tud lejátszani,
 * azt ki is hagyjuk — egy torrent-hivatkozás a böngészőben nem forrás.
 */
function transportOf (kind: string, ref: string): SourceKind | null {
  if (kind === 'hls' || /\.m3u8(\?|$)/i.test(ref)) return 'hls'
  if (kind === 'dash' || /\.mpd(\?|$)/i.test(ref)) return 'dash'
  if (kind === 'http' || kind === 'mp4') return 'mp4'
  return null
}

function variantOf (value: string | null): SourceVariant {
  return value === 'dub' || value === 'raw' ? value : 'sub'
}

interface SourceRow {
  ref: string
  kind: string
  title: string | null
  resolution: string | null
  language: string | null
  variant: string | null
}

interface SubtitleRow {
  language: string
  kind: string
  format: string
  url: string | null
  object_key: string | null
}

export const localProvider: AnimeProvider = {
  id: 'yume-local',
  label: 'YUME saját tároló',
  defaultPriority: 10,

  /**
   * Keresés a SAJÁT katalógusunkban.
   *
   * Itt a „szolgáltató azonosítója" a saját anime-uuid — ez az egyetlen
   * adapter, ahol a két azonosítótér egybeesik.
   */
  async search (queryText: string, hint): Promise<ProviderMatch[]> {
    const rows = await query<{ id: string, canonical_title: string, anilist_id: number | null, start_date: string | null }>(
      `SELECT id, canonical_title, anilist_id, start_date
         FROM anime
        WHERE visibility = 'public'
          AND ($2::int IS NULL OR anilist_id = $2::int)
          AND ($2::int IS NOT NULL OR canonical_title ILIKE '%' || $1 || '%')
        LIMIT 20`,
      [queryText, hint?.anilistId ?? null]
    )
    return rows.map(row => ({
      id: row.id,
      title: row.canonical_title,
      anilistId: row.anilist_id,
      year: row.start_date ? Number(String(row.start_date).slice(0, 4)) : null
    }))
  },

  async episodes (matchId: string): Promise<ProviderEpisode[]> {
    const rows = await query<{ id: string, number: string, title: string | null }>(
      `SELECT id, number, title FROM episodes
        WHERE anime_id = $1 AND visibility = 'public'
        ORDER BY number`,
      [matchId]
    )
    return rows.map(row => ({ id: row.id, number: Number(row.number), title: row.title }))
  },

  /**
   * A tárolt forrásaink egy epizódhoz.
   *
   * A PÁROSÍTÁS AZ ANILIST-AZONOSÍTÓN ÁLL. Cím szerint keresni itt hiba
   * volna: a saját katalógusunkban ott a pontos kulcs, és egy cím szerinti
   * egyezés két különböző évadot összemoshat.
   */
  async resolve (ref: EpisodeRef): Promise<ProviderResult> {
    if (ref.anilistId == null) return noResult()

    const episodes = await query<{ id: string }>(
      `SELECT e.id
         FROM episodes e
         JOIN anime a ON a.id = e.anime_id
        WHERE a.anilist_id = $1 AND e.number = $2
          AND e.visibility = 'public' AND a.visibility <> 'hidden'
        LIMIT 1`,
      [ref.anilistId, ref.number]
    )
    const episodeId = episodes[0]?.id
    if (!episodeId) return noResult()

    const want = ref.variant ?? 'sub'
    const rows = await query<SourceRow>(
      `SELECT ref, kind, title, resolution, language, variant
         FROM video_sources
        WHERE episode_id = $1 AND enabled
        ORDER BY priority, created_at`,
      [episodeId]
    )

    const sources: ProviderSource[] = []
    for (const row of rows) {
      const transport = transportOf(row.kind, row.ref)
      if (!transport) continue
      const variant = variantOf(row.variant)
      // A kért változat nyer; ha a sor nem mond változatot, `sub`-nak vesszük.
      if (variant !== want) continue
      sources.push({
        kind: transport,
        url: row.ref,
        quality: row.resolution,
        language: row.language,
        variant,
        headers: {}
      })
    }

    if (!sources.length) return noResult()

    const subs = await query<SubtitleRow>(
      `SELECT language, kind, format, url, object_key
         FROM subtitle_tracks
        WHERE episode_id = $1
        ORDER BY language, kind`,
      [episodeId]
    )
    const subtitles: ProviderSubtitle[] = subs
      .map(row => {
        const url = row.url ?? (row.object_key ? `/media/${row.object_key}` : null)
        if (!url) return null
        const format = row.format === 'ass' || row.format === 'srt' ? row.format : 'vtt'
        return {
          language: row.language,
          kind: row.kind === 'captions' ? 'captions' as const : 'subtitles' as const,
          format,
          url
        }
      })
      .filter((s): s is ProviderSubtitle => s !== null)

    return { sources, subtitles }
  }
}
