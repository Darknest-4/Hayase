// The catalogue's write side, and the reads that only staff see.
//
// Separate from ./anime-repository.ts because the visibility rule is inverted:
// every method here sees hidden entries on purpose. The admin surface exists
// to find and fix what is *not* published, so filtering it would hide exactly
// what somebody came for. Keeping the two sets of queries in different files
// is what stops that rule being applied by accident in the wrong direction —
// which is the single easiest way to leak an unpublished catalogue.
//
// The dynamic-update methods take the fragment the caller built rather than a
// bag of optional fields. Building `SET a = $1, b = $2` from a validated
// allow-list is request handling; the projection and the RETURNING clause are
// persistence, and this is where the line falls.

import { Repository } from '@yume/database'

import { db } from '../../infrastructure/database/index.ts'

export interface DynamicUpdate { sql: string, values: unknown[] }

export class CatalogueAdminRepository extends Repository {
  // ----------------------------------------------------------------- anime

  /** The staff listing: every entry, published or not, with its episode count. */
  list (where: string[], params: unknown[]): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT a.id, a.canonical_title, a.format, a.status, a.season, a.season_year,
              a.episode_count, a.is_adult, a.visibility, a.updated_at,
              (SELECT count(*) FROM episodes e WHERE e.anime_id = a.id) AS episode_rows,
              img.object_key AS cover_key
       FROM anime a
       LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
  }

  async count (where: string[], params: unknown[]): Promise<number> {
    const row = await this.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM anime a ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params
    )
    return Number(row?.n ?? 0)
  }

  /** One entry for the editor, including its provenance and locks. */
  forEditing (id: string): Promise<Record<string, unknown> | undefined> {
    return this.queryOne(
      `SELECT id, canonical_title, format, status, season, season_year, start_date, end_date,
              episode_count, episode_duration, age_rating, is_adult, synopsis, country,
              source_material, visibility, popularity, average_score,
              locked_fields, metadata_sources, created_at, updated_at
       FROM anime WHERE id = $1`,
      [id]
    )
  }

  create (values: unknown[]): Promise<{ id: string, canonical_title: string } | undefined> {
    return this.queryOne<{ id: string, canonical_title: string }>(
      `INSERT INTO anime (canonical_title, format, status, season, season_year, episode_count,
                          episode_duration, synopsis, source_material, is_adult, visibility)
       VALUES ($1, coalesce($2,'TV')::anime_format, coalesce($3,'FINISHED')::anime_status,
               $4::anime_season, $5, $6, $7, $8, $9, coalesce($10,false), coalesce($11,'public'))
       RETURNING id, canonical_title`,
      values
    )
  }

  update (upd: DynamicUpdate): Promise<{ id: string, canonical_title: string, visibility: string } | undefined> {
    return this.queryOne<{ id: string, canonical_title: string, visibility: string }>(
      `UPDATE anime SET ${upd.sql} WHERE id = $${upd.values.length}
       RETURNING id, canonical_title, visibility`,
      upd.values
    )
  }

  remove (id: string): Promise<{ canonical_title: string } | undefined> {
    return this.queryOne<{ canonical_title: string }>(
      'DELETE FROM anime WHERE id = $1 RETURNING canonical_title', [id])
  }

  async exists (id: string): Promise<boolean> {
    return Boolean(await this.queryOne('SELECT 1 FROM anime WHERE id = $1', [id]))
  }

  titleOf (id: string): Promise<{ canonical_title: string } | undefined> {
    return this.queryOne<{ canonical_title: string }>(
      'SELECT canonical_title FROM anime WHERE id = $1', [id])
  }

  locksOf (id: string): Promise<Record<string, unknown> | undefined> {
    return this.queryOne('SELECT locked_fields FROM anime WHERE id = $1', [id])
  }

  /** Both sides of a merge in one statement, so a missing one is a single 404. */
  pair (ids: string[]): Promise<Array<{ id: string, canonical_title: string }>> {
    return this.query<{ id: string, canonical_title: string }>(
      'SELECT id, canonical_title FROM anime WHERE id = ANY($1::uuid[])', [ids])
  }

  // -------------------------------------------------------------- episodes

  /**
   * Every episode of one anime, unfiltered.
   *
   * Both source counts: an episode with three sources of which none is enabled
   * is not the same problem as one with no sources at all, and the row has to
   * be able to say which it is.
   */
  episodes (animeId: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT e.id, e.number, e.absolute_number, e.title, e.synopsis, e.thumbnail_key,
              e.air_date, e.duration, e.is_filler, e.is_recap, e.visibility,
              (SELECT count(*) FROM video_sources v WHERE v.episode_id = e.id)::int AS source_total,
              (SELECT count(*) FROM video_sources v WHERE v.episode_id = e.id AND v.enabled)::int AS source_count
       FROM episodes e WHERE e.anime_id = $1 ORDER BY e.number`,
      [animeId]
    )
  }

  async episodeExists (episodeId: string): Promise<boolean> {
    return Boolean(await this.queryOne('SELECT 1 FROM episodes WHERE id = $1', [episodeId]))
  }

  async episodeNumberTaken (animeId: string, number: unknown): Promise<boolean> {
    return Boolean(await this.queryOne(
      'SELECT 1 FROM episodes WHERE anime_id = $1 AND number = $2', [animeId, number]))
  }

  createEpisode (values: unknown[]): Promise<Record<string, unknown> | undefined> {
    return this.queryOne(
      `INSERT INTO episodes (anime_id, number, absolute_number, title, synopsis, air_date, duration, is_filler, is_recap)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8,false), coalesce($9,false))
       RETURNING id, number, title, air_date, duration, is_filler, is_recap, visibility`,
      values
    )
  }

  updateEpisode (upd: DynamicUpdate): Promise<Record<string, unknown> | undefined> {
    return this.queryOne(
      `UPDATE episodes SET ${upd.sql} WHERE id = $${upd.values.length}
       RETURNING id, anime_id, number, title, air_date, duration, is_filler, is_recap, visibility`,
      upd.values
    )
  }

  /**
   * Publish or unpublish a range of episodes at once.
   *
   * `IS DISTINCT FROM` so the RETURNING list is what actually *changed* — the
   * caller reports that count to an operator and writes it to the audit log,
   * and "12 episodes published" when eleven were already live is a lie in both
   * places.
   */
  setEpisodeVisibility (bounds: string[], params: unknown[]): Promise<Array<{ number: number }>> {
    return this.query<{ number: number }>(
      `UPDATE episodes SET visibility = $2, updated_at = now()
        WHERE anime_id = $1 ${bounds.length ? 'AND ' + bounds.join(' AND ') : ''}
          AND visibility IS DISTINCT FROM $2
        RETURNING number`,
      params
    )
  }

  removeEpisode (episodeId: string): Promise<Record<string, unknown> | undefined> {
    return this.queryOne('DELETE FROM episodes WHERE id = $1 RETURNING number', [episodeId])
  }

  /** The episode and the title it belongs to, for the message a source change emits. */
  episodeWithAnime (episodeId: string): Promise<{ id: string, number: number, anime: string } | undefined> {
    return this.queryOne<{ id: string, number: number, anime: string }>(
      `SELECT e.id, e.number, a.canonical_title AS anime
         FROM episodes e JOIN anime a ON a.id = e.anime_id WHERE e.id = $1`,
      [episodeId]
    )
  }

  // --------------------------------------------------------- video sources

  /** Disabled ones included: this is the editor, and a dead link is the row somebody came to fix. */
  sources (episodeId: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT s.id, s.kind, s.ref, s.title, s.provider, s.resolution, s.language, s.variant,
              s.enabled, s.priority, s.is_batch, s.size_bytes, s.seeders, s.created_at,
              u.username AS added_by
         FROM video_sources s
         LEFT JOIN users u ON u.id = s.added_by
        WHERE s.episode_id = $1
        ORDER BY s.enabled DESC, s.priority, s.created_at`,
      [episodeId]
    )
  }

  /** Throws on a duplicate (episode_id, kind, ref); the caller turns 23505 into a 409. */
  addSource (values: unknown[]): Promise<{ id: string } | undefined> {
    return this.queryOne<{ id: string }>(
      `INSERT INTO video_sources
         (episode_id, kind, ref, title, provider, resolution, language, variant,
          enabled, priority, is_batch, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, true), coalesce($10, 0), coalesce($11, false), $12)
       RETURNING id`,
      values
    )
  }

  sourceKind (sourceId: string): Promise<{ kind: string } | undefined> {
    return this.queryOne<{ kind: string }>('SELECT kind FROM video_sources WHERE id = $1', [sourceId])
  }

  updateSource (sets: string[], values: unknown[]): Promise<{ id: string, episode_id: string } | undefined> {
    return this.queryOne<{ id: string, episode_id: string }>(
      `UPDATE video_sources SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id, episode_id`,
      values
    )
  }

  removeSource (sourceId: string): Promise<{ episode_id: string, provider: string | null } | undefined> {
    return this.queryOne<{ episode_id: string, provider: string | null }>(
      'DELETE FROM video_sources WHERE id = $1 RETURNING episode_id, provider', [sourceId])
  }

  // ------------------------------------------------- skips and subtitles

  skips (episodeId: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT s.id, s.kind, s.start_sec, s.end_sec, s.votes, u.username AS submitted_by
         FROM skip_segments s
         LEFT JOIN users u ON u.id = s.submitted_by
        WHERE s.episode_id = $1 ORDER BY s.kind, s.votes DESC`,
      [episodeId]
    )
  }

  addSkip (episodeId: string, kind: string, start: number, end: number, submittedBy: string): Promise<{ id: string } | undefined> {
    return this.queryOne<{ id: string }>(
      `INSERT INTO skip_segments (episode_id, kind, start_sec, end_sec, submitted_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [episodeId, kind, start, end, submittedBy]
    )
  }

  removeSkip (skipId: string): Promise<{ episode_id: string } | undefined> {
    return this.queryOne<{ episode_id: string }>(
      'DELETE FROM skip_segments WHERE id = $1 RETURNING episode_id', [skipId])
  }

  subtitles (episodeId: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT id, language, kind, format, url, object_key, source_id
         FROM subtitle_tracks WHERE episode_id = $1 ORDER BY language, kind`,
      [episodeId]
    )
  }

  addSubtitle (episodeId: string, language: string, kind: string | null, format: string, url: string): Promise<{ id: string } | undefined> {
    return this.queryOne<{ id: string }>(
      `INSERT INTO subtitle_tracks (episode_id, language, kind, format, url)
       VALUES ($1, $2, coalesce($3, 'subtitles'), $4, $5) RETURNING id`,
      [episodeId, language, kind, format, url]
    )
  }

  removeSubtitle (trackId: string): Promise<{ episode_id: string } | undefined> {
    return this.queryOne<{ episode_id: string }>(
      'DELETE FROM subtitle_tracks WHERE id = $1 RETURNING episode_id', [trackId])
  }

  // -------------------------------------------------- metadata run history

  /** The recent runs, for the one screen that shows the sync's health. */
  metadataRuns (limit = 15): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT r.id, r.kind, r.scope, r.max_items, r.status, r.processed, r.total,
              r.updated_rows, r.counts, r.error, r.created_at, r.started_at, r.finished_at,
              u.username AS started_by
         FROM metadata_runs r
         LEFT JOIN users u ON u.id = r.started_by
        ORDER BY r.created_at DESC
        LIMIT $1`,
      [limit]
    )
  }

  // ------------------------------------------------------- mapping conflicts

  /**
   * External ids two catalogue entries both claim.
   *
   * Mostly AniList season splits against one MAL entry rather than corruption,
   * but the pairs are also where real duplicates surface — and nobody goes
   * looking in a table they were never shown.
   */
  mappingConflicts (): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT c.id, c.provider, c.external_id, c.source, c.seen_count, c.first_seen, c.last_seen,
              c.anime_id, a.canonical_title AS anime_title,
              c.held_by, h.canonical_title AS holder_title
         FROM mapping_conflicts c
         JOIN anime a ON a.id = c.anime_id
         LEFT JOIN anime h ON h.id = c.held_by
        WHERE c.resolved_at IS NULL
        ORDER BY c.seen_count DESC, c.last_seen DESC
        LIMIT 100`
    )
  }

  /** `resolved_at IS NULL` in the WHERE so resolving twice is a 404, not a silent overwrite. */
  resolveConflict (id: string, resolution: string): Promise<{ id: string } | undefined> {
    return this.queryOne<{ id: string }>(
      `UPDATE mapping_conflicts SET resolved_at = now(), resolution = $2
        WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
      [id, resolution]
    )
  }
}

export const catalogueAdminRepository = new CatalogueAdminRepository(db)
