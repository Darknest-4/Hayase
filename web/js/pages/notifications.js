/* global window, document, U, Store */
// Notification Center — a filterable inbox built from local signals: airing
// episodes for library titles, stalled continue-watching, and achievement
// unlocks. Read/dismiss state persists per profile.

const PageNotifications = {
  FILTERS: [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'airing', label: 'Airing' },
    { key: 'resume', label: 'Continue' },
    { key: 'achievement', label: 'Achievements' }
  ],

  render (root, params) {
    const active = params.get('filter') ?? 'all'
    const all = Store.syncNotifications()
    const unread = all.filter(n => !n.read).length

    root.append(window.C.spotlight('Notifications', { subtitle: unread ? `${unread} unread` : 'All caught up' }))

    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    // ---- toolbar ----
    pad.append(U.el('div', { style: 'display:flex;gap:.5rem;justify-content:flex-end;margin-bottom:.5rem;' }, [
      U.el('button', {
        class: 'btn btn-ghost btn-sm',
        disabled: unread ? null : '',
        onclick: () => { Store.markAllNotificationsRead(); window.App.navigate(); window.App.refreshNotifBadge?.() }
      }, [document.createTextNode('Mark all read')]),
      U.el('button', {
        class: 'btn btn-ghost btn-sm',
        disabled: all.length ? null : '',
        onclick: () => { if (window.confirm('Clear all notifications?')) { Store.clearNotifications(); window.App.navigate(); window.App.refreshNotifBadge?.() } }
      }, [document.createTextNode('Clear all')])
    ]))

    // ---- filter tabs ----
    const tabs = U.el('div', { class: 'notif-filters' })
    for (const f of this.FILTERS) {
      const count = f.key === 'all' ? all.length : f.key === 'unread' ? unread : all.filter(n => n.type === f.key).length
      tabs.append(U.el('a', {
        class: 'notif-filter' + (f.key === active ? ' active' : ''),
        href: `#/notifications?filter=${f.key}`
      }, [
        document.createTextNode(f.label),
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
        onclick: () => { if (!n.read) { Store.markNotificationRead(n.id); window.App.refreshNotifBadge?.() } }
      }, [
        U.el('span', { class: `notif-icon notif-${n.type}`, text: n.icon }),
        U.el('div', { class: 'notif-body' }, [
          U.el('div', { class: 'notif-title', text: n.title }),
          U.el('div', { class: 'notif-text', text: n.body })
        ]),
        U.el('span', { class: 'notif-time', text: U.relTime(new Date(n.at)) }),
        U.el('button', {
          class: 'notif-dismiss',
          title: 'Dismiss',
          onclick: e => {
            e.preventDefault(); e.stopPropagation()
            Store.dismissNotification(n.id)
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
