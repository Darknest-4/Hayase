/* global window, document, U, C, Store */
// My List page — the locally stored anime list with status tabs,
// inline progress controls and favourites.

const PageList = {
  render (root, params) {
    const total = Object.keys(Store.list()).length
    root.append(C.spotlight('Library', { subtitle: total ? `${total} ${total === 1 ? 'title' : 'titles'} tracked` : 'Your anime, tracked' }))

    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    const state = { tab: params.get('tab') ?? 'CURRENT' }

    const tabsWrap = U.el('div', { class: 'tabs' })
    const content = U.el('div', { style: 'margin-top:1.25rem;' })
    pad.append(tabsWrap, content)

    const TABS = [...Object.entries(U.listStatusMap), ['FAVOURITES', 'Favourites']]

    const renderTabs = () => {
      const list = Object.values(Store.list())
      const favs = Store.favourites()
      tabsWrap.replaceChildren()
      for (const [value, label] of TABS) {
        const count = value === 'FAVOURITES' ? favs.length : list.filter(e => e.status === value).length
        const tab = U.el('button', {
          class: 'tab' + (state.tab === value ? ' active' : ''),
          onclick: () => { state.tab = value; renderTabs(); renderContent() }
        }, [
          document.createTextNode(label),
          U.el('span', { class: 'count', text: String(count) })
        ])
        tabsWrap.append(tab)
      }
    }

    const renderContent = async () => {
      content.replaceChildren()

      if (state.tab === 'FAVOURITES') {
        const favs = Store.favourites()
        if (!favs.length) {
          content.append(U.el('div', { class: 'empty-state', text: 'No favourites yet.' }))
          return
        }
        content.append(U.el('div', { class: 'spinner' }))
        try {
          const page = await window.API.search({ ids: favs.slice(0, 50), perPage: 50 })
          content.replaceChildren(C.grid(page.media ?? []))
        } catch (e) {
          content.replaceChildren(U.el('div', { class: 'error-state', text: 'Failed to load favourites.' }))
        }
        return
      }

      const entries = Object.values(Store.list())
        .filter(e => e.status === state.tab)
        .sort((a, b) => b.updatedAt - a.updatedAt)

      if (!entries.length) {
        content.append(U.el('div', { class: 'empty-state', text: 'Nothing here yet. Add anime from their detail page.' }))
        return
      }

      for (const entry of entries) {
        const media = entry.media
        const row = U.el('div', {
          class: 'list-row',
          onclick: e => {
            if (e.target.closest('button')) return
            window.location.hash = `#/anime/${media.id}`
          }
        })

        const sub = [U.format(media), U.seasonYear(media)].filter(Boolean).join(' • ')
        const total = media.episodes ? ` / ${media.episodes}` : ''

        const controls = U.el('div', { class: 'progress-controls' })
        if (state.tab !== 'PLANNING') {
          controls.append(
            U.el('button', {
              class: 'icon-btn',
              title: '-1 episode',
              onclick: () => { Store.setProgress(media, (Store.entry(media.id)?.progress ?? 0) - 1); renderTabs(); renderContent() }
            }, [U.svg(C.MINUS, 13)]),
            U.el('span', { style: 'font-weight:800;font-size:.85rem;min-width:4.5rem;text-align:center;', text: `${entry.progress ?? 0}${total} ep` }),
            U.el('button', {
              class: 'icon-btn',
              title: '+1 episode',
              onclick: () => { Store.setProgress(media, (Store.entry(media.id)?.progress ?? 0) + 1); renderTabs(); renderContent() }
            }, [U.svg(C.PLUS, 13)])
          )
        }
        controls.append(U.el('button', {
          class: 'icon-btn',
          title: 'Remove from list',
          onclick: () => {
            Store.removeEntry(media.id)
            U.toast('Removed from list')
            renderTabs()
            renderContent()
          }
        }, [U.svg(C.TRASH, 13)]))

        row.append(
          U.el('img', { src: media.coverImage?.large ?? '', alt: U.title(media), loading: 'lazy' }),
          U.el('div', { class: 'list-row-grow' }, [
            U.el('div', { class: 'list-row-title', text: U.title(media) }),
            U.el('div', { class: 'list-row-sub', text: sub })
          ]),
          controls
        )
        content.append(row)
      }
    }

    renderTabs()
    renderContent()
  }
}

window.PageList = PageList
