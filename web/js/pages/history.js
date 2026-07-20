/* global window, document, U, C, Store */
// Watch History — per-profile chronological log of what you watched,
// grouped by day. Recorded automatically as episode progress advances.

const PageHistory = {
  render (root) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    const profile = Store.activeProfile()
    pad.append(U.el('div', { style: 'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;' }, [
      U.el('h1', { class: 'page-title', style: 'margin:0;', text: 'Watch History' }),
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
    if (profile) pad.append(U.el('p', { class: 'list-row-sub', style: 'margin-top:-.5rem;', text: `Profile: ${profile.avatar ?? ''} ${profile.name}` }))

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
