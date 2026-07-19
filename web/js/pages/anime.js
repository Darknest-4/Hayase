/* global window, document, U, C, API, Store */
// Anime detail page — banner, cover, info, list controls, episodes
// (AniList + ani.zip + Jikan merged), relations, characters, recommendations.

const PageAnime = {
  async render (root, params, id) {
    root.append(U.el('div', { class: 'spinner' }))

    let media
    try {
      media = await API.media(Number(id))
    } catch (e) {
      root.replaceChildren(U.el('div', { class: 'error-state', text: 'Failed to load anime: ' + e.message }))
      return
    }
    if (!media) {
      root.replaceChildren(U.el('div', { class: 'empty-state', text: 'Anime not found.' }))
      return
    }

    root.replaceChildren()
    U.setBanner(null)

    // ---- banner + head ----
    const banner = U.el('div', { class: 'detail-banner' + (media.bannerImage ? '' : ' no-banner') })
    if (media.bannerImage) banner.style.backgroundImage = `url("${media.bannerImage}")`

    const badges = U.el('div', { class: 'badges' })
    for (const genre of media.genres ?? []) {
      badges.append(U.el('a', { class: 'badge', text: genre, href: `#/search?genre=${encodeURIComponent(genre)}` }))
    }

    const meta = U.el('div', { class: 'hero-meta' })
    const metaItems = [
      U.format(media),
      U.seasonYear(media),
      media.episodes ? `${media.episodes} Episodes` : null,
      media.duration ? `${media.duration} min` : null,
      U.statusMap[media.status],
      media.studios?.nodes?.[0]?.name
    ].filter(Boolean)
    metaItems.forEach((text, i) => {
      if (i) meta.append(U.el('span', { class: 'dot' }))
      meta.append(U.el('span', { text }))
    })

    const desc = U.el('div', { class: 'detail-desc clamped', text: U.plainDesc(media.description) })
    const descToggle = U.el('div', {
      class: 'desc-toggle',
      text: 'Show more',
      onclick: () => {
        const clamped = desc.classList.toggle('clamped')
        descToggle.textContent = clamped ? 'Show more' : 'Show less'
      }
    })

    const actions = C.listControls(media)
    if (media.trailer?.id) {
      actions.append(U.el('button', {
        class: 'btn btn-sm btn-secondary',
        onclick: () => C.trailerModal(media.trailer)
      }, [U.svg(C.PLAY, 13), document.createTextNode('Trailer')]))
    }
    actions.append(U.el('a', {
      class: 'btn btn-sm btn-ghost',
      href: `https://anilist.co/anime/${media.id}`,
      target: '_blank',
      rel: 'noopener'
    }, [document.createTextNode('AniList ↗')]))

    const stats = U.el('div', { class: 'stats-row' })
    const statDefs = [
      ['Score', media.averageScore ? media.averageScore + '%' : '—'],
      ['Popularity', media.popularity?.toLocaleString() ?? '—'],
      ['Favourites', media.favourites?.toLocaleString() ?? '—'],
      ['Source', media.source ? media.source.replaceAll('_', ' ') : '—']
    ]
    if (media.nextAiringEpisode) {
      statDefs.push(['Next episode', `Ep ${media.nextAiringEpisode.episode} ${U.relTime(new Date(media.nextAiringEpisode.airingAt * 1000))}`])
    }
    for (const [label, value] of statDefs) {
      stats.append(U.el('div', {}, [U.el('b', { text: String(value) }), document.createTextNode(label)]))
    }

    root.append(
      banner,
      U.el('div', { class: 'detail-head' }, [
        U.el('div', { class: 'detail-cover' }, [U.el('img', { src: U.cover(media), alt: U.title(media) })]),
        U.el('div', { class: 'detail-info' }, [
          U.el('h1', { class: 'detail-title', text: U.title(media) }),
          U.el('div', { class: 'detail-native', text: media.title?.native ?? '' }),
          meta,
          badges,
          actions,
          stats,
          desc,
          descToggle
        ])
      ])
    )

    const body = U.el('div', { class: 'detail-body' })
    root.append(body)

    // ---- streaming links (official external streams from AniList) ----
    const streams = (media.externalLinks ?? []).filter(l => l.type === 'STREAMING')
    if (streams.length) {
      body.append(U.el('h2', { class: 'detail-section-title', text: 'Watch on' }))
      body.append(U.el('div', { class: 'badges' }, streams.map(link =>
        U.el('a', {
          class: 'badge badge-theme',
          href: link.url,
          target: '_blank',
          rel: 'noopener',
          text: link.site,
          style: link.color ? `background:${link.color};` : null
        }))))
    }

    // ---- episodes ----
    const epTitle = U.el('h2', { class: 'detail-section-title', text: 'Episodes' })
    const epWrap = U.el('div', { class: 'episodes' }, [U.el('div', { class: 'spinner' })])
    body.append(epTitle, epWrap)
    this.renderEpisodes(epWrap, media).catch(() => {
      epWrap.replaceChildren(U.el('div', { class: 'empty-state', text: 'No episode data available.' }))
    })

    // ---- relations ----
    const relations = (media.relations?.edges ?? [])
      .filter(e => e.node?.type !== 'MANGA' && e.relationType !== 'CHARACTER' && e.node?.coverImage)
    if (relations.length) {
      const row = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;' })
      for (const edge of relations) {
        const card = C.card(edge.node)
        card.prepend(U.el('div', { class: 'relation-label', text: (edge.relationType ?? '').replaceAll('_', ' ') }))
        row.append(card)
      }
      body.append(U.el('h2', { class: 'detail-section-title', text: 'Relations' }), row)
    }

    // ---- characters ----
    const characters = media.characters?.edges ?? []
    if (characters.length) {
      const row = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;' })
      for (const edge of characters) {
        row.append(U.el('div', { class: 'char-card' }, [
          U.el('img', { src: edge.node.image?.large ?? '', alt: edge.node.name?.userPreferred, loading: 'lazy' }),
          U.el('div', { class: 'char-name', text: edge.node.name?.userPreferred ?? '' }),
          U.el('div', { class: 'char-role', text: edge.role ?? '' })
        ]))
      }
      body.append(U.el('h2', { class: 'detail-section-title', text: 'Characters' }), row)
    }

    // ---- recommendations ----
    const recs = (media.recommendations?.nodes ?? []).map(n => n.mediaRecommendation).filter(Boolean)
    if (recs.length) {
      const row = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;' })
      for (const rec of recs) row.append(C.card(rec))
      body.append(U.el('h2', { class: 'detail-section-title', text: 'Recommendations' }), row)
    }

    // ---- comments (platform feature; renders only when a Yume API is up) ----
    body.append(C.commentsSection(media))
  },

  async renderEpisodes (wrap, media) {
    const episodes = await API.episodes(media)

    if (!episodes.length) {
      wrap.replaceChildren(U.el('div', { class: 'empty-state', text: media.status === 'NOT_YET_RELEASED' ? 'Not yet aired.' : 'No episode data available.' }))
      return
    }

    const render = () => {
      const entry = Store.entry(media.id)
      const progress = entry?.progress ?? 0
      wrap.replaceChildren()

      for (const ep of episodes) {
        const watched = progress >= ep.episode
        const thumb = U.el('div', { class: 'episode-thumb' }, [
          ep.image ? U.el('img', { src: ep.image, loading: 'lazy', alt: `Episode ${ep.episode}` }) : null,
          U.el('div', { class: 'ep-num', text: 'Ep ' + ep.episode }),
          ep.filler ? U.el('div', { class: 'ep-filler', text: 'FILLER' }) : null
        ])
        if (watched) {
          thumb.append(U.el('div', { class: 'ep-watched-overlay' }, [U.svg(C.CHECK, 24)]))
        }

        const metaText = [ep.airdate ? U.airDate(ep.airdate) : null, ep.runtime ? `${ep.runtime} min` : null, ep.rating ? `★ ${ep.rating}` : null].filter(Boolean).join(' • ')

        wrap.append(U.el('div', {
          class: 'episode',
          title: `Watch episode ${ep.episode}`,
          onclick: () => { window.location.hash = `#/watch/${media.id}:${ep.episode}` }
        }, [
          thumb,
          U.el('div', { class: 'episode-body' }, [
            U.el('div', { style: 'display:flex;align-items:center;gap:.5rem;' }, [
              U.el('div', { class: 'episode-title', style: 'flex-grow:1;', text: ep.title ?? `Episode ${ep.episode}` }),
              U.el('button', {
                class: 'icon-btn',
                title: watched ? 'Mark as unwatched' : 'Mark as watched',
                style: watched ? 'color:var(--accent);border-color:var(--accent);' : null,
                onclick: e => {
                  e.stopPropagation()
                  // clicking the newest watched episode steps back one
                  Store.setProgress(media, watched && progress === ep.episode ? ep.episode - 1 : ep.episode)
                  render()
                }
              }, [U.svg(C.CHECK, 13)])
            ]),
            metaText ? U.el('div', { class: 'episode-meta', text: metaText }) : null,
            ep.summary ? U.el('div', { class: 'episode-summary', text: ep.summary }) : null
          ])
        ]))
      }
    }

    render()
  }
}

window.PageAnime = PageAnime
