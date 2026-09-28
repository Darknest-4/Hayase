// Értesítések — #/notifications?filter=all|unread|airing|resume|achievement|system
//
// Két forrásból: a helyben képzett jelzések (a könyvtárból: adásba kerülő
// rész, félbehagyott sorozat, elért eredmény — fiók nélkül is) és a fiók
// kiszolgálói értesítései (belépve).
//
// 2026-09, újratervezve:
//   * kijelentkezve a lap nem hasal el: a kiszolgálói értesítésekhez fiók
//     kell, a helyiek anélkül is megvannak;
//   * a sor egy hivatkozás, az „elvetés" gomb mellette külön vezérlő (eddig
//     a gomb a hivatkozás BELSEJÉBEN volt, ami érvénytelen, és billentyűzettel
//     a kettő egy fókuszpont volt);
//   * a szűrők a közös fülsor, a megerősítés a közös párbeszédablak.

import { navigate, refreshNotifications } from '../shared/lib/shell.js'
import { C } from '../shared/ui/components.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { Store } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'

const ICONS = {
  airing: '<rect width="20" height="15" x="2" y="7" rx="2"/><polyline points="17 2 12 7 7 2"/>',
  resume: '<polygon points="6 3 20 12 6 21 6 3"/>',
  achievement: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  system: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
}
const X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'

export const PageNotifications = {
  FILTERS: [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'airing', label: 'Airing' },
    { key: 'resume', label: 'Continue Watching' },
    { key: 'achievement', label: 'Achievements' },
    { key: 'system', label: 'Rendszer' }
  ],

  _fromServer (row) {
    const payload = typeof row.payload === 'string'
      ? (() => { try { return JSON.parse(row.payload) } catch (e) { return {} } })()
      : (row.payload ?? {})
    const kind = String(row.type ?? 'system')
    const titles = {
      'monitor.alert': T('Infrastructure alert'),
      'stats.daily': T('Daily summary')
    }
    return {
      id: 'srv:' + row.id,
      serverId: row.id,
      type: 'system',
      alert: kind.startsWith('monitor'),
      title: titles[kind] ?? kind,
      body: [payload.subject, payload.severity, payload.value].filter(Boolean).join(' · ') || T('Open for details'),
      href: kind.startsWith('monitor') ? '#/admin?s=monitoring' : '#/dashboard',
      at: new Date(row.created_at).getTime(),
      read: !!row.read_at
    }
  },

  async render (root, params) {
    const wanted = params.get('filter') ?? 'all'
    const active = this.FILTERS.some(f => f.key === wanted) ? wanted : 'all'
    const local = Store.syncNotifications()
    // Kijelentkezve nincs kiszolgálói értesítés — és ez nem hiba.
    const remote = YumeAPI.user()
      ? (await YumeAPI.notifications({ limit: 50 }).catch(() => [])).map(row => this._fromServer(row))
      : []
    const all = [...remote, ...local].sort((a, b) => b.at - a.at)
    const unread = all.filter(n => !n.read).length

    const pad = U.el('div', { class: 'page-pad notif-page' })
    root.append(pad)
    pad.append(U.el('header', { class: 'page-header' }, [
      U.el('div', { class: 'page-header-text' }, [
        U.el('h1', { class: 'page-title', text: T('Notifications') }),
        U.el('p', { class: 'page-sub', text: unread ? I18n.f(T('{n} unread'), { n: unread }) : T('All caught up') })
      ]),
      U.el('div', { class: 'page-header-actions' }, [
        P.button(T('Mark all read'), {
          variant: 'secondary',
          disabled: !unread,
          onclick: async () => {
            Store.markAllNotificationsRead()
            if (remote.some(n => !n.read)) await YumeAPI.markNotificationsRead().catch(() => {})
            navigate()
            refreshNotifications()
          }
        }),
        P.button(T('Clear all'), {
          variant: 'ghost',
          disabled: !local.length,
          onclick: async () => {
            const ok = await C.confirm({
              title: T('Clear all notifications?'),
              message: T('The notifications generated from your library are removed from this list. Account notifications stay until you read them.'),
              confirmLabel: T('Clear all'),
              danger: true
            })
            if (!ok) return
            Store.clearNotifications()
            navigate()
            refreshNotifications()
          }
        })
      ])
    ]))

    // Szűrők: hivatkozások (saját cím), a fülsor megjelenésével.
    const tabs = U.el('nav', { class: 'tabs notif-filters', 'aria-label': T('Filter') })
    for (const f of this.FILTERS) {
      const count = f.key === 'all' ? all.length : f.key === 'unread' ? unread : all.filter(n => n.type === f.key).length
      tabs.append(U.el('a', {
        class: 'tab' + (f.key === active ? ' active' : ''),
        href: `#/notifications?filter=${f.key}`,
        ...(f.key === active ? { 'aria-current': 'page' } : {})
      }, [
        document.createTextNode(T(f.label)),
        count ? U.el('span', { class: 'tab-count', text: String(count) }) : null
      ]))
    }
    pad.append(tabs)
    U.revealActiveTab(tabs)

    const shown = all.filter(n => active === 'all' || (active === 'unread' ? !n.read : n.type === active))
    if (!shown.length) {
      pad.append(active === 'all'
        ? P.emptyState(T('No notifications yet. Add airing anime to your library and they show up here.'), {
          title: T('All caught up'),
          icon: ICONS.system,
          action: U.el('a', { class: 'btn btn-primary', href: '#/search', text: T('Browse the catalogue') })
        })
        : P.emptyState(T('Nothing in this filter.'), { icon: ICONS.system }))
      return
    }

    const list = U.el('ul', { class: 'notif-list' })
    pad.append(list)
    for (const n of shown) {
      const markRead = () => {
        if (n.read) return
        n.read = true
        if (n.serverId) YumeAPI.markNotificationsRead([n.serverId]).catch(() => {})
        else Store.markNotificationRead(n.id)
        refreshNotifications()
      }
      const item = U.el('li', { class: 'notif-row' + (n.read ? '' : ' unread') }, [
        U.el('span', { class: `notif-icon notif-${n.type}${n.alert ? ' notif-alert' : ''}`, 'aria-hidden': 'true' }, [
          U.svg(n.alert ? ICONS.alert : (ICONS[n.type] ?? ICONS.system), 18)
        ]),
        U.el('div', { class: 'notif-body' }, [
          U.el('a', { class: 'notif-link', href: n.href ?? '#/notifications', onclick: markRead }, [
            n.read ? null : U.el('span', { class: 'sr-only', text: T('Unread') + ': ' }),
            document.createTextNode(n.title ?? '')
          ]),
          U.el('p', { class: 'notif-text', text: n.body }),
          U.el('time', { class: 'notif-time', datetime: new Date(n.at).toISOString(), text: U.relTime(new Date(n.at)) })
        ]),
        U.el('button', {
          class: 'icon-btn icon-btn-sm icon-btn-quiet notif-dismiss',
          type: 'button',
          title: T('Dismiss'),
          'aria-label': I18n.f(T('Dismiss: {title}'), { title: n.title ?? '' }),
          onclick: () => {
            if (n.serverId) YumeAPI.markNotificationsRead([n.serverId]).catch(() => {})
            else Store.dismissNotification(n.id)
            const next = item.nextElementSibling ?? item.previousElementSibling
            item.remove()
            next?.querySelector('.notif-dismiss')?.focus()
            refreshNotifications()
          }
        }, [U.svg(X, 16)])
      ])
      list.append(item)
    }
  }
}
