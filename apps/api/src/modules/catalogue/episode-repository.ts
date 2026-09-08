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
