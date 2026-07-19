/* global window, document, U, Store */
// Reusable render helpers: cards, horizontal sections, skeletons, modals.

const C = {
  HEART: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  PLAY: '<polygon points="6 3 20 12 6 21 6 3"/>',
  PLUS: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  CHECK: '<path d="M20 6 9 17l-5-5"/>',
  MINUS: '<path d="M5 12h14"/>',
  TRASH: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',

  card (media, { progress = null, subline = null } = {}) {
    const entry = Store.entry(media.id)
    const cover = U.el('div', { class: 'card-cover' }, [
      U.el('img', { src: U.cover(media), alt: U.title(media), loading: 'lazy' })
    ])

    if (entry) cover.append(U.el('div', { class: `card-status-dot dot-${entry.status}` }))

    if (media.averageScore) {
      cover.append(U.el('div', { class: 'card-score' }, [
        U.svg(this.HEART, 11),
        U.el('span', { text: media.averageScore + '%' })
      ]))
    }

    const prog = progress ?? entry?.progress
    if (prog && media.episodes) {
      cover.append(U.el('div', { class: 'card-progress' }, [
        U.el('div', { style: `width: ${Math.min(100, prog / media.episodes * 100)}%` })
      ]))
    }

    const sub = subline ?? [U.format(media), U.seasonYear(media), media.episodes ? `${media.episodes} ep` : null].filter(Boolean).join(' • ')

    return U.el('a', { class: 'card', href: `#/anime/${media.id}` }, [
      cover,
      U.el('div', { class: 'card-title', text: U.title(media) }),
      U.el('div', { class: 'card-sub', text: sub })
    ])
  },

  skeletonCard () {
    return U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-cover skeleton' }),
      U.el('div', { class: 'card-title skeleton', style: 'height:1em;border-radius:4px;' })
    ])
  },

  // horizontal scrolling section fed by a promise resolving to a media array
  section (title, mediaPromise, { moreHref = null, cardOptions = () => ({}) } = {}) {
    const row = U.el('div', { class: 'hscroll' }, Array.from({ length: 8 }, () => this.skeletonCard()))
    const head = U.el('div', { class: 'section-head' }, [
      U.el('h2', { class: 'section-title', text: title })
    ])
    if (moreHref) head.append(U.el('a', { class: 'section-more', href: moreHref, text: 'View more' }))

    const section = U.el('section', { class: 'section' }, [head, row])

    Promise.resolve(mediaPromise).then(mediaList => {
      row.replaceChildren()
      if (!mediaList?.length) {
        section.remove()
        return
      }
      for (const media of mediaList) row.append(this.card(media, cardOptions(media)))
    }).catch(() => {
      row.replaceChildren(U.el('div', { class: 'empty-state', text: 'Failed to load.' }))
    })

    return section
  },

  grid (mediaList, cardOptions = () => ({})) {
    return U.el('div', { class: 'grid' }, mediaList.map(media => this.card(media, cardOptions(media))))
  },

  // list-status dropdown + progress buttons used on the detail page
  listControls (media, onChange = () => {}) {
    const wrap = U.el('div', { class: 'detail-actions' })

    const render = () => {
      wrap.replaceChildren()
      const entry = Store.entry(media.id)

      const select = U.el('select', {
        class: 'select',
        onchange: e => {
          if (e.target.value === '') {
            Store.removeEntry(media.id)
            U.toast('Removed from list')
          } else {
            Store.saveEntry(media, { status: e.target.value })
            U.toast(`Set to ${U.listStatusMap[e.target.value]}`)
          }
          render()
          onChange()
        }
      }, [
        U.el('option', { value: '', text: entry ? 'Remove from list' : 'Add to list…' }),
        ...Object.entries(U.listStatusMap).map(([value, label]) =>
          U.el('option', { value, text: label, ...(entry?.status === value ? { selected: '' } : {}) }))
      ])
      wrap.append(select)

      if (entry && entry.status !== 'PLANNING') {
        const total = media.episodes ? ` / ${media.episodes}` : ''
        wrap.append(
          U.el('button', {
            class: 'icon-btn',
            title: 'Decrease progress',
            onclick: () => { Store.setProgress(media, (Store.entry(media.id)?.progress ?? 0) - 1); render(); onChange() }
          }, [U.svg(this.MINUS, 14)]),
          U.el('span', { style: 'font-weight:800;font-size:.9rem;', text: `${entry.progress ?? 0}${total} ep` }),
          U.el('button', {
            class: 'icon-btn',
            title: 'Increase progress',
            onclick: () => { Store.setProgress(media, (Store.entry(media.id)?.progress ?? 0) + 1); render(); onChange() }
          }, [U.svg(this.PLUS, 14)])
        )
      }

      const fav = Store.isFavourite(media.id)
      wrap.append(U.el('button', {
        class: `btn btn-sm ${fav ? 'btn-theme' : 'btn-ghost'}`,
        onclick: () => {
          const nowFav = Store.toggleFavourite(media.id)
          U.toast(nowFav ? 'Added to favourites' : 'Removed from favourites')
          render()
        }
      }, [U.svg(this.HEART, 14), document.createTextNode(fav ? 'Favourited' : 'Favourite')]))
    }

    render()
    return wrap
  },

  trailerModal (trailer) {
    if (!trailer?.id || trailer.site !== 'youtube') {
      U.toast('No trailer available', 'error')
      return
    }
    const backdrop = U.el('div', {
      class: 'modal-backdrop',
      onclick: e => { if (e.target === backdrop) close() }
    }, [
      U.el('div', { class: 'trailer-modal' }, [
        U.el('iframe', {
          src: `https://www.youtube-nocookie.com/embed/${trailer.id}?autoplay=1`,
          title: 'Trailer',
          allow: 'autoplay; fullscreen',
          allowfullscreen: ''
        })
      ])
    ])
    const close = () => {
      backdrop.remove()
      document.removeEventListener('keydown', esc)
    }
    const esc = e => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', esc)
    document.body.append(backdrop)
  }
}

window.C = C
