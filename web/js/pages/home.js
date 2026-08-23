/* global C, Catalogue, Store, T, U, window */
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
      { title: T('home.rails.popularSeason'), vars: { sort: ['POPULARITY_DESC'], season, seasonYear: year } },
      { title: T('home.rails.trending'), vars: { sort: ['TRENDING_DESC'] } },
      { title: T('home.rails.airing'), vars: { sort: ['POPULARITY_DESC'], status: ['RELEASING'] } },
      { title: T('home.rails.allTimePopular'), vars: { sort: ['POPULARITY_DESC'] } },
      { title: T('home.rails.topRated'), vars: { sort: ['SCORE_DESC'] } },
      { title: T('home.rails.movies'), vars: { sort: ['POPULARITY_DESC'], format: ['MOVIE'] } },
      { title: T('home.rails.romance'), vars: { sort: ['TRENDING_DESC'], genre: ['Romance'] } },
      { title: T('home.rails.action'), vars: { sort: ['TRENDING_DESC'], genre: ['Action'] } },
      { title: T('home.rails.adventure'), vars: { sort: ['TRENDING_DESC'], genre: ['Adventure'] } },
      { title: T('home.rails.fantasy'), vars: { sort: ['TRENDING_DESC'], genre: ['Fantasy'] } }
    ]

    // local-list driven sections (Continue Watching / Your List)
    const continueIds = Store.continueIds()
    if (continueIds.length) {
      sections.append(C.section(T('home.continueWatching'),
        Catalogue.searchOrAniList({ ids: continueIds.slice(0, 50), perPage: 50 }).then(page => {
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

    // Sequels You Missed — sequels of completed shows that aren't on the list
    const completedIds = Object.values(Store.list()).filter(e => e.status === 'COMPLETED').map(e => e.media.id)
    if (completedIds.length) {
      sections.append(C.section(T('home.sequelsYouMissed'),
        Catalogue.searchOrAniList({ ids: completedIds.slice(0, 25), perPage: 25 }).then(async page => {
          const inList = new Set(Object.keys(Store.list()).map(Number))
          const sequelIds = [...new Set((page.media ?? []).flatMap(m =>
            (m.relations?.edges ?? [])
              .filter(e => e?.relationType === 'SEQUEL' && e.node && ['FINISHED', 'RELEASING'].includes(e.node.status) && !inList.has(e.node.id))
              .map(e => e.node.id)))]
          if (!sequelIds.length) return []
          const res = await Catalogue.searchOrAniList({ ids: sequelIds.slice(0, 25), perPage: 25 })
          return res.media ?? []
        })))
    }

    const planningIds = Store.planningIds()
    if (planningIds.length) {
      sections.append(C.section(T('home.yourList'),
        Catalogue.searchOrAniList({ ids: planningIds.slice(0, 50), perPage: 50, status: ['FINISHED', 'RELEASING'] }).then(page => page.media ?? []),
        { moreHref: '#/list' }))
    }

    for (const def of defs) {
      const params = new URLSearchParams()
      if (def.vars.genre) params.set('genre', def.vars.genre[0])
      if (def.vars.season) { params.set('season', def.vars.season); params.set('year', def.vars.year ?? year) }
      if (def.vars.format) params.set('format', def.vars.format[0])
      if (def.vars.status) params.set('status', def.vars.status[0])
      params.set('sort', def.vars.sort[0])

      sections.append(C.section(def.title, Catalogue.searchOrAniList(def.vars).then(page => page.media ?? []), {
        moreHref: '#/search?' + params.toString()
      }))
    }

    // hero from the #1 trending anime with a banner image
    try {
      const page = await Catalogue.searchOrAniList({ sort: ['TRENDING_DESC'], perPage: 10 })
      const media = (page.media ?? []).find(m => m.bannerImage) ?? page.media?.[0]
      if (media) this.renderHero(hero, media)
    } catch (e) {
      hero.remove()
    }
  },

  renderHero (hero, media) {
    U.setBanner(media.bannerImage)

    // muted looping trailer behind the hero, like the original app;
    // stays invisible until the frame actually loads
    if (media.trailer?.id && media.trailer.site === 'youtube') {
      const frame = U.el('iframe', {
        class: 'hero-trailer',
        src: `https://www.youtube-nocookie.com/embed/${media.trailer.id}?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&loop=1&playlist=${media.trailer.id}`,
        allow: 'autoplay',
        title: 'trailer'
      })
      frame.addEventListener('load', () => frame.classList.add('loaded'))
      hero.append(frame)
    }

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
        (media.genres ?? []).length
          ? U.el('div', { class: 'badges', style: 'margin-bottom:1rem;' }, media.genres.slice(0, 4).map(g =>
            U.el('a', { class: 'badge', href: `#/search?genre=${encodeURIComponent(g)}`, text: g })))
          : null,
        U.el('div', { class: 'hero-buttons' }, [
          U.el('a', { class: 'btn btn-primary', href: `#/watch/${media.id}:${(Store.entry(media.id)?.progress ?? 0) + 1}` }, [U.svg(C.PLAY, 15), document.createTextNode('Watch now')]),
          Store.entry(media.id)
            ? null
            : U.el('button', {
              class: 'btn btn-secondary',
              onclick: e => { Store.saveEntry(media, { status: 'PLANNING' }); U.toast('Added to Planning'); e.target.textContent = '✓ In your list' }
            }, [document.createTextNode('+ Add to list')]),
          U.el('button', { class: 'btn btn-secondary', onclick: () => C.trailerModal(media.trailer) }, [document.createTextNode('Trailer')]),
          U.el('a', { class: 'btn btn-ghost', href: `#/anime/${media.id}` }, [document.createTextNode('Details')])
        ])
      ])
    )
  }
}

window.PageHome = PageHome
