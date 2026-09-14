// The achievement catalogue and how it is scored — no database, on purpose.
//
// This is the half of `achievements.ts` that is a list and a pure function.
// It was in the same file as `measure()` and `grantNew()`, which import the
// connection pool, and that made the definitions unreachable to anything that
// is not a running server: `apps/web/test/achievements.test.mjs` exists to
// stop the client's copy of this list drifting from it, and importing it
// dragged in `@yume/database` and failed with ERR_MODULE_NOT_FOUND on a
// checkout where `npm ci` had not been run. One of twenty-three web tests
// needing a Postgres client to compare two arrays.
//
// Split rather than stubbed. `achievements.ts` re-exports everything here, so
// nothing that imported it before had to change, and the rule that keeps the
// two catalogues honest is now enforceable from either side.

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

/** Every measurement at zero — the shape `measure()` fills, and its fallback. */
export const EMPTY: AchievementContext = {
  episodes: 0, minutes: 0, completed: 0, library: 0, planning: 0,
  favourites: 0, scored: 0, bestDay: 0, activeDays: 0, genreCount: 0, formatCount: 0
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
