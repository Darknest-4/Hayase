/* global window, document, U, C, Store */
// Profile page — identity card + statistics computed from the local
// library and progress data (mirrors profile_stats on the backend).

const PageProfile = {
  render (root) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    const entries = Object.values(Store.list())
    const favs = Store.favourites()

    // ---- derived statistics ----
    const completed = entries.filter(e => e.status === 'COMPLETED')
    const episodesWatched = entries.reduce((sum, e) => sum + (e.progress ?? 0), 0)
    // 24 min average runtime — same assumption the backend stats worker uses
    // until per-episode durations are synced
    const minutesWatched = episodesWatched * 24
    const scored = entries.filter(e => e.score > 0)
    const meanScore = scored.length ? (scored.reduce((sum, e) => sum + e.score, 0) / scored.length).toFixed(1) : null

    // XP model matches the backend: 10 xp / episode, 100 / completion
    const xp = episodesWatched * 10 + completed.length * 100
    const level = Math.floor(Math.sqrt(xp / 100)) + 1
    const nextLevelXp = Math.pow(level, 2) * 100

    const name = Store.settings().profileName ?? 'Dreamer'

    pad.append(U.el('div', { class: 'profile-head' }, [
      U.el('div', { class: 'profile-avatar', text: name.slice(0, 1).toUpperCase() }),
      U.el('div', {}, [
        U.el('h1', { class: 'profile-name', text: name }),
        U.el('div', { class: 'profile-level', text: `Level ${level} • ${xp.toLocaleString()} / ${nextLevelXp.toLocaleString()} XP` })
      ])
    ]))

    const hours = Math.floor(minutesWatched / 60)
    const statDefs = [
      [String(entries.length), 'Anime in library'],
      [String(completed.length), 'Completed'],
      [String(episodesWatched.toLocaleString()), 'Episodes watched'],
      [hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`, 'Watch time'],
      [meanScore ?? '—', 'Mean score'],
      [String(favs.length), 'Favourites']
    ]
    pad.append(U.el('div', { class: 'stat-cards' },
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
