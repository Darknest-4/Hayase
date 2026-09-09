// The founder's account: the whole catalogue, already watched.
//
// The first account on an instance is the person who built it. This fills that
// account's library with every title, marks every episode of every title as
// finished, unlocks every achievement, and recomputes the stats and XP that
// follow from all of that.
//
// Written as set-based SQL rather than a loop over rows, and that is not a
// micro-optimisation: it is 25,703 library entries and 333,021 episodes on the
// instance this was written against. A row at a time would take hours and hold
// a connection the whole while; `INSERT ... SELECT` takes seconds.
//
// Every statement is an upsert, so running it twice changes nothing the second
// time. That matters more than it sounds: it runs from a queue with retries,
// and a job that half-applied and then failed must be safe to run again.

import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'

import type pg from 'pg'

export interface FounderSeedResult {
  profileId: string
  library: number
  episodes: number
  achievements: number
  minutesWatched: number
  xp: number
}

/** How long an episode counts for when nothing says otherwise. */
const DEFAULT_EPISODE_MINUTES = 24

/**
 * The account that owns the instance: the oldest one that holds `admin`.
 *
 * Oldest-admin rather than plain oldest, because "the first account" is only
 * meaningful as "the account the bootstrap promoted" — see
 * modules/auth/repository.ts. On an instance where the users table was purged
 * and rebuilt, the oldest row may be somebody else entirely.
 */
export async function founderProfile (): Promise<{ userId: string, profileId: string, username: string } | null> {
  const found = await queryOne<{ userId: string, profileId: string, username: string }>(
    `SELECT u.id AS "userId", p.id AS "profileId", u.username
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id AND r.slug = 'admin'
       JOIN user_profiles p ON p.user_id = u.id
      WHERE u.deleted_at IS NULL
      ORDER BY u.created_at, u.id
      LIMIT 1`
  )
  return found ?? null
}

/**
 * Fill one profile's library with everything the catalogue holds.
 *
 * `onlyPublic` exists because "every anime" has two readings. The catalogue
 * holds 25,703 titles and publishes 3,118 of them; the rest are imported but
 * hidden, and a hidden title in a library is a row nobody can open. The
 * default is everything, because the person asking for this owns the instance
 * and will publish the rest — but the choice is here rather than assumed.
 */
