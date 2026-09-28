// Watch progress: the one place a "you are at 12:34 of episode 5" is written.
//
// Both the REST route (PATCH /v1/me/progress/:episodeId) and the GraphQL
// `saveProgress` mutation call this. They used to carry their own copies, and
// the copies drifted: the GraphQL one wrote no watch history and awarded no
// XP, so the same action counted or did not depending on which API a client
// happened to use.
//
// One transaction, three statements, for what used to be six to eight
// separate round trips on every tick of the player:
//
//   1. the progress upsert, which also proves the episode exists;
//   2. the watch-history session — continued if one is open, opened if not;
//   3. the XP award, only for a newly finished session and under a daily cap.
//
// The advisory lock serialises two ticks for the same profile and episode.
// Without it both could find no open session and open two.

import { transaction } from '../../infrastructure/database/index.ts'
import { enqueue } from '../../infrastructure/queue/index.ts'

export interface ProgressInput {
  profileId: string
  episodeId: string
  positionSec: number
  durationSec?: number | null | undefined
  /** The client says the episode is finished (an embed player cannot report position). */
  completed?: boolean | undefined
}

export interface ProgressResult {
  animeId: string
  episodeId: string
  positionSec: number
  durationSec: number | null
  completed: boolean
  updatedAt: string
}

/**
 * How many episodes a profile can earn XP for in a day.
 *
 * Position and completion are claimed by the client, so without a ceiling a
 * script could "finish" every episode in the catalogue in a minute and top the
 * leaderboard. Nobody watches a hundred episodes in a day; the cap never
 * touches a person and makes the shortcut worthless.
 */
const XP_EPISODES_PER_DAY = Number(process.env.XP_EPISODES_PER_DAY ?? 100)

/** What a completed episode is worth. */
const EPISODE_XP = 10

/** A watch-history session stays open this long between ticks. */
const SESSION_WINDOW = '6 hours'

/**
 * Whether the episode now counts as finished.
 *
 * The client measures the seconds the video actually played (position alone
 * would credit dragging the scrubber to the end), so its `completed` verdict
 * is the answer — accepted with a floor: a claim at a position under a minute
 * and under half the runtime is not a measurement but a malformed or forged
 * call. The floor is not a security boundary (a client that lies about
 * position can lie about anything); it stops an obviously wrong call from
 * writing history. XP is protected by the daily ceiling instead.
 *
 * A caller that sends a duration and no verdict is judged by position: 85%.
 */
export function isFinished (positionSec: number, durationSec: number | null | undefined, claimed: boolean | undefined): boolean {
  const known = durationSec != null && durationSec > 0
  if (claimed === true) return positionSec >= 60 || (known && positionSec / durationSec >= 0.5)
  return known && positionSec / durationSec >= 0.85
}

/** `null` when the episode does not exist. */
export async function recordProgress (input: ProgressInput): Promise<ProgressResult | null> {
  const completed = isFinished(input.positionSec, input.durationSec, input.completed)
  const watched = Math.round(input.positionSec)

  const outcome = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`progress:${input.profileId}:${input.episodeId}`])

    const progress = await client.query<{
      anime_id: string, position_sec: string, duration_sec: string | null, completed: boolean, updated_at: string
    }>(
      `INSERT INTO watch_progress (profile_id, episode_id, anime_id, position_sec, duration_sec, completed)
       SELECT $1, e.id, e.anime_id, $3, $4, $5 FROM episodes e WHERE e.id = $2
       ON CONFLICT (profile_id, episode_id) DO UPDATE SET
         position_sec = EXCLUDED.position_sec,
         duration_sec = coalesce(EXCLUDED.duration_sec, watch_progress.duration_sec),
         completed = watch_progress.completed OR EXCLUDED.completed,
         updated_at = now()
       RETURNING anime_id, position_sec, duration_sec, completed, updated_at`,
      [input.profileId, input.episodeId, input.positionSec, input.durationSec ?? null, completed]
    )
    const row = progress.rows[0]
    if (!row) return null

    /*
     * The watch-history session — opened by the first tick, not only by the
     * finish. Starts and finishes both matter: how many started an episode,
     * and where they stop, are the interesting questions, and neither can be
     * answered from finishes alone. One sitting is one row; the six-hour
     * window is what tells a pause from tomorrow's rewatch. `watched_sec`
     * never goes down — seeking back does not un-watch anything — and the
     * update names `started_at` as well as `id` because the table is
     * partitioned on it.
     */
    const history = await client.query<{ was_finished: boolean }>(
      `WITH open AS (
         SELECT id, started_at, finished FROM watch_history
          WHERE profile_id = $1 AND episode_id = $2 AND started_at > now() - interval '${SESSION_WINDOW}'
          ORDER BY started_at DESC
          LIMIT 1
       ), continued AS (
         UPDATE watch_history w
            SET watched_sec = GREATEST(w.watched_sec, $4),
                finished = w.finished OR $5,
                ended_at = CASE WHEN w.finished OR $5 THEN now() ELSE w.ended_at END
           FROM open
          WHERE w.id = open.id AND w.started_at = open.started_at
         RETURNING open.finished AS was_finished
       ), opened AS (
         INSERT INTO watch_history (profile_id, episode_id, anime_id, watched_sec, finished, started_at, ended_at)
         SELECT $1, $2, $3, $4, $5, now(), CASE WHEN $5 THEN now() END
          WHERE NOT EXISTS (SELECT 1 FROM open)
         RETURNING false AS was_finished
       )
       SELECT was_finished FROM continued UNION ALL SELECT was_finished FROM opened`,
      [input.profileId, input.episodeId, row.anime_id, watched, completed]
    )
    const newlyFinished = completed && history.rows[0]?.was_finished === false

    if (newlyFinished) {
      await client.query(
        `INSERT INTO xp_events (profile_id, amount, reason, ref_id)
         SELECT $1, $3, 'episode_watched', $2
          WHERE (SELECT count(*) FROM xp_events
                  WHERE profile_id = $1 AND reason = 'episode_watched'
                    AND created_at > now() - interval '24 hours') < $4`,
        [input.profileId, input.episodeId, EPISODE_XP, XP_EPISODES_PER_DAY]
      )
    }
    return { row, newlyFinished }
  })

  if (!outcome) return null
  if (outcome.newlyFinished) {
    // After the commit: a stats job must never see the transaction half done.
    await enqueue('stats', { profileId: input.profileId, dedupe: `profile:${input.profileId}` })
  }
  const { row } = outcome
  return {
    animeId: row.anime_id,
    episodeId: input.episodeId,
    positionSec: Number(row.position_sec),
    durationSec: row.duration_sec == null ? null : Number(row.duration_sec),
    completed: row.completed,
    updatedAt: row.updated_at
  }
}
