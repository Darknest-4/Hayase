// Reads over the anime aggregate: the detail record, browse, the schedule,
// the AniList bridge, relations, the franchise walk, cast, staff and
// recommendations.
//
// Two things are true of nearly every query here and are the reason they are
// worth having in one file:
//
//   * **Visibility.** `public`, `unlisted` and `hidden` mean different things
//     to different endpoints — browse takes only `public`, a direct link takes
//     anything not `hidden`, and the franchise walk takes `public` plus the
//     row that was asked about. Scattered across six route handlers those
//     rules drifted; together they can be read against each other.
//   * **The cover join.** `LEFT JOIN anime_images … kind = 'cover' AND
//     is_primary` appears in seven of them, and an endpoint that forgot it
//     returned rows the client drew with a blank card.
//
// Sibling of ./episode-repository.ts, which owns everything hanging off an
// episode, and ./metadata-repository.ts, which owns the write path.

import { Repository } from '@yume/database'

import { db } from '../../infrastructure/database/index.ts'

/** The cover image every card needs, joined the same way everywhere. */
const COVER = "LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary"

/** The external id the client uses to link a row it only knows from AniList. */
const MAPPING = 'LEFT JOIN anime_mappings m ON m.anime_id = a.id'

export interface BrowsePage {
  /** Already-built WHERE fragments, and the parameters they reference. */
  where: string[]
  params: unknown[]
  sort: { column: string, dir: string, nulls: string }
}

export class AnimeRepository extends Repository {
  /**
   * The full catalogue record for one anime, with every relation the detail
   * page draws folded in as jsonb.
   *
   * One query rather than eight round trips, and `visibility <> 'hidden'`
   * rather than `= 'public'`: an unlisted entry is reachable by direct link,
   * which is what unlisted means.
   */
  detail (id: string, language: string): Promise<Record<string, unknown> | undefined> {
    return this.queryOne<Record<string, unknown>>(
      `SELECT a.*,
          tr.title    AS title_hu,
          tr.synopsis AS synopsis_hu,
          (SELECT jsonb_object_agg(t.kind, t.title) FROM anime_titles t WHERE t.anime_id = a.id) AS titles,
          (SELECT coalesce(jsonb_agg(s.synonym), '[]') FROM anime_synonyms s WHERE s.anime_id = a.id) AS synonyms,
          (SELECT coalesce(jsonb_agg(g.name ORDER BY g.name), '[]') FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.anime_id = a.id) AS genres,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('name', tg.name, 'rank', at.rank) ORDER BY at.rank DESC), '[]')
             FROM anime_tags at JOIN tags tg ON tg.id = at.tag_id WHERE at.anime_id = a.id) AS tags,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'role', ac.role, 'isMain', ac.is_main)), '[]')
             FROM anime_companies ac JOIN companies c ON c.id = ac.company_id WHERE ac.anime_id = a.id) AS companies,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'key', i.object_key, 'blurhash', i.blurhash, 'color', i.dominant_color)), '[]')
             FROM anime_images i WHERE i.anime_id = a.id AND i.is_primary) AS images,
          (SELECT to_jsonb(m) - 'anime_id' FROM anime_mappings m WHERE m.anime_id = a.id) AS mappings
         FROM anime a
         LEFT JOIN anime_translations tr
                ON tr.anime_id = a.id AND tr.language = $2 AND tr.approved
        WHERE a.id = $1 AND a.visibility <> 'hidden'`,
      [id, language]
    )
  }

  /**
   * The WHERE fragment for a genre filter, given the parameter it is bound to.
   *
   * Slug OR name, case-insensitively. The client shows genre names and
   * therefore sends "Action"; matching only the slug meant every genre rail on
   * the home page silently returned nothing and fell back to AniList, with the
   * catalogue holding 900 Action titles. A caller should not have to know our
   * slugging rule to ask a question about a genre.
   *
   * A fragment rather than a method because it is one clause of the browse
   * query the caller is assembling — but it is a subquery, and subqueries
   * belong on this side of the line with the rest of the SQL.
   */
  static genreFilter (parameter: number): string {
    return `EXISTS (SELECT 1 FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id
                     WHERE ag.anime_id = a.id
                       AND (g.slug = lower($${parameter}) OR lower(g.name) = lower($${parameter})))`
  }

