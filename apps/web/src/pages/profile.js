// Profil — #/profile?tab=overview|analytics|achievements|history
//
// 2026-09, újratervezve. A fejléc saját elrendezést kapott (a közös
// `C.spotlight` sávban a név, az avatar és a banner-forrás három különböző
// sarokba szóródott), a fülek linkek maradtak (mindegyiknek saját címe van),
// és a statisztika a közös `.stat` komponensre épül — a `data-stat` horgok
// ugyanazok, a kiszolgáló számai (ProfileStats.hydrate) ugyanúgy felülírják a
// helyi becslést.

import { C } from '../shared/ui/components.js'
import { viewerProfile } from '../shared/lib/site-config.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { ProfileStats } from '../features/watch-history/profile-stats.js'
import { Store } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'
import { WatchTime } from '../features/watch-history/watch-time.js'
import { YumeAPI } from '../shared/api/yume.js'
import { estimateXp, levelFor } from '../shared/lib/level.js'
import { loadStylesheet } from '../shared/lib/stylesheet.js'

const EDIT = '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'

export const PageProfile = {
  TABS: [
    { key: 'overview', label: 'Overview' },
    { key: 'analytics', label: 'Analytics' },
    { key: 'achievements', label: 'Achievements' },
    { key: 'history', label: 'History' }
  ],

  /** A fülek saját közös lapjai: csak a megnyitott fülé töltődik le. */
  TAB_STYLES: {
    overview: 'features/profile-bars.css',
    analytics: 'features/charts.css',
    history: 'features/lib-rows.css'
  },

  /** A fülek saját moduljai (az áttekintés ebben a fájlban van). */
  TAB_MODULES: {
    analytics: () => import('./analytics.js').then(m => m.PageAnalytics),
    achievements: () => import('../features/achievements/achievements.js').then(m => m.PageAchievements),
    history: () => import('./history.js').then(m => m.PageHistory)
  },

  async render (root, params) {
    const wanted = params.get('tab') ?? 'overview'
    const active = this.TABS.some(t => t.key === wanted) ? wanted : 'overview'
    // A fül modulja és stíluslapja a rajzolás előtt, egyszerre: a diagramoké
    // csak a statisztikánál, a könyvtársoroké csak az előzményeknél kell.
    const [tab] = await Promise.all([
      this.TAB_MODULES[active]?.(),
      this.TAB_STYLES[active] ? loadStylesheet(this.TAB_STYLES[active]) : null
    ])

    const profile = Store.profile()
    const name = profile?.name ?? Store.settings().profileName ?? T('Dreamer')
    const entries = Object.values(Store.list())
    const episodesWatched = entries.reduce((s, e) => s + (e.progress ?? 0), 0)
    // A kiszolgáló XP-je az irányadó (ProfileStats, a jóváírások naplójából);
    // nélküle a helyi becslés, UGYANAZZAL a görbével (shared/lib/level.js).
    const server = ProfileStats.cached()
    const xp = server?.xp > 0 ? server.xp : estimateXp({ episodes: episodesWatched })
    const { level } = levelFor(xp)
    const account = viewerProfile()
    const displayName = account?.display_name ?? name
    const user = YumeAPI.user()

    root.append(this.header({ account, displayName, level, xp, count: entries.length, user }))

    const pad = U.el('div', { class: 'page-pad profile-body' })
    root.append(pad)

    // Linkek, nem gombok: minden fülnek saját címe van (a fiókmenü ide mutat).
    const tabs = U.el('nav', { class: 'tabs', 'aria-label': T('Profile') })
    for (const t of this.TABS) {
      tabs.append(U.el('a', {
        class: 'tab' + (t.key === active ? ' active' : ''),
        href: t.key === 'overview' ? '#/profile' : `#/profile?tab=${t.key}`,
        ...(t.key === active ? { 'aria-current': 'page' } : {})
      }, [document.createTextNode(T(t.label))]))
    }
    pad.append(tabs)
    U.revealActiveTab(tabs)

    const content = U.el('div', { class: 'profile-content' })
    pad.append(content)
    if (tab) tab.body(content)
    else this.overview(content)
  },

  header ({ account, displayName, level, xp, count, user }) {
    const banner = account?.banner_key ?? null
    return U.el('section', { class: 'profile-hero', 'aria-labelledby': 'profile-name' }, [
      U.el('div', { class: 'profile-banner' + (banner ? '' : ' profile-banner-empty') }, [
        banner ? U.el('img', { src: banner, alt: '', decoding: 'async' }) : null
      ]),
      U.el('div', { class: 'profile-hero-inner' }, [
        C.avatar({ name: displayName, avatar_key: account?.avatar_key }, { size: 'xl' }),
        U.el('div', { class: 'profile-hero-text' }, [
          U.el('h1', { class: 'profile-name', id: 'profile-name', text: displayName }),
          U.el('p', { class: 'profile-meta' }, [
            user ? U.el('span', { text: '@' + user.username }) : null,
            U.el('span', {}, [
              document.createTextNode(T('Level') + ' '),
              U.el('b', { 'data-stat': 'level', text: String(level) })
            ]),
            U.el('span', { text: `${I18n.number(xp)} XP` }),
            U.el('span', { text: I18n.f(T('{n} in library'), { n: I18n.number(count) }) })
          ])
        ]),
        U.el('a', { class: 'btn btn-secondary profile-edit', href: '#/settings?tab=account' }, [
          U.svg(EDIT, 16), document.createTextNode(T('Edit profile'))
        ])
      ]),
      account?.banner_from
        ? U.el('a', { class: 'profile-banner-credit', href: '#/settings?tab=account', text: account.banner_from })
        : null
    ])
  },

  overview (pad) {
    const entries = Object.values(Store.list())
    const favs = Store.favourites()
    const completed = entries.filter(e => e.status === 'COMPLETED')
    const episodesWatched = entries.reduce((sum, e) => sum + (e.progress ?? 0), 0)
    const watch = WatchTime.minutesFor(entries)
    const scored = entries.filter(e => e.score > 0)
    const meanScore = scored.length ? (scored.reduce((sum, e) => sum + e.score, 0) / scored.length).toFixed(1) : null

    const statDefs = [
      [I18n.number(entries.length), T('Anime in library'), null],
      [I18n.number(completed.length), T('Completed'), 'completed'],
      [I18n.number(episodesWatched), T('Episodes watched'), 'episodes'],
      [ProfileStats.formatMinutes(watch.totalMinutes), T('Watch time'), 'watchTime'],
      [meanScore ?? '—', T('Mean score'), 'meanScore'],
      [I18n.number(favs.length), T('Favourites'), null]
    ]
    const cards = U.el('div', { class: 'stats profile-stats' }, statDefs.map(([value, label, stat]) =>
      U.el('div', { class: 'stat', ...(stat ? { 'data-stat': stat } : {}) }, [
        U.el('span', { class: 'stat-label', text: label }),
        U.el('b', { class: 'stat-value', text: value })
      ])))
    pad.append(cards)
    ProfileStats?.hydrate(cards)

    const statuses = Object.entries(U.listStatusMap)
      .map(([status, label]) => [T(label), entries.filter(e => e.status === status).length, status])
      .filter(([, count]) => count > 0)
    if (!statuses.length) {
      pad.append(P.emptyState(T('Your library is empty — add some anime and your stats will grow here.'), {
        icon: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
        action: U.el('a', { class: 'btn btn-primary', href: '#/search', text: T('Browse the catalogue') })
      }))
      return
    }

    const statusToken = {
      CURRENT: 'watching',
      REPEATING: 'watching',
      PLANNING: 'planning',
      COMPLETED: 'completed',
      PAUSED: 'paused',
      DROPPED: 'dropped'
    }
    const max = Math.max(...statuses.map(([, count]) => count))
    const bars = U.el('ul', { class: 'profile-bars' })
    for (const [label, count, status] of statuses) {
      bars.append(U.el('li', { class: 'profile-bar' }, [
        U.el('a', { class: 'profile-bar-name', href: `#/list?status=${status}`, text: label }),
        U.el('div', { class: 'profile-bar-track', 'aria-hidden': 'true' }, [
          U.el('div', { class: 'profile-bar-fill', style: `width:${count / max * 100}%;background:var(--status-${statusToken[status]});` })
        ]),
        U.el('span', { class: 'profile-bar-count tabular', text: I18n.number(count) })
      ]))
    }
    pad.append(U.el('section', { class: 'section' }, [
      U.el('div', { class: 'section-head' }, [
        U.el('h2', { class: 'section-title', text: T('Library breakdown') }),
        U.el('a', { class: 'section-more', href: '#/list', text: T('Library') })
      ]),
      bars
    ]))

    const recent = entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 12)
    if (recent.length) {
      pad.append(U.el('section', { class: 'section' }, [
        U.el('div', { class: 'section-head' }, [U.el('h2', { class: 'section-title', text: T('Recent activity') })]),
        U.el('div', { class: 'hscroll' }, recent.map(entry => C.card(entry.media, {
          subline: [T(U.listStatusMap[entry.status] ?? ''), entry.progress ? I18n.f(T('Episode {n}'), { n: entry.progress }) : null].filter(Boolean).join(' · ')
        })))
      ]))
    }
  }
}
