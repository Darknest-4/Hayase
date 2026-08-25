// Stats worker: incremental rollups from watch_history and xp_events.
// Jobs:
//   { profileId }         → recompute profile_stats for one profile
//   { rollupDay: 'YYYY-MM-DD' } → recompute watch_stats_daily for a day
//   { trending: true }    → recompute anime.trending from recent activity

import { query } from '../db.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { Job } from '../lib/queue.ts'

export async function recomputeProfileStats (profileId: string): Promise<void> {
  await query(
    `INSERT INTO profile_stats (profile_id, xp_total, level, minutes_watched, episodes_watched, anime_completed, mean_score, updated_at)
     SELECT
       $1,
       coalesce(xp.total, 0),
       floor(sqrt(coalesce(xp.total, 0) / 100.0))::int + 1,
       coalesce(wh.minutes, 0),
       coalesce(wh.episodes, 0),
       coalesce(le.completed, 0),
       le.mean_score,
       now()
     FROM (SELECT 1) AS one
     LEFT JOIN (
       SELECT sum(amount) AS total FROM xp_events WHERE profile_id = $1
     ) xp ON true
     LEFT JOIN (
       SELECT sum(watched_sec) / 60 AS minutes, count(DISTINCT episode_id) FILTER (WHERE finished) AS episodes
       FROM watch_history WHERE profile_id = $1
     ) wh ON true
     LEFT JOIN (
       SELECT count(*) FILTER (WHERE status = 'COMPLETED') AS completed, avg(score) FILTER (WHERE score > 0) AS mean_score
       FROM library_entries WHERE profile_id = $1
     ) le ON true
     ON CONFLICT (profile_id) DO UPDATE SET
       xp_total = excluded.xp_total,
       level = excluded.level,
       minutes_watched = excluded.minutes_watched,
       episodes_watched = excluded.episodes_watched,
       anime_completed = excluded.anime_completed,
       mean_score = excluded.mean_score,
       updated_at = now()`,
    [profileId]
  )

  /*
   * Minutes per genre.
   *
   * The column has been in the schema since the profile migration and the
   * insert above never wrote it, so it stayed `{}` and the analytics screen
   * had nothing to draw from the server — which is part of why that screen
   * computed everything from browser storage instead.
   *
   * A separate statement rather than another LEFT JOIN in the one above: this
   * aggregates over a join of three tables, and folding it in would make a
   * query that is already hard to read unreadable for no gain.
   *
   * The minutes deliberately overlap. A title that is both Action and Drama
   * contributes its full runtime to each, so these numbers sum to more than
   * `minutes_watched` — that is the honest answer to "which genres do you
   * watch", and splitting a show's time between its genres would invent a
   * precision nobody has. A chart drawn from this must be read as shares of
   * attention, not as a partition of a total.
   */
  await query(
    `UPDATE profile_stats SET genre_breakdown = coalesce((
       SELECT jsonb_object_agg(genre, minutes)
         FROM (
           SELECT g.name AS genre, (sum(wh.watched_sec) / 60)::bigint AS minutes
             FROM watch_history wh
             JOIN anime_genres ag ON ag.anime_id = wh.anime_id
             JOIN genres g ON g.id = ag.genre_id
            WHERE wh.profile_id = $1 AND wh.finished
            GROUP BY g.name
            -- A genre with under a minute against it is noise on a chart.
           HAVING sum(wh.watched_sec) >= 60
            ORDER BY minutes DESC
            LIMIT 30
         ) per_genre
     ), '{}'::jsonb)
     WHERE profile_id = $1`,
    [profileId]
  )
}

export async function rollupDay (day: string): Promise<void> {
  await query(
    `INSERT INTO watch_stats_daily (day, anime_id, unique_viewers, minutes_watched, completions)
     SELECT $1::date, anime_id,
            count(DISTINCT profile_id),
            coalesce(sum(watched_sec) / 60, 0),
            count(*) FILTER (WHERE finished)
     FROM watch_history
     WHERE started_at >= $1::date AND started_at < $1::date + 1
     GROUP BY anime_id
     ON CONFLICT (day, anime_id) DO UPDATE SET
       unique_viewers = excluded.unique_viewers,
       minutes_watched = excluded.minutes_watched,
       completions = excluded.completions`,
    [day]
  )
}

export async function recomputeTrending (): Promise<void> {
  await _recomputeTrending()
  const top = await query<{ canonical_title: string }>(
    'SELECT canonical_title FROM anime WHERE trending > 0 ORDER BY trending DESC LIMIT 5'
  )
  if (top.length) await emitEvent('stats.trending', { top: top.map(t => t.canonical_title) })
}

async function _recomputeTrending (): Promise<void> {
  // trending = watch activity (7d, recency-weighted) + list adds (7d)
  await query(
    `UPDATE anime a SET trending = coalesce(sub.score, 0)
     FROM (
       SELECT anime_id, sum(weight)::int AS score FROM (
         SELECT anime_id, count(DISTINCT profile_id) * 10.0 / (1 + (now()::date - started_at::date)) AS weight
         FROM watch_history WHERE started_at > now() - interval '7 days'
         GROUP BY anime_id, started_at::date
         UNION ALL
         SELECT anime_id, count(*) * 5 AS weight
         FROM library_entries WHERE created_at > now() - interval '7 days'
         GROUP BY anime_id
       ) parts GROUP BY anime_id
     ) sub
     WHERE a.id = sub.anime_id`
  )
}

export async function handleStatsJob (job: Job): Promise<void> {
  const { profileId, rollupDay: day, trending, dailyDigest } = job.payload as { profileId?: string, rollupDay?: string, trending?: boolean, dailyDigest?: boolean }
  if (profileId) await recomputeProfileStats(profileId)
  if (day) await rollupDay(day)
  if (trending) await recomputeTrending()
  if (dailyDigest) await emitDailyDigest()
}

// daily digest webhook: platform-wide numbers for the previous day
export async function emitDailyDigest (): Promise<void> {
  const [users, watch, comments] = await Promise.all([
    query(`SELECT count(*) AS total,
                  count(*) FILTER (WHERE created_at > now() - interval '7 days') AS new_7d,
                  count(*) FILTER (WHERE last_login_at > now() - interval '1 day') AS active_1d
           FROM users WHERE deleted_at IS NULL`),
    query(`SELECT coalesce(sum(minutes_watched),0) AS minutes, coalesce(sum(completions),0) AS completions
           FROM watch_stats_daily WHERE day = current_date - 1`),
    query(`SELECT count(*) AS total FROM comments WHERE created_at > now() - interval '1 day'`)
  ])
  const u = users[0] as Record<string, string>
  const w = watch[0] as Record<string, string>
  await emitEvent('stats.daily', {
    day: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    users: u.total, newUsers7d: u.new_7d, active1d: u.active_1d,
    minutesWatched: w.minutes, completions: w.completions,
    comments: (comments[0] as Record<string, string>).total
  })
}
