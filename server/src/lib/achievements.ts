// Achievements: what a profile has unlocked, decided by the server.
//
// ---------------------------------------------------------------------------
// Why the server decides
// ---------------------------------------------------------------------------
// The catalogue and its conditions have lived in the client since the
// achievements screen was written, evaluated against browser storage. That was
// the only option at the time — the server had no watch history, no favourites
// and no genre breakdown to evaluate against. It has all three now, so the
// question "has this profile watched 500 episodes" is one the server can
// answer from its own tables rather than one it has to take a client's word
// for. Nothing here is forgeable, because nothing here is reported.
//
// ---------------------------------------------------------------------------
// Where the definitions live
// ---------------------------------------------------------------------------
// Here, and served to the client over the API. The client keeps a copy to
// render from while signed out, and `web/test/achievements.test.mjs` fails if
// the two lists disagree — the same arrangement as the design tokens, for the
// same reason: two copies of a list are two lists.

import { query, queryOne } from '../db.ts'

export type Tier = 'bronze' | 'silver' | 'gold'

export interface Achievement {
  slug: string
  name: string
  description: string
  icon: string
  tier: Tier
  target: number
  /** Which measurement in the context this one counts. */
  metric: keyof AchievementContext
  xp: number
}

/** Everything the conditions need, measured once per evaluation. */
export interface AchievementContext {
  episodes: number
  minutes: number
  completed: number
  library: number
  planning: number
  favourites: number
  scored: number
  bestDay: number
  activeDays: number
  genreCount: number
  formatCount: number
}

/**
 * The catalogue.
 *
 * Each entry is a metric and a target rather than a predicate, so the same
 * definition can be evaluated here, rendered by the client, and compared
 * between the two by a test. A predicate would be none of those things.
 */
export const CATALOGUE: Achievement[] = [
  { slug: 'first-episode', name: 'First Steps', description: 'Watch your first episode.', icon: '▶️', tier: 'bronze', target: 1, metric: 'episodes', xp: 10 },
  { slug: 'getting-into-it', name: 'Getting Into It', description: 'Watch 50 episodes.', icon: '📺', tier: 'bronze', target: 50, metric: 'episodes', xp: 50 },
  { slug: 'binge-watcher', name: 'Binge Watcher', description: 'Watch 500 episodes.', icon: '🍿', tier: 'silver', target: 500, metric: 'episodes', xp: 200 },
  { slug: 'no-life', name: 'No Life', description: 'Watch 2,000 episodes.', icon: '🌀', tier: 'gold', target: 2000, metric: 'episodes', xp: 500 },
  { slug: 'first-finish', name: 'The End', description: 'Complete your first anime.', icon: '🎬', tier: 'bronze', target: 1, metric: 'completed', xp: 20 },
  { slug: 'collector', name: 'Collector', description: 'Complete 25 anime.', icon: '🏆', tier: 'silver', target: 25, metric: 'completed', xp: 150 },
  { slug: 'century-club', name: 'Century Club', description: 'Complete 100 anime.', icon: '💯', tier: 'gold', target: 100, metric: 'completed', xp: 400 },
  { slug: 'librarian', name: 'Librarian', description: 'Have 50 titles in your library.', icon: '📚', tier: 'silver', target: 50, metric: 'library', xp: 100 },
  { slug: 'planner', name: 'Planner', description: 'Plan to watch 20 titles.', icon: '🗓️', tier: 'bronze', target: 20, metric: 'planning', xp: 40 },
  { slug: 'curator', name: 'Curator', description: 'Favourite 10 titles.', icon: '❤️', tier: 'bronze', target: 10, metric: 'favourites', xp: 40 },
  { slug: 'critic', name: 'Critic', description: 'Rate 25 titles.', icon: '⭐', tier: 'silver', target: 25, metric: 'scored', xp: 100 },
  { slug: 'day-one', name: 'Day One', description: 'Watch a full day (24h) of anime.', icon: '⏳', tier: 'gold', target: 1440, metric: 'minutes', xp: 300 },
  { slug: 'marathon', name: 'Marathon', description: 'Watch 10 episodes in a single day.', icon: '🏃', tier: 'silver', target: 10, metric: 'bestDay', xp: 120 },
  { slug: 'consistent', name: 'Consistent', description: 'Be active on 7 different days.', icon: '📆', tier: 'silver', target: 7, metric: 'activeDays', xp: 120 },
  { slug: 'explorer', name: 'Explorer', description: 'Watch across 10 different genres.', icon: '🧭', tier: 'silver', target: 10, metric: 'genreCount', xp: 150 },
  { slug: 'omnivore', name: 'Omnivore', description: 'Watch every format (TV, Movie, OVA, ONA, Special).', icon: '🍱', tier: 'gold', target: 5, metric: 'formatCount', xp: 250 }
]

const EMPTY: AchievementContext = {
  episodes: 0, minutes: 0, completed: 0, library: 0, planning: 0,
  favourites: 0, scored: 0, bestDay: 0, activeDays: 0, genreCount: 0, formatCount: 0
}

/**
 * Measure a profile.
 *
 * One statement rather than eleven: every figure is a scalar sub-select over a
 * table this profile already owns rows in, and issuing them separately would
 * mean eleven round trips to answer one question.
 *
 * `bestDay` and `activeDays` are taken in UTC. A viewer near midnight in their
 * own timezone may see a day boundary fall differently than they expect; the
 * alternative is storing a timezone per profile and recomputing history
 * against it, which is a much larger thing than these two numbers are worth.
 */
