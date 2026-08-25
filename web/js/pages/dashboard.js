/* global window, document, U, C, Store, T, I18n */
// Dashboard — a personal landing overview assembled from local data. Widgets
// can be reordered and toggled (Edit layout); the layout persists per profile
// in settings.dashboard. Everything renders from Store snapshots, so the
// dashboard works offline with no network calls.

const PageDashboard = {
  // registry: order here is the default order
  WIDGETS: [
  // Labels are stored in English and translated where they are rendered, not
  // here: this literal is evaluated once when the script loads, so a T() call
  // in it would freeze the label in whatever language was active at boot and
  // never follow a language switch.
    { key: 'continue', label: 'Continue watching' },
    { key: 'airing', label: 'Airing soon' },
    { key: 'stats', label: 'Quick stats' },
    { key: 'achievements', label: 'Almost there' },
    { key: 'notifications', label: 'Latest notifications' },
    { key: 'genres', label: 'Top genres' }
  ],

  render (root, params) {
    const editing = params.get('edit') === '1'
    const profile = Store.activeProfile()
    const layout = this._layout()

    root.append(window.C.spotlight(`${this._greeting()}, ${profile?.name ?? 'Dreamer'}`, {
      subtitle: T('Your dashboard'),
      actions: U.el('a', {
        class: 'btn btn-secondary btn-sm',
        style: 'margin-top:.8rem;',
        href: editing ? '#/dashboard' : '#/dashboard?edit=1'
      }, [document.createTextNode(editing ? '✓ Done' : '⚙ Edit layout')])
    }))

    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    if (editing) {
      pad.append(this._editor(layout))
      return
    }

    const enabled = layout.filter(w => w.enabled)
    if (!enabled.length) {
      pad.append(U.el('div', { class: 'empty-state', text: T('No widgets enabled. Use “Edit layout” to add some.') }))
      return
    }

    let rendered = 0
    for (const w of enabled) {
      const node = (this['_widget_' + w.key] ?? (() => null)).call(this)
      if (node) { pad.append(node); rendered++ }
    }
    if (!rendered) {
      pad.append(U.el('div', { class: 'empty-state', text: T('Nothing to show yet — add anime to your library and your dashboard fills in automatically.') }))
    }
  },

  // ---- layout persistence ----
  _layout () {
    const saved = Store.settings().dashboard
    if (!Array.isArray(saved)) return this.WIDGETS.map(w => ({ key: w.key, enabled: true }))
    // reconcile with the registry so new widgets appear and stale ones drop
    const known = new Map(this.WIDGETS.map(w => [w.key, w]))
    const result = saved.filter(s => known.has(s.key)).map(s => ({ key: s.key, enabled: s.enabled !== false }))
    for (const w of this.WIDGETS) if (!result.some(r => r.key === w.key)) result.push({ key: w.key, enabled: true })
    return result
  },

  _saveLayout (layout) {
    Store.saveSettings({ dashboard: layout.map(w => ({ key: w.key, enabled: w.enabled })) })
  },

  _editor (layout) {
    const wrap = U.el('div', { class: 'dash-editor' })
    const meta = new Map(this.WIDGETS.map(w => [w.key, w]))
    const rerender = () => { this._saveLayout(layout); window.App.navigate() }

    layout.forEach((w, i) => {
      wrap.append(U.el('div', { class: 'dash-editor-row' }, [
        U.el('div', { class: 'dash-editor-name', text: meta.get(w.key) ? T(meta.get(w.key).label) : w.key }),
        U.el('div', { class: 'dash-editor-actions' }, [
          U.el('button', { class: 'btn btn-ghost btn-sm', disabled: i === 0 ? '' : null, title: T('Move up'), onclick: () => { [layout[i - 1], layout[i]] = [layout[i], layout[i - 1]]; rerender() } }, [document.createTextNode('↑')]),
          U.el('button', { class: 'btn btn-ghost btn-sm', disabled: i === layout.length - 1 ? '' : null, title: T('Move down'), onclick: () => { [layout[i + 1], layout[i]] = [layout[i], layout[i + 1]]; rerender() } }, [document.createTextNode('↓')]),
          U.el('label', { class: 'switch' }, [
            U.el('input', { type: 'checkbox', ...(w.enabled ? { checked: '' } : {}), onchange: e => { w.enabled = e.target.checked; rerender() } }),
            U.el('span', { class: 'slider' })
          ])
        ])
      ]))
    })
    return wrap
  },

  // ---- widgets ----

  _section (title, body, opts = {}) {
    const head = U.el('div', { class: 'dash-widget-head' }, [
      U.el('h2', { class: 'detail-section-title', style: 'margin:0;', text: title }),
      opts.link ? U.el('a', { class: 'dash-widget-link', href: opts.link, text: opts.linkText ?? 'See all →' }) : null
    ])
    return U.el('section', { class: 'dash-widget' }, [head, body])
  },

  _widget_continue () {
    const ids = Store.continueIds()
    const list = Store.list()
    const media = ids.map(id => list[id]?.media).filter(Boolean).slice(0, 12)
    if (!media.length) return null
    const row = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;' })
    for (const m of media) {
      const entry = list[m.id]
      row.append(C.card(m, { progress: entry ? { current: entry.progress, total: m.episodes } : null, subline: entry?.progress ? `Ep ${entry.progress}` : null }))
    }
    return this._section('Continue watching', row, { link: '#/list', linkText: 'Library →' })
  },

  _widget_airing () {
    const now = Date.now() / 1000
    const upcoming = Object.values(Store.list())
      .map(e => e.media)
      .filter(m => m?.nextAiringEpisode?.airingAt && m.nextAiringEpisode.airingAt > now)
      .sort((a, b) => a.nextAiringEpisode.airingAt - b.nextAiringEpisode.airingAt)
      .slice(0, 6)
    if (!upcoming.length) return null
    const rows = U.el('div', { class: 'dash-airing-list' })
    for (const m of upcoming) {
      rows.append(U.el('a', { class: 'list-row', href: `#/anime/${m.id}` }, [
        U.el('img', { src: m.coverImage?.large ?? '', alt: '', loading: 'lazy' }),
        U.el('div', { class: 'list-row-grow' }, [
          U.el('div', { class: 'list-row-title', text: U.title(m) }),
          U.el('div', { class: 'list-row-sub', text: `Episode ${m.nextAiringEpisode.episode} · ${U.relTime(new Date(m.nextAiringEpisode.airingAt * 1000))}` })
        ])
      ]))
    }
    return this._section('Airing soon', rows, { link: '#/schedule', linkText: 'Schedule →' })
  },

  _widget_stats () {
    const entries = Object.values(Store.list())
    const episodes = entries.reduce((s, e) => s + (e.progress ?? 0), 0)
    // Measured, not estimated. This used to be `progress * nominal runtime`,
    // which credited a flat 24 minutes the instant an episode was marked —
    // so the number grew by watching nothing. WatchTime.minutesFor() uses
    // real playback seconds and only falls back to the old estimate for
    // episodes credited before the meter existed.
    const minutes = window.WatchTime.minutesFor(entries).totalMinutes
    const hours = Math.floor(minutes / 60)
    const cards = U.el('div', { class: 'stat-cards', style: 'margin:0;' }, [
      [entries.length, 'In library', null],
      [entries.filter(e => e.status === 'COMPLETED').length, T('Completed'), 'completed'],
      [episodes.toLocaleString(I18n.locale()), T('Episodes'), 'episodes'],
      [hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`, T('Watch time'), 'watchTime']
    ].map(([v, l, stat]) => U.el('div', { class: 'stat-card', 'data-stat': stat }, [U.el('b', { text: String(v) }), U.el('span', { text: l })])))
    // Local numbers first, the account's own totals when they arrive.
    window.ProfileStats?.hydrate(cards)
    return this._section('Quick stats', cards, { link: '#/profile?tab=analytics', linkText: 'Analytics →' })
  },

  _widget_achievements () {
    if (!window.PageAchievements) return null
    const ctx = window.PageAchievements._context()
    const near = window.PageAchievements.CATALOG
      .map(a => { const v = Math.max(0, Math.floor(a.value(ctx))); return { ...a, current: v, pct: Math.min(100, Math.round(v / a.target * 100)) } })
      .filter(a => a.current < a.target)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 3)
    if (!near.length) return null
    const list = U.el('div', { class: 'dash-ach-list' })
    for (const a of near) {
      list.append(U.el('div', { class: 'dash-ach-row' }, [
        U.el('span', { class: 'ach-icon', style: 'width:2.2rem;height:2.2rem;font-size:1.2rem;', text: a.icon }),
        U.el('div', { style: 'flex-grow:1;min-width:0;' }, [
          U.el('div', { class: 'notif-title', text: a.name }),
          U.el('div', { class: 'ach-progress-track', style: 'margin-top:.35rem;' }, [U.el('div', { class: 'ach-progress-fill', style: `width:${a.pct}%;` })])
        ]),
        U.el('span', { class: 'ach-progress-text', text: `${a.current}/${a.target}` })
      ]))
    }
    return this._section('Almost there', list, { link: '#/profile?tab=achievements', linkText: 'Achievements →' })
  },

  _widget_notifications () {
    const items = Store.syncNotifications().slice(0, 5)
    if (!items.length) return null
    const list = U.el('div', { class: 'notif-list' })
    for (const n of items) {
      list.append(U.el('a', { class: 'notif-row' + (n.read ? '' : ' unread'), href: n.href ?? '#' }, [
        U.el('span', { class: `notif-icon notif-${n.type}`, text: n.icon }),
        U.el('div', { class: 'notif-body' }, [
          U.el('div', { class: 'notif-title', text: n.title }),
          U.el('div', { class: 'notif-text', text: n.body })
        ]),
        U.el('span', { class: 'notif-time', text: U.relTime(new Date(n.at)) })
      ]))
    }
    return this._section('Latest notifications', list, { link: '#/notifications', linkText: 'Inbox →' })
  },

  _widget_genres () {
    const counts = new Map()
    for (const g of Object.values(Store.list()).flatMap(e => e.media?.genres ?? [])) counts.set(g, (counts.get(g) ?? 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    if (!top.length) return null
    const max = top[0][1]
    const bars = U.el('div', { class: 'genre-bars', style: 'max-width:100%;' })
    for (const [name, count] of top) {
      bars.append(U.el('a', { class: 'genre-bar', href: `#/search?genre=${encodeURIComponent(name)}`, style: 'text-decoration:none;' }, [
        U.el('span', { class: 'genre-name', text: name }),
        U.el('div', { class: 'genre-track' }, [U.el('div', { class: 'genre-fill', style: `width:${count / max * 100}%;` })]),
        U.el('span', { class: 'genre-count', text: String(count) })
      ]))
    }
    return this._section('Top genres', bars)
  },

  _greeting () {
    const h = new Date().getHours()
    if (h < 5) return 'Late night'
    if (h < 12) return 'Good morning'
    if (h < 18) return 'Good afternoon'
    return 'Good evening'
  }
}

window.PageDashboard = PageDashboard
