// Áttekintés — #/dashboard (?edit=1: a widgetek sorrendje és láthatósága)
//
// A néző saját irányítópultja: folytatás, hamarosan adásban, gyors
// statisztika, közeli eredmények, friss értesítések, kedvenc műfajok. Minden
// widget a helyi könyvtárból épül, hálózat nélkül; a statisztikát a
// kiszolgáló számai (ProfileStats.hydrate) pontosítják.
//
// 2026-09, újratervezve: a widgetek rácsban (a „Folytatás" és a statisztika
// teljes szélességben, a többi kártyákban kettesével), minden felirat a néző
// nyelvén (az „In library" eddig angolul maradt), a szerkesztő kapcsolói
// valódi `role="switch"` elemek, és a köszöntés a fiók nevét használja.

import { navigate } from '../shared/lib/shell.js'
import { viewerProfile } from '../shared/lib/site-config.js'
import { C } from '../shared/ui/components.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { ProfileStats } from '../features/watch-history/profile-stats.js'
import { Store } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'
import { WatchTime } from '../features/watch-history/watch-time.js'
import { AchievementCatalog } from '../features/achievements/catalog.js'
import { YumeAPI } from '../shared/api/yume.js'

const LAYOUT = '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>'
const UP = '<path d="m18 15-6-6-6 6"/>'
const DOWN = '<path d="m6 9 6 6 6-6"/>'