export async function measure (profileId: string): Promise<AchievementContext> {
  const row = await queryOne<Record<string, string | null>>(
    `SELECT
       (SELECT count(*) FROM watch_history WHERE profile_id = $1 AND finished) AS episodes,
       (SELECT coalesce(sum(watched_sec), 0) / 60 FROM watch_history WHERE profile_id = $1) AS minutes,
       (SELECT count(*) FROM library_entries WHERE profile_id = $1 AND status = 'COMPLETED') AS completed,
       (SELECT count(*) FROM library_entries WHERE profile_id = $1) AS library,
       (SELECT count(*) FROM library_entries WHERE profile_id = $1 AND status = 'PLANNING') AS planning,
       (SELECT count(*) FROM favorites WHERE profile_id = $1) AS favourites,
       (SELECT count(*) FROM library_entries WHERE profile_id = $1 AND score > 0) AS scored,
       (SELECT coalesce(max(per_day), 0) FROM (
          SELECT count(*) AS per_day FROM watch_history
           WHERE profile_id = $1 AND finished
           GROUP BY date_trunc('day', started_at)
        ) d) AS "bestDay",
       (SELECT count(DISTINCT date_trunc('day', started_at)) FROM watch_history WHERE profile_id = $1) AS "activeDays",
       (SELECT count(DISTINCT ag.genre_id) FROM watch_history wh
          JOIN anime_genres ag ON ag.anime_id = wh.anime_id
         WHERE wh.profile_id = $1) AS "genreCount",
       -- TV_SHORT counts as TV: the screen offers five formats, not six.
       (SELECT count(DISTINCT CASE WHEN a.format = 'TV_SHORT' THEN 'TV' ELSE a.format::text END)
          FROM watch_history wh JOIN anime a ON a.id = wh.anime_id
         WHERE wh.profile_id = $1 AND a.format IS NOT NULL) AS "formatCount"`,
    [profileId]
  )
  if (!row) return { ...EMPTY }

  const out = { ...EMPTY }
  for (const key of Object.keys(EMPTY) as Array<keyof AchievementContext>) {
    out[key] = Number(row[key] ?? 0) || 0
  }
  return out
}

export interface Progress extends Achievement {
  current: number
  unlocked: boolean
  unlockedAt: string | null
}

/** The catalogue with this profile's progress against it. */
export function evaluate (context: AchievementContext, unlockedAt: Map<string, string>): Progress[] {
  return CATALOGUE.map(a => {
    const value = Math.max(0, Math.floor(context[a.metric] ?? 0))
    const already = unlockedAt.get(a.slug) ?? null
    return {
      ...a,
      current: Math.min(value, a.target),
      // Once unlocked, always unlocked. Removing a title from a library
      // should not take an achievement away — it was earned when it fired.
      unlocked: already !== null || value >= a.target,
      unlockedAt: already
    }
  })
}

/**
 * Evaluate and record anything newly earned.
 *
 * Returns the slugs that fired this time, so a caller can announce them. The
 * insert is idempotent, and XP is awarded through the same `xp_events` ledger
 * everything else uses — with the achievement's id as the reference, which is
 * what makes double-awarding impossible rather than merely unlikely.
 */
export async function grantNew (profileId: string): Promise<string[]> {
  const context = await measure(profileId)

  const rows = await query<{ slug: string, unlocked_at: string }>(
    `SELECT a.slug, pa.unlocked_at
       FROM profile_achievements pa
       JOIN achievements a ON a.id = pa.achievement_id
      WHERE pa.profile_id = $1`,
    [profileId]
  )
  const already = new Map(rows.map(r => [r.slug, r.unlocked_at]))

  const earned = CATALOGUE.filter(a =>
    !already.has(a.slug) && Math.floor(context[a.metric] ?? 0) >= a.target
  )
  if (!earned.length) return []

  const granted: string[] = []
  for (const achievement of earned) {
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO profile_achievements (profile_id, achievement_id)
       SELECT $1, id FROM achievements WHERE slug = $2
       ON CONFLICT DO NOTHING
       RETURNING achievement_id AS id`,
      [profileId, achievement.slug]
    )
    // No row means either a concurrent grant won the race or the catalogue
    // row is missing; either way this is not the call that earned it, and it
    // must not award the XP a second time.
    if (!inserted) continue

    if (achievement.xp > 0) {
      await query(
        `INSERT INTO xp_events (profile_id, amount, reason, ref_id) VALUES ($1, $2, 'achievement', $3)`,
        [profileId, achievement.xp, inserted.id]
      )
    }
    granted.push(achievement.slug)
  }
  return granted
}

/** Make sure the catalogue rows exist, so the grant above has ids to point at. */
export async function seedCatalogue (): Promise<number> {
  let written = 0
  for (const a of CATALOGUE) {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO achievements (slug, name, description, icon_key, xp_reward)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE
          SET name = EXCLUDED.name, description = EXCLUDED.description,
              icon_key = EXCLUDED.icon_key, xp_reward = EXCLUDED.xp_reward
       RETURNING id`,
      [a.slug, a.name, a.description, a.icon, a.xp]
    )
    if (row) written++
  }
  return written
}
