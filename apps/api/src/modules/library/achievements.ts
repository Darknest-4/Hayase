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
// render from while signed out, and `apps/web/test/achievements.test.mjs` fails if
// the two lists disagree — the same arrangement as the design tokens, for the
// same reason: two copies of a list are two lists.

import { query, queryOne } from '../../infrastructure/database/index.ts'

import { CATALOGUE, EMPTY } from './achievement-catalogue.ts'

import type { AchievementContext } from './achievement-catalogue.ts'

// Re-exported so every existing importer keeps working: the split is about
// what can be loaded without a database, not about where anything is called
// from. See achievement-catalogue.ts.
export { CATALOGUE, evaluate } from './achievement-catalogue.ts'
export type { Achievement, AchievementContext, Progress, Tier } from './achievement-catalogue.ts'

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

  // Two statements for the whole set rather than two per achievement.
  //
  // Normally this is one or two iterations and the difference is nothing. The
  // case it is written for is the founder import, which crosses every
  // threshold at once: that turned the catalogue into two round trips each,
  // inside one request.
  //
  // RETURNING is what keeps the race handled. A row that ON CONFLICT skipped
  // was granted by a concurrent call, comes back in neither list, and so earns
  // no XP here — which is the same rule as before, decided by the database
  // rather than by reading back.
  const inserted = await query<{ id: string, slug: string }>(
    `INSERT INTO profile_achievements (profile_id, achievement_id)
     SELECT $1, a.id FROM achievements a WHERE a.slug = ANY($2::text[])
     ON CONFLICT DO NOTHING
     RETURNING achievement_id AS id,
               (SELECT slug FROM achievements WHERE id = achievement_id) AS slug`,
    [profileId, earned.map(a => a.slug)]
  )
  if (!inserted.length) return []

  const xpFor = new Map(earned.map(a => [a.slug, a.xp]))
  const withXp = inserted.filter(row => (xpFor.get(row.slug) ?? 0) > 0)
  if (withXp.length) {
    await query(
      `INSERT INTO xp_events (profile_id, amount, reason, ref_id)
       SELECT $1, event.amount, 'achievement', event.ref_id
         FROM unnest($2::int[], $3::uuid[]) AS event(amount, ref_id)`,
      [profileId, withXp.map(row => xpFor.get(row.slug) ?? 0), withXp.map(row => row.id)]
    )
  }
  return inserted.map(row => row.slug)
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