  /**
   * One page of the browse listing.
   *
   * The filters and the keyset cursor are built by the caller — they are
   * request parsing, and the alternative is a repository method with nine
   * optional arguments that rebuilds the same fragments. What belongs here is
   * the projection and the ordering, which is what every caller shares.
   */
  browse (page: BrowsePage): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT a.id, a.canonical_title, a.format, a.status, a.season, a.season_year,
              a.episode_count, a.average_score, a.popularity, a.is_adult,
              ${page.sort.column} AS sort_value,
              img.object_key AS cover_key, img.blurhash, img.dominant_color
       FROM anime a
       ${COVER}
       WHERE ${page.where.join(' AND ')}
       ORDER BY ${page.sort.column} ${page.sort.dir} NULLS ${page.sort.nulls}, a.id
       LIMIT $${page.params.length}`,
      page.params
    )
  }

  /**
   * Episodes airing in a window.
   *
   * Published episodes of published entries only: a calendar listing something
   * nobody can watch yet is worse than one that waits.
   */
  schedule (from: string, to: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT e.id AS episode_id, e.number AS episode, e.air_date,
              a.id AS anime_id, a.canonical_title, a.format, a.is_adult,
              img.object_key AS cover_key, m.anilist_id
       FROM episodes e
       JOIN anime a ON a.id = e.anime_id
       ${COVER}
       ${MAPPING}
       WHERE e.air_date >= $1 AND e.air_date < $2
         AND a.visibility = 'public' AND e.visibility = 'public'
       ORDER BY e.air_date`,
      [from, to]
    )
  }

  /** Card data for a batch of AniList ids, for the client's own lists. */
  cardsByAnilistIds (ids: number[]): Promise<Array<{ anilist_id: number }>> {
    return this.query<{ anilist_id: number }>(
      `SELECT a.id, m.anilist_id, a.canonical_title, a.format, a.status,
              a.season_year, a.episode_count, a.average_score, a.is_adult,
              t.title AS romaji, te.title AS english,
              img.object_key AS cover_key, img.dominant_color AS cover_color
         FROM anime_mappings m
         JOIN anime a ON a.id = m.anime_id
         LEFT JOIN anime_titles t ON t.anime_id = a.id AND t.kind = 'romaji'
         LEFT JOIN anime_titles te ON te.anime_id = a.id AND te.kind = 'english'
         ${COVER}
        WHERE m.anilist_id = ANY($1::int[]) AND a.visibility = 'public'`,
      [ids]
    )
  }

  /** The entry behind an AniList id, if it is not hidden. */
  byAnilistId (anilistId: number): Promise<{ id: string, canonical_title: string } | undefined> {
    return this.queryOne<{ id: string, canonical_title: string }>(
      `SELECT a.id, a.canonical_title FROM anime_mappings m JOIN anime a ON a.id = m.anime_id
        WHERE m.anilist_id = $1 AND a.visibility <> 'hidden'`,
      [anilistId]
    )
  }

  /** The mapping alone, whatever the entry's visibility — this is the resolver. */
  mappedIdFor (anilistId: number): Promise<{ id: string } | undefined> {
    return this.queryOne<{ id: string }>(
      'SELECT anime_id AS id FROM anime_mappings WHERE anilist_id = $1',
      [anilistId]
    )
  }

  /**
   * Create the minimal row that lets an AniList id become a Yume id.
   *
   * A stub, enriched later by the metadata importer. One statement so the
   * anime and its mapping cannot exist without each other — a mapping row
   * pointing at a missing anime is a 500 on every later lookup.
   */
  createStub (stub: {
    title: string, format: string | null, status: string | null,
    episodes: number | null, isAdult: boolean | null, anilistId: number
  }): Promise<{ id: string } | undefined> {
    return this.queryOne<{ id: string }>(
      `WITH new_anime AS (
         INSERT INTO anime (canonical_title, format, status, episode_count, is_adult)
         VALUES ($1, coalesce($2, 'TV')::anime_format, coalesce($3, 'FINISHED')::anime_status, $4, coalesce($5, false))
         RETURNING id
       )
       INSERT INTO anime_mappings (anime_id, anilist_id)
       SELECT id, $6 FROM new_anime
       RETURNING anime_id AS id`,
      [stub.title, stub.format, stub.status, stub.episodes, stub.isAdult, stub.anilistId]
    )
  }

  /** Does this entry exist and is it linkable? */
  async isVisible (id: string): Promise<boolean> {
    return Boolean(await this.queryOne(
      "SELECT 1 FROM anime WHERE id = $1 AND visibility <> 'hidden'", [id]))
  }

  /** What is directly attached to this entry — the question a graph asks. */
  relations (id: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT r.relation, a.id, a.canonical_title, a.format, a.status,
              img.object_key AS cover_key, m.anilist_id
       FROM anime_relations r
       JOIN anime a ON a.id = r.related_id
       ${COVER}
       ${MAPPING}
       WHERE r.anime_id = $1`,
      [id]
    )
  }

  /**
   * The whole franchise, in the order to watch it.
   *
   * An undirected walk over anime_relations, depth- and count-capped:
   * franchises run to dozens of entries and an uncapped walk on a
   * well-connected component would return most of the catalogue to draw a
   * sidebar. One row over the cap so the caller can say "there was more".
   *
   * Ordered by release date rather than by the graph. Sequel edges give only a
   * partial order, plenty are missing, and the films and specials have no
   * place in that order at all — a date is a total order and is what a viewer
   * means by "what comes next".
   */
  franchise (id: string): Promise<Array<{
    id: string, canonical_title: string, format: string, status: string,
    season: string | null, season_year: number | null, start_date: string | null,
    episode_count: number | null, cover_key: string | null, anilist_id: number | null,
    relation: string | null, depth: number
  }>> {
    return this.query(
      `WITH RECURSIVE walk AS (
         SELECT $1::uuid AS id, 0 AS depth
         UNION
         SELECT CASE WHEN r.anime_id = w.id THEN r.related_id ELSE r.anime_id END, w.depth + 1
           FROM walk w
           JOIN anime_relations r ON r.anime_id = w.id OR r.related_id = w.id
          WHERE w.depth < 2
       ),
       nodes AS (SELECT id, min(depth) AS depth FROM walk GROUP BY id)
       SELECT a.id, a.canonical_title, a.format, a.status, a.season, a.season_year,
              a.start_date, a.episode_count, n.depth,
              img.object_key AS cover_key, m.anilist_id,
              -- the direct edge to the title that was asked about, when there
              -- is one; further out there is no single relation to name
              (SELECT r.relation FROM anime_relations r
                WHERE (r.anime_id = $1 AND r.related_id = a.id)
                   OR (r.related_id = $1 AND r.anime_id = a.id)
                LIMIT 1) AS relation
         FROM nodes n
         JOIN anime a ON a.id = n.id
         ${COVER}
         ${MAPPING}
        WHERE a.visibility = 'public' OR a.id = $1
        ORDER BY a.start_date NULLS LAST, a.season_year NULLS LAST, a.canonical_title
        LIMIT 61`,
      [id]
    )
  }

  /**
   * Cast, with each character's voice actors aggregated onto it.
   *
   * Aggregated rather than joined flat: a character with a Japanese and a
   * Hungarian actor is one card with two credits, and a flat join would return
   * the character twice.
   */
  characters (id: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT c.id, c.name, c.native_name, c.image_key, ac.role,
              (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'id', p.id, 'name', p.name, 'nativeName', p.native_name,
                        'imageKey', p.image_key, 'language', cv.language) ORDER BY cv.language), '[]')
                 FROM character_voices cv
                 JOIN people p ON p.id = cv.person_id
                WHERE cv.character_id = c.id AND cv.anime_id = ac.anime_id) AS voices
         FROM anime_characters ac
         JOIN characters c ON c.id = ac.character_id
        WHERE ac.anime_id = $1
        -- MAIN first, then SUPPORTING, then BACKGROUND; the page shows the
        -- top of this list and never paginates it.
        ORDER BY CASE ac.role WHEN 'MAIN' THEN 0 WHEN 'SUPPORTING' THEN 1 ELSE 2 END, c.name`,
      [id]
    )
  }

  /** Staff, director first: it is the credit anybody scanning the list wants. */
  staff (id: string): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT p.id, p.name, p.native_name, p.image_key, s.role
         FROM anime_staff s
         JOIN people p ON p.id = s.person_id
        WHERE s.anime_id = $1
        ORDER BY CASE WHEN s.role ILIKE 'director%' THEN 0
                      WHEN s.role ILIKE 'original creator%' THEN 1
                      ELSE 2 END, s.role, p.name`,
      [id]
    )
  }

  recommendations (id: string, limit: number): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT a.id, a.canonical_title, a.format::text, a.status::text, a.season_year,
              a.episode_count, a.average_score, r.score,
              img.object_key AS cover_key, m.anilist_id
         FROM anime_recommendations r
         JOIN anime a ON a.id = r.recommended_id
         ${COVER}
         ${MAPPING}
        WHERE r.anime_id = $1 AND a.visibility = 'public'
        ORDER BY r.score DESC, a.popularity DESC NULLS LAST
        LIMIT $2`,
      [id, limit]
    )
  }
}

export const animeRepository = new AnimeRepository(db)