export async function seedFounderLibrary (
  profileId: string,
  { onlyPublic = false }: { onlyPublic?: boolean } = {}
): Promise<FounderSeedResult> {
  const visibility = onlyPublic ? "WHERE a.visibility = 'public'" : ''

  return transaction(async (client: pg.PoolClient) => {
    // ---- every title, finished ----
    //
    // `progress` is the episode count we hold, not what the catalogue claims
    // in `episode_count`: the two disagree for a lot of imported titles, and
    // the library page draws "12 / 24" from them. Taking the real count keeps
    // the bar full instead of stuck at half.
    const library = await client.query(
      `INSERT INTO library_entries (profile_id, anime_id, status, progress, started_at, finished_at)
       SELECT $1, a.id, 'COMPLETED',
              LEAST(
                COALESCE(a.episode_count, 0),
                COALESCE((SELECT count(*) FROM episodes e WHERE e.anime_id = a.id), 0)
              )::smallint,
              COALESCE(a.start_date, CURRENT_DATE),
              CURRENT_DATE
         FROM anime a
         ${visibility}
       ON CONFLICT (profile_id, anime_id) DO UPDATE
          SET status = 'COMPLETED',
              progress = GREATEST(library_entries.progress, EXCLUDED.progress),
              finished_at = COALESCE(library_entries.finished_at, EXCLUDED.finished_at),
              updated_at = now()`,
      [profileId]
    )

    // ---- every episode, watched to the end ----
    //
    // position_sec is set to the duration rather than left at 0 so "continue
    // watching" does not offer all 333,021 of them back: that list is built
    // from the rows where `completed` is false, and a finished episode has to
    // look finished from both directions.
    const episodes = await client.query(
      `INSERT INTO watch_progress (profile_id, episode_id, anime_id, position_sec, duration_sec, completed)
       SELECT $1, e.id, e.anime_id,
              COALESCE(e.duration, $2)::numeric * 60,
              COALESCE(e.duration, $2)::numeric * 60,
              true
         FROM episodes e
         JOIN anime a ON a.id = e.anime_id
         ${visibility}
       ON CONFLICT (profile_id, episode_id) DO UPDATE
          SET completed = true,
              position_sec = EXCLUDED.duration_sec,
              duration_sec = COALESCE(watch_progress.duration_sec, EXCLUDED.duration_sec),
              updated_at = now()`,
      [profileId, DEFAULT_EPISODE_MINUTES]
    )

    // ---- every achievement ----
    const achievements = await client.query(
      `INSERT INTO profile_achievements (profile_id, achievement_id)
       SELECT $1, ac.id FROM achievements ac
       ON CONFLICT (profile_id, achievement_id) DO NOTHING`,
      [profileId]
    )

    // The XP each achievement carries, recorded once per achievement so the
    // history reads as a list of unlocks rather than one unexplained lump.
    // `ref_id` is the achievement, which is what makes the dedupe possible.
    await client.query(
      `INSERT INTO xp_events (profile_id, amount, reason, ref_id)
       SELECT $1, ac.xp_reward, 'achievement:' || ac.slug, ac.id
         FROM achievements ac
        WHERE ac.xp_reward > 0
          AND NOT EXISTS (
            SELECT 1 FROM xp_events x
             WHERE x.profile_id = $1 AND x.ref_id = ac.id AND x.reason = 'achievement:' || ac.slug
          )`,
      [profileId]
    )

    // ---- what all of that adds up to ----
    const totals = await client.query<{
      minutes: string, episodes: string, completed: string, xp: string
    }>(
      `SELECT
         COALESCE(SUM(w.duration_sec) FILTER (WHERE w.completed), 0) / 60 AS minutes,
         count(*) FILTER (WHERE w.completed)                              AS episodes,
         (SELECT count(*) FROM library_entries le
           WHERE le.profile_id = $1 AND le.status = 'COMPLETED')          AS completed,
         (SELECT COALESCE(SUM(amount), 0) FROM xp_events x
           WHERE x.profile_id = $1)                                      AS xp
       FROM watch_progress w WHERE w.profile_id = $1`,
      [profileId]
    )
    const row = totals.rows[0]
    const minutes = Math.round(Number(row?.minutes ?? 0))
    const xp = Number(row?.xp ?? 0)

    await client.query(
      `INSERT INTO profile_stats (profile_id, xp_total, level, minutes_watched, episodes_watched, anime_completed, genre_breakdown)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE((
         SELECT jsonb_object_agg(g.name, c) FROM (
           SELECT g.name, count(*) AS c
             FROM library_entries le
             JOIN anime_genres ag ON ag.anime_id = le.anime_id
             JOIN genres g ON g.id = ag.genre_id
            WHERE le.profile_id = $1
            GROUP BY g.name
         ) g
       ), '{}'::jsonb))
       ON CONFLICT (profile_id) DO UPDATE
          SET xp_total = EXCLUDED.xp_total,
              level = EXCLUDED.level,
              minutes_watched = EXCLUDED.minutes_watched,
              episodes_watched = EXCLUDED.episodes_watched,
              anime_completed = EXCLUDED.anime_completed,
              genre_breakdown = EXCLUDED.genre_breakdown,
              updated_at = now()`,
      [profileId, xp, levelFor(xp), minutes, Number(row?.episodes ?? 0), Number(row?.completed ?? 0)]
    )

    return {
      profileId,
      library: library.rowCount ?? 0,
      episodes: episodes.rowCount ?? 0,
      achievements: achievements.rowCount ?? 0,
      minutesWatched: minutes,
      xp
    }
  })
}

/**
 * Level from total XP.
 *
 * The same curve the client draws — 100 XP for level 2, then each level a
 * little dearer than the last. Kept here rather than imported from the client
 * because the two cannot share code, and duplicated deliberately with the
 * shape written out so a change on either side is visible as a difference.
 */
export function levelFor (xp: number): number {
  let level = 1
  let needed = 100
  let remaining = xp
  while (remaining >= needed && level < 999) {
    remaining -= needed
    level += 1
    needed = Math.round(needed * 1.15)
  }
  return level
}

/** The queue handler. Payload: `{ profileId }`, or nothing for the founder. */
export async function handleFounderJob (job: { payload: Record<string, unknown> }): Promise<void> {
  const asked = typeof job.payload.profileId === 'string' ? job.payload.profileId : null
  const onlyPublic = job.payload.onlyPublic === true

  let profileId = asked
  if (!profileId) {
    const founder = await founderProfile()
    if (!founder) return // nobody has registered yet; nothing to fill
    profileId = founder.profileId
  }

  const owns = await queryOne('SELECT 1 FROM user_profiles WHERE id = $1', [profileId])
  if (!owns) return // the account went away between enqueue and run

  const result = await seedFounderLibrary(profileId, { onlyPublic })
  await query(
    `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
     VALUES (NULL, 'library.founder.seed', 'profile', $1::text, '{}'::jsonb, $2::jsonb)`,
    [profileId, JSON.stringify(result)]
  )
}
