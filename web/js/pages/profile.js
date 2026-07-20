/* global window, document, U, C, Store, PageAnalytics, PageAchievements, PageHistory */
// Profile — a hub for everything personal to the active profile. Overview
// shows identity + headline stats; the Analytics, Achievements and History
// tabs embed those modules' bodies so they don't need their own routes.

const PageProfile = {
  TABS: [
    { key: 'overview', label: 'Overview' },
    { key: 'analytics', label: 'Analytics' },
    { key: 'achievements', label: 'Achievements' },
    { key: 'history', label: 'History' }
  ],

  render (root, params) {
    const profile = Store.activeProfile()
    const name = profile?.name ?? Store.settings().profileName ?? 'Dreamer'

    // level for the header subtitle
    const entries = Object.values(Store.list())
    const episodesWatched = entries.reduce((s, e) => s + (e.progress ?? 0), 0)
    const xp = episodesWatched * 10 + entries.filter(e => e.status === 'COMPLETED').length * 100
    const level = Math.floor(Math.sqrt(xp / 100)) + 1

    root.append(C.spotlight(name, { subtitle: `Level ${level} · ${xp.toLocaleString()} XP · ${entries.length} in library` }))

    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    const active = params.get('tab') ?? 'overview'
    const tabs = U.el('div', { class: 'tabs' })
    for (const t of this.TABS) {
      tabs.append(U.el('a', {
        class: 'tab' + (t.key === active ? ' active' : ''),
        href: t.key === 'overview' ? '#/profile' : `#/profile?tab=${t.key}`
      }, [document.createTextNode(t.label)]))
    }
    pad.append(tabs)

    const content = U.el('div', { style: 'margin-top:1.25rem;' })
    pad.append(content)

    if (active === 'analytics') PageAnalytics.body(content)
    else if (active === 'achievements') PageAchievements.body(content)
    else if (active === 'history') PageHistory.body(content)
    else this.overview(content)
  },

  overview (pad) {
    const entries = Object.values(Store.list())
    const favs = Store.favourites()

    const completed = entries.filter(e => e.status === 'COMPLETED')
    const episodesWatched = entries.reduce((sum, e) => sum + (e.progress ?? 0), 0)
    const minutesWatched = entries.reduce((s, e) => s + (e.progress ?? 0) * (e.media?.duration || 24), 0)
    const scored = entries.filter(e => e.score > 0)
    const meanScore = scored.length ? (scored.reduce((sum, e) => sum + e.score, 0) / scored.length).toFixed(1) : null

    const hours = Math.floor(minutesWatched / 60)
    const statDefs = [
      [String(entries.length), 'Anime in library'],
      [String(completed.length), 'Completed'],
      [episodesWatched.toLocaleString(), 'Episodes watched'],
      [hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`, 'Watch time'],
      [meanScore ?? '—', 'Mean score'],
      [String(favs.length), 'Favourites']
    ]
    pad.append(U.el('div', { class: 'stat-cards', style: 'margin-top:0;' },
      statDefs.map(([value, label]) => U.el('div', { class: 'stat-card' }, [
        U.el('b', { text: value }),
        U.el('span', { text: label })
      ]))))

    // ---- status breakdown ----
    pad.append(U.el('h2', { class: 'detail-section-title', text: 'Library breakdown' }))
    const statuses = Object.entries(U.listStatusMap)
      .map(([status, label]) => [label, entries.filter(e => e.status === status).length, status])
      .filter(([, count]) => count > 0)

    if (!statuses.length) {
      pad.append(U.el('div', { class: 'empty-state', text: 'Your library is empty — add some anime and your stats will grow here.' }))
      return
    }

    const statusToken = {
      CURRENT: 'watching', REPEATING: 'watching', PLANNING: 'planning',
      COMPLETED: 'completed', PAUSED: 'paused', DROPPED: 'dropped'
    }
    const max = Math.max(...statuses.map(([, count]) => count))
    const bars = U.el('div', { class: 'genre-bars' })
    for (const [label, count, status] of statuses) {
      bars.append(U.el('div', { class: 'genre-bar' }, [
        U.el('span', { class: 'genre-name', text: label }),
        U.el('div', { class: 'genre-track' }, [
          U.el('div', { class: 'genre-fill', style: `width:${count / max * 100}%;background:var(--status-${statusToken[status]});` })
        ]),
        U.el('span', { class: 'genre-count', text: String(count) })
      ]))
    }
    pad.append(bars)

    // ---- recently updated ----
    const recent = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10)
    if (recent.length) {
      pad.append(U.el('h2', { class: 'detail-section-title', text: 'Recent activity' }))
      const row = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;' })
      for (const entry of recent) {
        row.append(C.card(entry.media, {
          subline: `${U.listStatusMap[entry.status]}${entry.progress ? ` • Ep ${entry.progress}` : ''}`
        }))
      }
      pad.append(row)
    }
  }
}

window.PageProfile = PageProfile
