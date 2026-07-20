/* global window, document, U, C, Store */
// Watch History — per-profile chronological log of what you watched,
// grouped by day. Recorded automatically as episode progress advances.

const PageHistory = {
  render (root) {
    const profile = Store.activeProfile()
    root.append(window.C.spotlight('Watch History', { subtitle: profile ? `${profile.avatar ?? ''} ${profile.name}` : null }))

    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    pad.append(U.el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:.5rem;' }, [
      U.el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => {
          if (!window.confirm('Clear this profile’s entire watch history?')) return
          Store.clearHistory()
          U.toast('History cleared')
          window.App.navigate()
        }
      }, [document.createTextNode('Clear history')])
    ]))

    const history = Store.history()
    if (!history.length) {
      pad.append(U.el('div', { class: 'empty-state', text: 'Nothing watched yet on this profile. Play an episode and it shows up here.' }))
      return
    }

    // group by calendar day
    const groups = new Map()
    for (const item of history) {
      const key = new Date(item.at).toDateString()
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }

    const today = new Date().toDateString()
    const yesterday = new Date(Date.now() - 86400000).toDateString()

    for (const [key, items] of groups) {
      let label = new Date(key).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
      if (key === today) label = 'Today'
      else if (key === yesterday) label = 'Yesterday'

      pad.append(U.el('h2', { class: 'detail-section-title', style: 'margin-bottom:.5rem;', text: label }))

      for (const item of items) {
        const media = item.media
        pad.append(U.el('a', {
          class: 'list-row',
          href: `#/watch/${media.id}:${item.episode}`
        }, [
          U.el('img', { src: media.coverImage?.large ?? '', alt: U.title(media), loading: 'lazy' }),
          U.el('div', { class: 'list-row-grow' }, [
            U.el('div', { class: 'list-row-title', text: U.title(media) }),
            U.el('div', { class: 'list-row-sub', text: `Episode ${item.episode} • ${new Date(item.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` })
          ]),
          U.svg(C.PLAY, 16)
        ]))
      }
    }
  }
}

window.PageHistory = PageHistory
