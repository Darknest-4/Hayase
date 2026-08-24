/* global window, U, C, Store, Charts, T, I18n */
// Analytics — a personal "year in review" style dashboard computed entirely
// from the active profile's local library and watch history. Everything is
// derived on the client from Store.list() + Store.history(); no network calls.

const PageAnalytics = {
  // a fixed, theme-neutral palette reused across the donut charts
  PALETTE: ['#f43f6e', '#ff8fab', '#a78bfa', '#38bdf8', '#34d399', '#fbbf24', '#fb923c', '#f87171', '#818cf8', '#2dd4bf', '#e879f9', '#94a3b8'],

  // standalone route (kept as a fallback / deep-link target)
  render (root) {
    const profile = Store.activeProfile()
    root.append(C.spotlight(T('Analytics'), { subtitle: profile ? `${profile.avatar ?? ''} ${profile.name} · your viewing at a glance` : 'Your viewing at a glance' }))
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)
    this.body(pad)
  },

  // embeddable body — rendered on its own or inside the Profile hub tab
  body (pad) {
    const entries = Object.values(Store.list())
    const history = Store.history()

    if (!entries.length && !history.length) {
      pad.append(U.el('div', { class: 'empty-state', text: T('No data yet on this profile. Add anime to your library and watch a few episodes — your analytics build up here automatically.') }))
      return
    }

    // ---- headline stats ----
    const episodesWatched = entries.reduce((s, e) => s + (e.progress ?? 0), 0)
    // Measured, not estimated. This used to be `progress * nominal runtime`,
    // which credited a flat 24 minutes the instant an episode was marked —
    // so the number grew by watching nothing. WatchTime.minutesFor() uses
    // real playback seconds and only falls back to the old estimate for
    // episodes credited before the meter existed.
    const watch = window.WatchTime.minutesFor(entries)
    const minutes = watch.totalMinutes
    const completed = entries.filter(e => e.status === 'COMPLETED').length
    const scored = entries.filter(e => e.score > 0)
    const mean = scored.length ? (scored.reduce((s, e) => s + e.score, 0) / scored.length).toFixed(1) : '—'
    const hours = Math.floor(minutes / 60)
    const watchTime = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${minutes % 60}m`

    pad.append(U.el('div', { class: 'stat-cards' }, [
      ['Watch time', watchTime],
      ['Episodes', episodesWatched.toLocaleString(I18n.locale())],
      ['In library', String(entries.length)],
      ['Completed', String(completed)],
      ['Mean score', mean],
      ['Days active', String(this._activeDays(history))]
    ].map(([label, value]) => U.el('div', { class: 'stat-card' }, [
      U.el('b', { text: value }),
      U.el('span', { text: label })
    ]))))

    // ---- weekly activity (episodes watched per day, last 14 days) ----
    this._section(pad, 'Activity', 'Episodes watched per day over the last two weeks.')
    pad.append(this._panel(Charts.bars(this._weekly(history), { label: T('Episodes watched per day') })))

    // ---- two-up: genre donut + format donut ----
    const twoUp = U.el('div', { class: 'analytics-grid' })
    pad.append(twoUp)

    const genres = this._genreBreakdown(entries)
    twoUp.append(this._card('Top genres', genres.length
      ? Charts.donut(genres.slice(0, 8).map((g, i) => ({ label: g.label, value: g.value, color: this.PALETTE[i % this.PALETTE.length] })), { label: T('Genre distribution') })
      : this._noData()))

    const formats = this._countBy(entries, e => U.format(e.media) || 'Unknown')
    twoUp.append(this._card('Formats', formats.length
      ? Charts.donut(formats.map((f, i) => ({ label: f.label, value: f.value, color: this.PALETTE[i % this.PALETTE.length] })), { label: T('Format distribution') })
      : this._noData()))

    // ---- status distribution ----
    const statuses = Object.entries(U.listStatusMap)
      .map(([status, label]) => ({ label, value: entries.filter(e => e.status === status).length }))
      .filter(s => s.value > 0)
    if (statuses.length) {
      this._section(pad, 'Library status', 'How your list breaks down across watching, completed, planning and more.')
      pad.append(this._panel(Charts.bars(statuses.map(s => ({ label: s.label.slice(0, 4), value: s.value })), { label: T('Status distribution') })))
    }

    // ---- score histogram ----
    if (scored.length) {
      this._section(pad, 'Score distribution', `Across ${scored.length} rated ${scored.length === 1 ? 'title' : 'titles'}.`)
      const buckets = Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), value: 0 }))
      for (const e of scored) {
        const b = Math.min(9, Math.max(0, Math.round(e.score) - 1))
        buckets[b].value++
      }
      pad.append(this._panel(Charts.bars(buckets, { label: T('Score histogram') })))
    }

    // ---- top studios ----
    const studios = this._studioBreakdown(entries)
    if (studios.length) {
      this._section(pad, 'Top studios', 'Studios you watch the most, by number of titles in your library.')
      pad.append(this._panel(Charts.ranked(studios.slice(0, 8), { label: T('Top studios') })))
    }
  },

  // ---- helpers ----

  _section (parent, title, sub) {
    parent.append(U.el('h2', { class: 'detail-section-title', style: 'margin-top:2rem;', text: title }))
    if (sub) parent.append(U.el('p', { class: 'list-row-sub', style: 'margin:-.35rem 0 .5rem;', text: sub }))
  },

  _panel (child) {
    return U.el('div', { class: 'chart-panel' }, [child])
  },

  _card (title, child) {
    return U.el('div', { class: 'chart-card' }, [
      U.el('h3', { class: 'chart-card-title', text: title }),
      child
    ])
  },

  _noData () {
    return U.el('div', { class: 'chart-empty', text: T('Not enough data yet.') })
  },

  _activeDays (history) {
    return new Set(history.map(h => new Date(h.at).toDateString())).size
  },

  _weekly (history) {
    const days = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000)
      days.push({ key: d.toDateString(), label: d.toLocaleDateString(I18n.locale(), { day: 'numeric' }), value: 0 })
    }
    const index = new Map(days.map(d => [d.key, d]))
    for (const h of history) {
      const bucket = index.get(new Date(h.at).toDateString())
      if (bucket) bucket.value++
    }
    return days
  },

  _genreBreakdown (entries) {
    return this._countBy(
      entries.flatMap(e => e.media?.genres ?? []),
      g => g
    )
  },

  _studioBreakdown (entries) {
    const counts = this._countBy(
      entries.map(e => e.media?.studios?.nodes?.[0]?.name).filter(Boolean),
      s => s
    )
    return counts.map(c => ({ label: c.label, value: c.value }))
  },

  // counts occurrences, returns [{label, value}] sorted desc
  _countBy (items, keyFn) {
    const map = new Map()
    for (const item of items) {
      const key = keyFn(item)
      if (!key) continue
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
  }
}

window.PageAnalytics = PageAnalytics