export const PageDashboard = {
  WIDGETS: [
    { key: 'continue', label: 'Continue watching', wide: true },
    { key: 'stats', label: 'Quick stats', wide: true },
    { key: 'airing', label: 'Airing soon' },
    { key: 'achievements', label: 'Almost there' },
    { key: 'notifications', label: 'Latest notifications' },
    { key: 'genres', label: 'Top genres' }
  ],

  render (root, params) {
    const editing = params.get('edit') === '1'
    const layout = this._layout()
    const account = viewerProfile()
    const name = account?.display_name ?? YumeAPI.user()?.username ?? Store.profile()?.name ?? T('Dreamer')

    const pad = U.el('div', { class: 'page-pad dash-page' })
    root.append(pad)
    pad.append(U.el('header', { class: 'page-header' }, [
      U.el('div', { class: 'page-header-text' }, [
        U.el('p', { class: 'eyebrow', text: I18n.date(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }) }),
        U.el('h1', { class: 'page-title', text: `${this._greeting()}, ${name}!` })
      ]),
      U.el('div', { class: 'page-header-actions' }, [
        U.el('a', {
          class: 'btn ' + (editing ? 'btn-primary' : 'btn-secondary'),
          href: editing ? '#/dashboard' : '#/dashboard?edit=1'
        }, [U.svg(LAYOUT, 16), document.createTextNode(editing ? T('Done') : T('Edit layout'))])
      ])
    ]))

    if (editing) {
      pad.append(this._editor(layout))
      return
    }

    const enabled = layout.filter(w => w.enabled)
    if (!enabled.length) {
      pad.append(P.emptyState(T('No widgets enabled. Use “Edit layout” to add some.'), { icon: LAYOUT }))
      return
    }
    const grid = U.el('div', { class: 'dash-grid' })
    const meta = new Map(this.WIDGETS.map(w => [w.key, w]))
    for (const w of enabled) {
      const node = (this['_widget_' + w.key] ?? (() => null)).call(this)
      if (!node) continue
      if (meta.get(w.key)?.wide) node.classList.add('dash-widget-wide')
      grid.append(node)
    }
    if (!grid.childElementCount) {
      pad.append(P.emptyState(
        T('Nothing to show yet — add anime to your library and your dashboard fills in automatically.'),
        {
          icon: LAYOUT,
          action: U.el('a', { class: 'btn btn-primary', href: '#/search', text: T('Browse the catalogue') })
        }
      ))
      return
    }
    pad.append(grid)
  },

  _layout () {
    const saved = Store.settings().dashboard
    if (!Array.isArray(saved)) return this.WIDGETS.map(w => ({ key: w.key, enabled: true }))
    const known = new Map(this.WIDGETS.map(w => [w.key, w]))
    const result = saved.filter(s => known.has(s.key)).map(s => ({ key: s.key, enabled: s.enabled !== false }))
    for (const w of this.WIDGETS) if (!result.some(r => r.key === w.key)) result.push({ key: w.key, enabled: true })
    return result
  },

  _saveLayout (layout) {
    Store.saveSettings({ dashboard: layout.map(w => ({ key: w.key, enabled: w.enabled })) })
  },

  _editor (layout) {
    const wrap = U.el('ol', { class: 'dash-editor', 'aria-label': T('Edit layout') })
    const meta = new Map(this.WIDGETS.map(w => [w.key, w]))
    const rerender = focusKey => {
      this._saveLayout(layout)
      navigate()?.then?.(() => document.querySelector(`[data-widget="${focusKey}"]`)?.focus())
    }
    layout.forEach((w, i) => {
      const label = meta.get(w.key) ? T(meta.get(w.key).label) : w.key
      wrap.append(U.el('li', { class: 'dash-editor-row' }, [
        U.el('span', { class: 'dash-editor-name', text: label }),
        U.el('div', { class: 'dash-editor-actions' }, [
          U.el('button', {
            class: 'icon-btn icon-btn-sm',
            type: 'button',
            disabled: i === 0,
            'aria-label': I18n.f(T('Move {name} up'), { name: label }),
            dataset: { widget: w.key + ':up' },
            onclick: () => { [layout[i - 1], layout[i]] = [layout[i], layout[i - 1]]; rerender(w.key + ':up') }
          }, [U.svg(UP, 16)]),
          U.el('button', {
            class: 'icon-btn icon-btn-sm',
            type: 'button',
            disabled: i === layout.length - 1,
            'aria-label': I18n.f(T('Move {name} down'), { name: label }),
            dataset: { widget: w.key + ':down' },
            onclick: () => { [layout[i + 1], layout[i]] = [layout[i], layout[i + 1]]; rerender(w.key + ':down') }
          }, [U.svg(DOWN, 16)]),
          U.el('label', { class: 'switch' }, [
            U.el('input', {
              type: 'checkbox',
              role: 'switch',
              checked: w.enabled,
              'aria-label': I18n.f(T('Show {name}'), { name: label }),
              dataset: { widget: w.key + ':on' },
              onchange: e => { w.enabled = e.target.checked; rerender(w.key + ':on') }
            })
          ])
        ])
      ]))
    })
    return wrap
  },

  _section (title, body, opts = {}) {
    const id = 'dash-' + Math.random().toString(36).slice(2, 8)
    return U.el('section', { class: 'dash-widget', 'aria-labelledby': id }, [
      U.el('div', { class: 'section-head' }, [
        U.el('h2', { class: 'section-title', id, text: T(title) }),
        opts.link ? U.el('a', { class: 'section-more', href: opts.link, text: T(opts.linkText ?? 'View more') }) : null
      ]),
      body
    ])
  },

  _widget_continue () {
    const ids = Store.continueIds()
    const list = Store.list()
    const media = ids.map(id => list[id]?.media).filter(Boolean).slice(0, 12)
    if (!media.length) return null
    const row = U.el('div', { class: 'hscroll' })
    for (const m of media) {
      const entry = list[m.id]
      row.append(C.card(m, { subline: entry?.progress ? I18n.f(T('Next: episode {n}'), { n: entry.progress + 1 }) : null }))
    }
    return this._section('Continue watching', row, { link: '#/list', linkText: 'Library' })
  },

  _widget_airing () {
    const now = Date.now() / 1000
    const upcoming = Object.values(Store.list())
      .map(e => e.media)
      .filter(m => m?.nextAiringEpisode?.airingAt && m.nextAiringEpisode.airingAt > now)
      .sort((a, b) => a.nextAiringEpisode.airingAt - b.nextAiringEpisode.airingAt)
      .slice(0, 6)
    if (!upcoming.length) return null
    const rows = U.el('ul', { class: 'dash-list' })
    for (const m of upcoming) {
      rows.append(U.el('li', {}, [U.el('a', { class: 'dash-list-row', href: `#/anime/${m.id}` }, [
        U.el('img', { src: U.cover(m), alt: '', loading: 'lazy', decoding: 'async' }),
        U.el('div', { class: 'dash-list-main' }, [
          U.el('span', { class: 'dash-list-title', text: U.title(m) }),
          U.el('span', { class: 'dash-list-sub', text: `${I18n.f(T('Episode {n}'), { n: m.nextAiringEpisode.episode })} · ${U.relTime(new Date(m.nextAiringEpisode.airingAt * 1000))}` })
        ])
      ])]))
    }
    return this._section('Airing soon', rows, { link: '#/schedule', linkText: 'Schedule' })
  },

  _widget_stats () {
    const entries = Object.values(Store.list())
    if (!entries.length) return null
    const episodes = entries.reduce((s, e) => s + (e.progress ?? 0), 0)
    const minutes = WatchTime.minutesFor(entries).totalMinutes
    const cards = U.el('div', { class: 'stats' }, [
      [I18n.number(entries.length), T('In library'), null],
      [I18n.number(entries.filter(e => e.status === 'COMPLETED').length), T('Completed'), 'completed'],
      [I18n.number(episodes), T('Episodes'), 'episodes'],
      [ProfileStats.formatMinutes(minutes), T('Watch time'), 'watchTime']
    ].map(([v, l, stat]) => U.el('div', { class: 'stat', ...(stat ? { 'data-stat': stat } : {}) }, [
      U.el('span', { class: 'stat-label', text: l }),
      U.el('b', { class: 'stat-value', text: String(v) })
    ])))
    ProfileStats?.hydrate(cards)
    return this._section('Quick stats', cards, { link: '#/profile?tab=analytics', linkText: 'Analytics' })
  },

  _widget_achievements () {
    const ctx = AchievementCatalog.context()
    const near = AchievementCatalog.CATALOG
      .map(a => { const v = Math.max(0, Math.floor(a.value(ctx))); return { ...a, current: v, pct: Math.min(100, Math.round(v / a.target * 100)) } })
      .filter(a => a.current < a.target)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 3)
    if (!near.length) return null
    const list = U.el('ul', { class: 'dash-list' })
    for (const a of near) {
      list.append(U.el('li', { class: 'dash-ach' }, [
        U.el('span', { class: 'dash-ach-icon', 'aria-hidden': 'true', text: a.icon }),
        U.el('div', { class: 'dash-list-main' }, [
          U.el('span', { class: 'dash-list-title', text: T(a.name) }),
          U.el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(a.target), 'aria-valuenow': String(a.current), 'aria-label': T(a.name) }, [
            U.el('span', { style: `width:${a.pct}%` })
          ])
        ]),
        U.el('span', { class: 'dash-ach-count tabular', text: `${a.current}/${a.target}` })
      ]))
    }
    return this._section('Almost there', list, { link: '#/profile?tab=achievements', linkText: 'Achievements' })
  },

  _widget_notifications () {
    const items = Store.syncNotifications().slice(0, 5)
    if (!items.length) return null
    const list = U.el('ul', { class: 'dash-list' })
    for (const n of items) {
      list.append(U.el('li', {}, [U.el('a', { class: 'dash-list-row' + (n.read ? '' : ' dash-unread'), href: n.href ?? '#/notifications' }, [
        U.el('div', { class: 'dash-list-main' }, [
          U.el('span', { class: 'dash-list-title', text: n.title }),
          U.el('span', { class: 'dash-list-sub', text: n.body })
        ]),
        U.el('time', { class: 'dash-list-time', datetime: new Date(n.at).toISOString(), text: U.relTime(new Date(n.at)) })
      ])]))
    }
    return this._section('Latest notifications', list, { link: '#/notifications', linkText: 'Notifications' })
  },

  _widget_genres () {
    const counts = new Map()
    for (const g of Object.values(Store.list()).flatMap(e => e.media?.genres ?? [])) counts.set(g, (counts.get(g) ?? 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    if (!top.length) return null
    const max = top[0][1]
    const bars = U.el('ul', { class: 'profile-bars' })
    for (const [name, count] of top) {
      bars.append(U.el('li', { class: 'profile-bar' }, [
        U.el('a', { class: 'profile-bar-name', href: `#/search?genre=${encodeURIComponent(name)}`, text: T(name) }),
        U.el('div', { class: 'profile-bar-track', 'aria-hidden': 'true' }, [U.el('div', { class: 'profile-bar-fill', style: `width:${count / max * 100}%;background:var(--accent);` })]),
        U.el('span', { class: 'profile-bar-count tabular', text: String(count) })
      ]))
    }
    return this._section('Top genres', bars)
  },

  _greeting () {
    const h = new Date().getHours()
    if (h < 5) return T('Late night')
    if (h < 12) return T('Good morning')
    if (h < 18) return T('Good afternoon')
    return T('Good evening')
  }
}
