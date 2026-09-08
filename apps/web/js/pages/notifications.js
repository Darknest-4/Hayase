/* global window, document, U, Store, T, YumeAPI */
// Notification Center — a filterable inbox from two sources.
//
// Local signals: airing episodes for library titles, stalled
// continue-watching, achievement unlocks. Read/dismiss state per profile.
//
// Server notifications: rows the notify worker wrote for this account — a
// monitoring alert reaches every operator this way. These existed and were
// being written long before anything could read them: the only accessor was a
// GraphQL field the client never calls, so the inbox filled up invisibly.
// They are merged in here, newest first, and marked read on the server.

const PageNotifications = {
  FILTERS: [
  // Labels are stored in English and translated where they are rendered, not
  // here: this literal is evaluated once when the script loads, so a T() call
  // in it would freeze the label in whatever language was active at boot and
  // never follow a language switch.
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'airing', label: 'Airing' },
    { key: 'resume', label: 'Continue' },
    { key: 'achievement', label: 'Achievements' },
    { key: 'system', label: 'System' }
  ],

  /**
   * A server row in the shape the list already draws.
   *
   * The payload is free-form per type, so the title falls back to the type
   * name rather than rendering an empty row for a type this build has never
   * heard of.
   */
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
      icon: kind.startsWith('monitor') ? '⚠️' : '📣',
      title: titles[kind] ?? kind,
      body: [payload.subject, payload.severity, payload.value].filter(Boolean).join(' · ') || T('Open for details'),
      href: kind.startsWith('monitor') ? '#/admin?s=monitoring' : '#/dashboard',
      at: new Date(row.created_at).getTime(),
      read: !!row.read_at
    }
  },

  async render (root, params) {
    const active = params.get('filter') ?? 'all'
    const local = Store.syncNotifications()
    // Server rows are a bonus, not a dependency: signed out or offline this
    // resolves to [] and the screen is exactly what it was before.
    const remote = (await YumeAPI.notifications({ limit: 50 })).map(row => this._fromServer(row))
    const all = [...remote, ...local].sort((a, b) => b.at - a.at)
    const unread = all.filter(n => !n.read).length

    root.append(window.C.spotlight(T('Notifications'), { subtitle: unread ? `${unread} unread` : 'All caught up' }))

    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    // ---- toolbar ----
    pad.append(U.el('div', { style: 'display:flex;gap:.5rem;justify-content:flex-end;margin-bottom:.5rem;' }, [
      U.el('button', {
        class: 'btn btn-ghost btn-sm',
        disabled: unread ? null : '',
        onclick: async () => {
          Store.markAllNotificationsRead()
          if (remote.some(n => !n.read)) await YumeAPI.markNotificationsRead()
          window.App.navigate()
          window.App.refreshNotifBadge?.()
        }
      }, [document.createTextNode(T('Mark all read'))]),
      U.el('button', {
        class: 'btn btn-ghost btn-sm',
        disabled: all.length ? null : '',
        onclick: () => { if (window.confirm('Clear all notifications?')) { Store.clearNotifications(); window.App.navigate(); window.App.refreshNotifBadge?.() } }
      }, [document.createTextNode(T('Clear all'))])
    ]))

    // ---- filter tabs ----
    const tabs = U.el('div', { class: 'notif-filters' })
    for (const f of this.FILTERS) {
      const count = f.key === 'all' ? all.length : f.key === 'unread' ? unread : all.filter(n => n.type === f.key).length
      tabs.append(U.el('a', {
        class: 'notif-filter' + (f.key === active ? ' active' : ''),
        href: `#/notifications?filter=${f.key}`
      }, [
        document.createTextNode(T(f.label)),
        count ? U.el('span', { class: 'notif-filter-count', text: String(count) }) : null
      ]))
    }
    pad.append(tabs)

    // ---- list ----
    const shown = all.filter(n => active === 'all' || (active === 'unread' ? !n.read : n.type === active))
    if (!shown.length) {
      pad.append(U.el('div', { class: 'empty-state', text: active === 'all' ? 'No notifications yet. Add airing anime to your library and they show up here.' : 'Nothing in this filter.' }))
      return
    }

    const list = U.el('div', { class: 'notif-list' })
    pad.append(list)

    for (const n of shown) {
      const row = U.el('a', {
        class: 'notif-row' + (n.read ? '' : ' unread'),
        href: n.href ?? '#',
        onclick: () => {
          if (n.read) return
          if (n.serverId) YumeAPI.markNotificationsRead([n.serverId])
          else Store.markNotificationRead(n.id)
          window.App.refreshNotifBadge?.()
        }
      }, [
        U.el('span', { class: `notif-icon notif-${n.type}`, text: n.icon }),
        U.el('div', { class: 'notif-body' }, [
          U.el('div', { class: 'notif-title', text: n.title }),
          U.el('div', { class: 'notif-text', text: n.body })
        ]),
        U.el('span', { class: 'notif-time', text: U.relTime(new Date(n.at)) }),
        U.el('button', {
          class: 'notif-dismiss',
          title: T('Dismiss'),
          'aria-label': T('Dismiss'),
          onclick: e => {
            e.preventDefault(); e.stopPropagation()
            // A server notification is dismissed by marking it read: the row
            // belongs to the account, not to this browser, and deleting it
            // from one device should not erase it from the record.
            if (n.serverId) YumeAPI.markNotificationsRead([n.serverId])
            else Store.dismissNotification(n.id)
            row.remove()
            window.App.refreshNotifBadge?.()
          }
        }, [document.createTextNode('×')])
      ])
      list.append(row)
    }
  }
}

window.PageNotifications = PageNotifications
