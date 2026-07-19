// Stats worker: incremental rollups from watch_history and xp_events.
// Jobs:
//   { profileId }         → recompute profile_stats for one profile
//   { rollupDay: 'YYYY-MM-DD' } → recompute watch_stats_daily for a day
//   { trending: true }    → recompute anime.trending from recent activity

import { query } from '../db.ts'

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
  const { profileId, rollupDay: day, trending } = job.payload as { profileId?: string, rollupDay?: string, trending?: boolean }
  if (profileId) await recomputeProfileStats(profileId)
  if (day) await rollupDay(day)
  if (trending) await recomputeTrending()
}
