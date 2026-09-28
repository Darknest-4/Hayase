// Az eredmények katalógusa és helyi kiértékelése — rajzolás nélkül.
//
// KÜLÖN MODULBAN, mert a keretnek is kell: az értesítések jelvénye (Store
// `syncNotifications`) minden oldalon megkérdezi, mi van feloldva. Eddig ezért
// az egész eredményképernyő — a rajzolóval, a könyvtár-szinkronnal, a profil-
// statisztikával és a szintgörbével — minden oldalbetöltéssel megérkezett, a
// kijelentkezett kezdőlapon is. A képernyő (`achievements.js`) innen olvas.
//
// A definíciók a kiszolgálóé másolatai; a `test/achievements.test.mjs` elbukik,
// ha a kettő elcsúszik.

import { Store } from '../../shared/state/store.js'
import { WatchTime } from '../watch-history/watch-time.js'

export const AchievementCatalog = {
  // Each achievement: { slug, name, desc, icon, tier, target, value(ctx) }
  // `value(ctx)` returns current progress toward `target`; unlocked when >=.
  CATALOG: [
    { slug: 'first-episode', name: 'First Steps', desc: 'Watch your first episode.', icon: '▶️', tier: 'bronze', target: 1, value: c => c.episodes },
    { slug: 'getting-into-it', name: 'Getting Into It', desc: 'Watch 50 episodes.', icon: '📺', tier: 'bronze', target: 50, value: c => c.episodes },
    { slug: 'binge-watcher', name: 'Binge Watcher', desc: 'Watch 500 episodes.', icon: '🍿', tier: 'silver', target: 500, value: c => c.episodes },
    { slug: 'no-life', name: 'No Life', desc: 'Watch 2,000 episodes.', icon: '🌀', tier: 'gold', target: 2000, value: c => c.episodes },
    { slug: 'first-finish', name: 'The End', desc: 'Complete your first anime.', icon: '🎬', tier: 'bronze', target: 1, value: c => c.completed },
    { slug: 'collector', name: 'Collector', desc: 'Complete 25 anime.', icon: '🏆', tier: 'silver', target: 25, value: c => c.completed },
    { slug: 'century-club', name: 'Century Club', desc: 'Complete 100 anime.', icon: '💯', tier: 'gold', target: 100, value: c => c.completed },
    { slug: 'librarian', name: 'Librarian', desc: 'Have 50 titles in your library.', icon: '📚', tier: 'silver', target: 50, value: c => c.library },
    { slug: 'planner', name: 'Planner', desc: 'Plan to watch 20 titles.', icon: '🗓️', tier: 'bronze', target: 20, value: c => c.planning },
    { slug: 'curator', name: 'Curator', desc: 'Favourite 10 titles.', icon: '❤️', tier: 'bronze', target: 10, value: c => c.favourites },
    { slug: 'critic', name: 'Critic', desc: 'Rate 25 titles.', icon: '⭐', tier: 'silver', target: 25, value: c => c.scored },
    { slug: 'day-one', name: 'Day One', desc: 'Watch a full day (24h) of anime.', icon: '⏳', tier: 'gold', target: 24 * 60, value: c => c.minutes },
    { slug: 'marathon', name: 'Marathon', desc: 'Watch 10 episodes in a single day.', icon: '🏃', tier: 'silver', target: 10, value: c => c.bestDay },
    { slug: 'consistent', name: 'Consistent', desc: 'Be active on 7 different days.', icon: '📆', tier: 'silver', target: 7, value: c => c.activeDays },
    { slug: 'explorer', name: 'Explorer', desc: 'Watch across 10 different genres.', icon: '🧭', tier: 'silver', target: 10, value: c => c.genreCount },
    { slug: 'omnivore', name: 'Omnivore', desc: 'Watch every format (TV, Movie, OVA, ONA, Special).', icon: '🍱', tier: 'gold', target: 5, value: c => c.formatCount }
  ],

  /** Minden eredmény a helyi adatokon: { ...definíció, current, unlocked, pct }. */
  evaluate () {
    const ctx = this.context()
    return this.CATALOG.map(a => {
      const value = Math.max(0, Math.floor(a.value(ctx)))
      return { ...a, current: Math.min(value, a.target), unlocked: value >= a.target, pct: Math.min(100, Math.round(value / a.target * 100)) }
    })
  },

  // slugs currently unlocked for the active profile (used by notifications)
  unlockedSlugs () {
    const ctx = this.context()
    return this.CATALOG.filter(a => a.value(ctx) >= a.target).map(a => a.slug)
  },

  meta (slug) {
    return this.CATALOG.find(a => a.slug === slug)
  },

  // gather all the signals the catalogue conditions need, once
  context () {
    const entries = Object.values(Store.list())
    const history = Store.history()
    const episodes = entries.reduce((s, e) => s + (e.progress ?? 0), 0)

    // best single-day episode count from history
    const perDay = new Map()
    for (const h of history) {
      const key = new Date(h.at).toDateString()
      perDay.set(key, (perDay.get(key) ?? 0) + 1)
    }
    const bestDay = perDay.size ? Math.max(...perDay.values()) : 0

    const genres = new Set(entries.flatMap(e => e.media?.genres ?? []))
    const formats = new Set(entries.map(e => e.media?.format).filter(f => ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'].includes(f))
      .map(f => f === 'TV_SHORT' ? 'TV' : f))

    return {
      episodes,
      // Measured, not estimated. This used to be `progress * nominal runtime`,
      // which credited a flat 24 minutes the instant an episode was marked —
      // so the number grew by watching nothing. WatchTime.minutesFor() uses
      // real playback seconds and only falls back to the old estimate for
      // episodes credited before the meter existed.
      minutes: WatchTime.minutesFor(entries).totalMinutes,
      completed: entries.filter(e => e.status === 'COMPLETED').length,
      library: entries.length,
      planning: entries.filter(e => e.status === 'PLANNING').length,
      favourites: Store.favourites().length,
      scored: entries.filter(e => e.score > 0).length,
      bestDay,
      activeDays: perDay.size,
      genreCount: genres.size,
      formatCount: formats.size
    }
  }
}
