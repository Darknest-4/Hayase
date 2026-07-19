/* global window, U, C, API, Store */
// Home page — hero banner + the same sections as the original app/home route:
// Continue Watching, Your List, Popular This Season, Trending Now,
// All Time Popular and genre rows.

const PageHome = {
  async render (root) {
    const { season, year } = U.currentSeason()

    const hero = U.el('div', { class: 'hero' })
    const sections = U.el('div')
    root.append(hero, sections)

    // sections, same order/variables as the original home page
    const defs = [
      { title: 'Popular This Season', vars: { sort: ['POPULARITY_DESC'], season, seasonYear: year } },
      { title: 'Trending Now', vars: { sort: ['TRENDING_DESC'] } },
      { title: 'All Time Popular', vars: { sort: ['POPULARITY_DESC'] } },
      { title: 'Romance', vars: { sort: ['TRENDING_DESC'], genre: ['Romance'] } },
      { title: 'Action', vars: { sort: ['TRENDING_DESC'], genre: ['Action'] } },
      { title: 'Adventure', vars: { sort: ['TRENDING_DESC'], genre: ['Adventure'] } },
      { title: 'Fantasy', vars: { sort: ['TRENDING_DESC'], genre: ['Fantasy'] } }
    ]

    // local-list driven sections (Continue Watching / Your List)
    const continueIds = Store.continueIds()
    if (continueIds.length) {
      sections.append(C.section('Continue Watching',
        API.search({ ids: continueIds.slice(0, 50), perPage: 50 }).then(page => {
          const media = page.media ?? []
          media.sort((a, b) => continueIds.indexOf(a.id) - continueIds.indexOf(b.id))
          return media
        }),
        {
          cardOptions: media => {
            const entry = Store.entry(media.id)
            return { subline: entry ? `Episode ${entry.progress + 1}` : null }
          }
        }))
    }

    const planningIds = Store.planningIds()
    if (planningIds.length) {
      sections.append(C.section('Your List',
        API.search({ ids: planningIds.slice(0, 50), perPage: 50, status: ['FINISHED', 'RELEASING'] }).then(page => page.media ?? []),
        { moreHref: '#/list' }))
    }

    for (const def of defs) {
      const params = new URLSearchParams()
      if (def.vars.genre) params.set('genre', def.vars.genre[0])
      if (def.vars.season) { params.set('season', def.vars.season); params.set('year', def.vars.year ?? year) }
      params.set('sort', def.vars.sort[0])

      sections.append(C.section(def.title, API.search(def.vars).then(page => page.media ?? []), {
        moreHref: '#/search?' + params.toString()
      }))
    }

    // hero from the #1 trending anime with a banner image
    try {
      const page = await API.search({ sort: ['TRENDING_DESC'], perPage: 10 })
      const media = (page.media ?? []).find(m => m.bannerImage) ?? page.media?.[0]
      if (media) this.renderHero(hero, media)
    } catch (e) {
      hero.remove()
    }
  },

  renderHero (hero, media) {
    U.setBanner(media.bannerImage)

    const meta = [
      U.format(media),
      U.seasonYear(media),
      media.episodes ? `${media.episodes} Episodes` : null,
      U.statusMap[media.status]
    ].filter(Boolean)

    const metaRow = U.el('div', { class: 'hero-meta' })
    meta.forEach((text, index) => {
      if (index) metaRow.append(U.el('span', { class: 'dot' }))
      metaRow.append(U.el('span', { text }))
    })
    if (media.averageScore) {
      metaRow.append(U.el('span', { class: 'dot' }))
      const score = U.el('span', { style: 'display:inline-flex;align-items:center;gap:.3rem;' })
      const heart = U.svg(C.HEART, 14)
      heart.style.fill = 'var(--theme)'
      heart.style.stroke = 'var(--theme)'
      score.append(heart, document.createTextNode(media.averageScore + '%'))
      metaRow.append(score)
    }

    hero.append(
      U.el('div', { class: 'hero-content' }, [
        U.el('h1', { class: 'hero-title', text: U.title(media) }),
        metaRow,
        U.el('p', { class: 'hero-desc', text: U.plainDesc(media.description) }),
        U.el('div', { class: 'hero-buttons' }, [
          U.el('a', { class: 'btn btn-primary', href: `#/anime/${media.id}` }, [U.svg(C.PLAY, 15), document.createTextNode('View')]),
          U.el('button', {
            class: 'btn btn-secondary',
            onclick: () => C.trailerModal(media.trailer)
          }, [document.createTextNode('Trailer')])
        ])
      ])
    )
  }
}

window.PageHome = PageHome
