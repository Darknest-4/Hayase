// The administration overview, as one query set.
//
// The old endpoint answered six counts and a top-five list. The dashboard it
// feeds now wants ten figures with a comparison each, two daily series, the
// job queue's shape and a recent-activity feed — and every one of them has to
// be a real measurement. A dashboard that invents a trend is worse than one
// that omits it: it is read as fact and acted on.
//
// So the rule here is that a comparison is only returned when there is
// something to compare against. Cumulative counters (users, anime, comments)
// compare the total now against the total at the start of the window, which is
// growth. Windowed counters (new users, minutes watched, completions) compare
// this window against the one before it. Instantaneous gauges — pending jobs,
// dead jobs — get no comparison at all, because the past value was never
// recorded and there is no honest way to produce one.

import { query, queryOne } from '../db.ts'

export interface Kpi {
  key: string
  label: string
  value: number
  /** 'count' | 'hours' — the client formats, the server does not. */
  unit: 'count' | 'hours'
  /** What it was, when that is knowable. */
  previous: number | null
  /** Percent change, or null when there is nothing honest to say. */
  delta: number | null
  /** What the comparison is against, for the caption under the number. */
  compare: string | null
}

/** Percent change, guarding the two cases that are not a percentage. */
function delta (current: number, previous: number | null): number | null {
  if (previous === null) return null
  // From nothing to something is not "infinity percent"; from nothing to
  // nothing is not "zero percent growth". Both are better said in words by the
  // client, which gets `previous` to say them with.
  if (previous === 0) return current === 0 ? 0 : null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

interface Row { [key: string]: unknown }
const num = (row: Row | undefined | null, key: string): number => Number(row?.[key] ?? 0)

/**
 * Everything the overview screen draws, in one round trip.
 *
 * `days` is the comparison window. Every figure that has one uses the same
 * window, so the captions on the cards are all true of the same period — a
 * dashboard whose cards silently compare against different spans is a set of
 * numbers that cannot be read together.
 */
export async function overview (days = 7): Promise<{
  range: { days: number, from: string, to: string }
  kpis: Kpi[]
  series: { users: Array<Record<string, unknown>>, content: Array<Record<string, unknown>> }
  jobs: Record<string, unknown>
  activity: Array<Record<string, unknown>>
  trending: Array<Record<string, unknown>>
}> {
  const window = `${days} days`

  const [users, content, watch, jobs, series, contentSeries, activity, trending] = await Promise.all([
    queryOne<Row>(
      `SELECT count(*)                                                                   AS total,
              count(*) FILTER (WHERE created_at <= now() - $1::interval)                 AS total_before,
              count(*) FILTER (WHERE created_at > now() - $1::interval)                  AS new_window,
              count(*) FILTER (WHERE created_at <= now() - $1::interval
                                 AND created_at >  now() - ($1::interval * 2))            AS new_previous,
              count(*) FILTER (WHERE last_login_at > now() - interval '1 day')            AS active_1d,
              count(*) FILTER (WHERE last_login_at <= now() - interval '1 day'
                                 AND last_login_at >  now() - interval '2 days')          AS active_1d_previous
         FROM users WHERE deleted_at IS NULL`, [window]),

    queryOne<Row>(
      `SELECT (SELECT count(*) FROM anime)                                               AS anime,
              (SELECT count(*) FROM anime WHERE created_at <= now() - $1::interval)       AS anime_before,
              (SELECT count(*) FROM episodes)                                            AS episodes,
              (SELECT count(*) FROM episodes WHERE visibility = 'public')                AS episodes_public,
              (SELECT count(*) FROM comments WHERE hidden_at IS NULL)                    AS comments,
              (SELECT count(*) FROM comments
                WHERE hidden_at IS NULL AND created_at <= now() - $1::interval)          AS comments_before,
              (SELECT count(*) FROM reports WHERE status = 'open')                       AS open_reports,
              (SELECT count(*) FROM reports
                WHERE created_at <= now() - $1::interval
                  AND created_at >  now() - ($1::interval * 2))                          AS reports_previous,
              (SELECT count(*) FROM video_sources WHERE enabled)                         AS sources,
              (SELECT count(DISTINCT episode_id) FROM video_sources WHERE enabled)       AS episodes_playable`, [window]),

    queryOne<Row>(
      `SELECT coalesce(sum(minutes_watched) FILTER (WHERE day > current_date - $1::int), 0)      AS minutes,
              coalesce(sum(minutes_watched) FILTER (WHERE day <= current_date - $1::int), 0)     AS minutes_previous,
              coalesce(sum(completions)     FILTER (WHERE day > current_date - $1::int), 0)      AS completions,
              coalesce(sum(completions)     FILTER (WHERE day <= current_date - $1::int), 0)     AS completions_previous
         FROM watch_stats_daily WHERE day > current_date - ($1::int * 2)`, [days]),

    queryOne<Row>(
      `SELECT count(*) FILTER (WHERE done_at IS NULL AND attempts < max_attempts)         AS pending,
              count(*) FILTER (WHERE done_at IS NULL AND locked_at IS NOT NULL
                                 AND attempts < max_attempts)                             AS running,
              count(*) FILTER (WHERE done_at IS NULL AND attempts >= max_attempts)        AS dead,
              count(*) FILTER (WHERE done_at IS NOT NULL)                                 AS completed,
              count(*) FILTER (WHERE last_error IS NOT NULL)                              AS failed
         FROM jobs`),

    // Daily actives, from sessions rather than from users.last_login_at: that
    // column holds one timestamp, so it can say who is active now and nothing
    // about any earlier day.
    query<Row>(
      `SELECT d.day::date AS day, count(DISTINCT s.user_id)::int AS active
         FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') AS d(day)
         LEFT JOIN sessions s ON s.created_at >= d.day AND s.created_at < d.day + interval '1 day'
        GROUP BY d.day ORDER BY d.day`, [days]),

    query<Row>(
      `WITH days AS (
         SELECT generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date AS day
       ),
       a AS (SELECT created_at::date AS day, count(*)::int AS n FROM anime
              WHERE created_at >= current_date - ($1::int - 1) GROUP BY 1),
       e AS (SELECT created_at::date AS day, count(*)::int AS n FROM episodes
              WHERE created_at >= current_date - ($1::int - 1) GROUP BY 1),
       c AS (SELECT created_at::date AS day, count(*)::int AS n FROM comments
              WHERE created_at >= current_date - ($1::int - 1) GROUP BY 1)
       SELECT d.day,
              coalesce(a.n, 0) AS anime,
              coalesce(e.n, 0) AS episodes,
              coalesce(c.n, 0) AS comments
         FROM days d
         LEFT JOIN a ON a.day = d.day
         LEFT JOIN e ON e.day = d.day
         LEFT JOIN c ON c.day = d.day
        ORDER BY d.day`, [days]),

    // What actually happened, from the audit trail. Not a synthesised feed:
    // every row here is something somebody did that was recorded at the time.
    query<Row>(
      `SELECT a.id, a.action, a.subject_type, a.subject_id, a.after, a.created_at,
              u.username AS actor
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.created_at > now() - interval '30 days'
        ORDER BY a.created_at DESC
        LIMIT 12`),

    query<Row>('SELECT id, canonical_title, trending, popularity FROM anime WHERE trending > 0 ORDER BY trending DESC LIMIT 6')
  ])

  const recentJobs = await query<Row>(
    `SELECT id, queue, attempts, max_attempts, created_at, done_at, locked_at,
            left(coalesce(last_error, ''), 160) AS last_error
       FROM jobs ORDER BY coalesce(done_at, locked_at, created_at) DESC LIMIT 6`)

  const kpi = (
    key: string, label: string, value: number, previous: number | null,
    compare: string | null, unit: Kpi['unit'] = 'count'
  ): Kpi => ({ key, label, value, unit, previous, delta: delta(value, previous), compare })

  const period = `previous ${days} days`
  const since = `${days} days ago`

  return {
    range: {
      days,
      from: new Date(Date.now() - days * 86_400_000).toISOString(),
      to: new Date().toISOString()
    },
    kpis: [
      kpi('users', 'Users', num(users, 'total'), num(users, 'total_before'), since),
      kpi('users_new', `New (${days}d)`, num(users, 'new_window'), num(users, 'new_previous'), period),
      kpi('active', 'Active (24h)', num(users, 'active_1d'), num(users, 'active_1d_previous'), 'previous 24h'),
      kpi('anime', 'Anime', num(content, 'anime'), num(content, 'anime_before'), since),
      kpi('episodes', 'Episodes', num(content, 'episodes'), null, null),
      kpi('playable', 'Playable', num(content, 'episodes_playable'), null, null),
      kpi('comments', 'Comments', num(content, 'comments'), num(content, 'comments_before'), since),
      kpi('reports', 'Open reports', num(content, 'open_reports'), null, null),
      kpi('watched', `Watched (${days}d)`, Math.round(num(watch, 'minutes') / 60), Math.round(num(watch, 'minutes_previous') / 60), period, 'hours'),
      kpi('finished', `Episodes finished (${days}d)`, num(watch, 'completions'), num(watch, 'completions_previous'), period),
      // Gauges. No comparison: the earlier value was never recorded, and
      // producing one would mean making it up.
      kpi('jobs_pending', 'Pending jobs', num(jobs, 'pending'), null, null),
      kpi('jobs_dead', 'Dead jobs', num(jobs, 'dead'), null, null)
    ],
    series: { users: series, content: contentSeries },
    jobs: { ...(jobs ?? {}), recent: recentJobs },
    activity,
    trending
  }
}
