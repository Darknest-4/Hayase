// Reads over an episode and the things that hang off it: the list for an
// anime, the sources it can be played from, its skip intervals and its
// subtitle tracks.
//
// The rule that runs through all of them is worth stating once rather than
// four times: **visibility is checked through the episode's anime, not only
// the episode.** Publishing an episode under a hidden entry must not make it
// reachable, and three of these endpoints are addressed by episode id alone —
// so without the join to `anime` a hidden title's episodes were fetchable by
// anybody who had ever seen one of their ids.

import { Repository } from '@yume/database'

import { db } from '../../infrastructure/database/index.ts'
import { resolveExternalIds } from '../providers/mapping/index.ts'

export class EpisodeRepository extends Repository {
  /**
   * The published episodes of one anime, with whether each can be played.
   *
   * `source_count` is what the list uses to decide what to make clickable: an
   * episode with nowhere to play from is a link to a dead end.
   */
  listFor (animeId: string, language: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT e.id, e.number, e.absolute_number, e.title, e.synopsis, e.thumbnail_key,
              e.air_date, e.duration, e.is_filler, e.is_recap,
              (SELECT count(*) FROM video_sources v
                WHERE v.episode_id = e.id AND v.enabled)::int AS source_count,
              tr.title    AS title_hu,
              tr.synopsis AS synopsis_hu
       FROM episodes e
       LEFT JOIN episode_translations tr
              ON tr.episode_id = e.id AND tr.language = $2 AND tr.approved
       WHERE e.anime_id = $1 AND e.visibility = 'public' ORDER BY e.number`,
      [animeId, language]
    )
  }

  /**
   * How many episodes exist at all, published or not.
   *
   * The caller needs this to tell two silences apart: zero means we have no
   * episode data and the client may fall back to an external source, while a
   * non-zero total with nothing published means we have data and chose to
   * publish none — a decision the client must not route around.
   */
  async countFor (animeId: string): Promise<number> {
    const row = await this.queryOne<{ total: number }>(
      'SELECT count(*)::int AS total FROM episodes WHERE anime_id = $1', [animeId])
    return Number(row?.total ?? 0)
  }

  /** Is this episode published, under an entry that is not hidden? */
  async isPlayable (episodeId: string): Promise<boolean> {
    return Boolean(await this.queryOne<{ id: string }>(
      `SELECT e.id FROM episodes e JOIN anime a ON a.id = e.anime_id
        WHERE e.id = $1 AND e.visibility = 'public' AND a.visibility <> 'hidden'`,
      [episodeId]
    ))
  }

  /**
   * Amit a szolgáltatóknak tudniuk kell erről az epizódról.
   *
   * MIÉRT NEM A SAJÁT SOR-AZONOSÍTÓNK MEGY KI. Egy külső szolgáltató nem tud
   * mit kezdeni egy YUME-uuid-vel. Ami segít neki, az az AniList-azonosító (a
   * legjobb horgony, mert a legtöbb katalógus ismeri), a cím, az évszám és a
   * rész száma — a szinonimák pedig azért, mert a párosítás sokszor épp azon
   * áll vagy bukik.
   */
  async providerRef (episodeId: string): Promise<{
    anilistId: number | null, malId: number | null, kitsuId: number | null, anidbId: number | null,
    title: string, synonyms: string[], year: number | null, number: number
  } | null> {
    const row = await this.queryOne<{
      anime_id: string,
      anilist_id: number | null, mal_id: number | null, kitsu_id: number | null, anidb_id: number | null,
      canonical_title: string, start_date: string | null, number: string
    }>(
      /*
       * AZ ANILIST-AZONOSÍTÓ NEM AZ `anime` TÁBLÁN VAN, hanem az
       * `anime_mappings`-ben, a többi külső azonosító mellett — és `LEFT
       * JOIN`, mert egy katalógusbeli címhez nem feltétlenül tartozik
       * leképezés. Az első nekifutásom `a.anilist_id`-t írt, és a
       * `video-sources` tesztje azonnal elbuktatta: „column a.anilist_id does
       * not exist".
       */
      /*
       * MIND A NÉGY KÜLSŐ AZONOSÍTÓ ÁTMEGY, nem csak az AniList-é. Egy
       * szolgáltató, ami MAL vagy AniDB szerint katalogizál, különben cím
       * szerint párosítana, ami két évadnál rendre téved.
       */
      `SELECT a.id AS anime_id,
              m.anilist_id, m.mal_id, m.kitsu_id, m.anidb_id,
              a.canonical_title, a.start_date, e.number
         FROM episodes e
         JOIN anime a ON a.id = e.anime_id
         LEFT JOIN anime_mappings m ON m.anime_id = a.id
        WHERE e.id = $1 AND e.visibility = 'public' AND a.visibility <> 'hidden'`,
      [episodeId]
    )
    if (!row) return null

    /*
     * A HIÁNYZÓ AZONOSÍTÓK KIEGÉSZÍTÉSE.
     *
     * A tábla azt tudja, amit valaha beírtunk. Ami hiányzik, azt eddig egy
     * adapter cím szerint próbálta pótolni — és ott téved a legnagyobbat: két
     * évad címe gyakran majdnem azonos, az azonosítójuk viszont nem
     * (mérve: a Shingeki no Kyojin 1. évadához `anidb 9541`, a 3.-hoz
     * `anidb 13241` tartozik).
     *
     * A feloldó nem dob, és nem is lassít, ha nincs mit tennie: teljes
     * leképezésnél egyetlen külső hívás sincs.
     */
    const ids = await resolveExternalIds(row.anime_id)

    const synonyms = await this.query<{ title: string }>(
      `SELECT title FROM anime_titles t
         JOIN episodes e ON e.anime_id = t.anime_id
        WHERE e.id = $1 LIMIT 20`,
      [episodeId]
    ).catch(() => [])

    return {
      anilistId: ids.anilistId,
      malId: ids.malId,
      kitsuId: ids.kitsuId,
      anidbId: ids.anidbId,
      title: row.canonical_title,
      synonyms: synonyms.map(s => s.title).filter(Boolean),
      year: row.start_date ? Number(String(row.start_date).slice(0, 4)) : null,
      number: Number(row.number)
    }
  }

  /**
   * Where this episode can be played from.
   *
   * References, never media. Disabled rows are left out: `enabled` is how an
   * operator takes a dead link out of playback without losing the record of
   * which episode it belonged to.
   */
  sourcesFor (episodeId: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT id, kind, ref, title, provider, resolution, language, variant, is_batch, size_bytes, seeders
         FROM video_sources
        WHERE episode_id = $1 AND enabled
        ORDER BY priority, created_at`,
      [episodeId]
    )
  }

  /**
   * Opening and ending intervals, most-agreed-with first.
   *
   * `skip_segments` was built for community submissions, so votes are the
   * ordering: the interval people agreed with is the one to offer.
   */
  skipsFor (episodeId: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT s.id, s.kind, s.start_sec, s.end_sec, s.votes
         FROM skip_segments s
         JOIN episodes e ON e.id = s.episode_id
         JOIN anime a ON a.id = e.anime_id
        WHERE s.episode_id = $1 AND e.visibility = 'public' AND a.visibility <> 'hidden'
        ORDER BY s.kind, s.votes DESC`,
      [episodeId]
    )
  }

  /**
   * Subtitle tracks.
   *
   * A track is either hosted by us (`object_key`) or referenced (`url`); the
   * caller wants one address either way, so both come back and the client
   * prefers whichever is set.
   */
  subtitlesFor (episodeId: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT t.id, t.language, t.kind, t.format, t.url, t.object_key, t.source_id
         FROM subtitle_tracks t
         JOIN episodes e ON e.id = t.episode_id
         JOIN anime a ON a.id = e.anime_id
        WHERE t.episode_id = $1 AND e.visibility = 'public' AND a.visibility <> 'hidden'
        ORDER BY t.language, t.kind`,
      [episodeId]
    )
  }
}

export const episodeRepository = new EpisodeRepository(db)
