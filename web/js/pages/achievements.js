/* global window, document, U, Store, T, I18n */
// Achievements & Badges — a catalogue of unlockable achievements whose
// conditions are evaluated on the client against the active profile's
// library and watch history. Mirrors the backend `achievements` table; the
// same slugs are used so a signed-in profile can reconcile server unlocks.

const PageAchievements = {
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

  render (root) {
    const profile = Store.activeProfile()
    root.append(window.C.spotlight(T('Achievements'), { subtitle: profile ? `${profile.avatar ?? ''} ${profile.name}` : null }))
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)
    this.body(pad)
  },

  body (pad) {
    const ctx = this._context()

    const evaluated = this.CATALOG.map(a => {
      const value = Math.max(0, Math.floor(a.value(ctx)))
      return { ...a, current: Math.min(value, a.target), unlocked: value >= a.target, pct: Math.min(100, Math.round(value / a.target * 100)) }
    })
    const unlockedCount = evaluated.filter(a => a.unlocked).length

    // level from XP (same model as profile page/backend)
    const xp = ctx.episodes * 10 + ctx.completed * 100 + unlockedCount * 50
    const level = Math.floor(Math.sqrt(xp / 100)) + 1
    const levelFloor = Math.pow(level - 1, 2) * 100
    const levelCeil = Math.pow(level, 2) * 100
    const levelPct = Math.round((xp - levelFloor) / (levelCeil - levelFloor) * 100)

    // ---- level + summary banner ----
    pad.append(U.el('div', { class: 'ach-banner' }, [
      U.el('div', { class: 'ach-level-badge', text: String(level) }),
      U.el('div', { style: 'flex-grow:1;min-width:12rem;' }, [
        U.el('div', { class: 'ach-level-title', text: `Level ${level}` }),
        U.el('div', { class: 'ach-level-xp', text: `${xp.toLocaleString(I18n.locale())} XP · ${(levelCeil - xp).toLocaleString(I18n.locale())} to next level` }),
        U.el('div', { class: 'ach-level-track' }, [U.el('div', { class: 'ach-level-fill', style: `width:${levelPct}%;` })])
      ]),
      U.el('div', { class: 'ach-count' }, [
        U.el('b', { text: `${unlockedCount}/${this.CATALOG.length}` }),
        U.el('span', { text: T('unlocked') })
      ])
    ]))

    // ---- grid ----
    const grid = U.el('div', { class: 'ach-grid' })
    pad.append(grid)

    // unlocked first, then by progress
    evaluated.sort((a, b) => (b.unlocked - a.unlocked) || (b.pct - a.pct))

    for (const a of evaluated) {
      grid.append(U.el('div', { class: 'ach-card' + (a.unlocked ? ' unlocked' : '') + ` tier-${a.tier}` }, [
        U.el('div', { class: 'ach-icon', text: a.icon }),
        U.el('div', { class: 'ach-body' }, [
          U.el('div', { class: 'ach-name' }, [
            document.createTextNode(a.name),
            U.el('span', { class: `ach-tier tier-${a.tier}`, text: a.tier })
          ]),
          U.el('div', { class: 'ach-desc', text: a.desc }),
          a.unlocked
            ? U.el('div', { class: 'ach-done', text: T('✓ Unlocked') })
            : U.el('div', { class: 'ach-progress-wrap' }, [
              U.el('div', { class: 'ach-progress-track' }, [U.el('div', { class: 'ach-progress-fill', style: `width:${a.pct}%;` })]),
              U.el('span', { class: 'ach-progress-text', text: `${a.current.toLocaleString(I18n.locale())} / ${a.target.toLocaleString(I18n.locale())}` })
            ])
        ])
      ]))
    }
  },

  // slugs currently unlocked for the active profile (used by notifications)
  unlockedSlugs () {
    const ctx = this._context()
    return this.CATALOG.filter(a => a.value(ctx) >= a.target).map(a => a.slug)
  },

  meta (slug) {
    return this.CATALOG.find(a => a.slug === slug)
  },

  // gather all the signals the catalogue conditions need, once
  _context () {
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
      minutes: entries.reduce((s, e) => s + (e.progress ?? 0) * (e.media?.duration || 24), 0),
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

window.PageAchievements = PageAchievements
