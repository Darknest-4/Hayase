/* global window, document, U, C, API, Store */
// Anime detail page — faithful to the original Hayase layout:
// content scrolls over the global banner; cover bottom-aligned next to a
// huge title; chips tinted with the cover's dominant color (score chip
// colored by rating); a wide tinted Play button with the list editor and
// icon actions; genre + tag chips; then tabs:
// Episodes | Relations | Comments | Recommendations.

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

    // the original keeps the banner behind the whole page
    U.setBanner(media.bannerImage ?? U.cover(media))

    // cover dominant color drives the accent chips, like --custom upstream
    const custom = media.coverImage?.color ?? 'hsl(346.6 79% 51%)'
    const customFg = contrastColor(custom)

    const page = U.el('div', { class: 'detail-page', style: `--custom:${custom};--custom-fg:${customFg};` })
    root.append(page)
    const wrap = U.el('div', { class: 'detail-wrap' })
    page.append(wrap)

    // ---- hero row: cover + titles + chips + description ----
    const romaji = media.title?.romaji ?? ''
    const native = media.title?.native ?? ''
    const mainTitle = U.title(media)
    const secondary = romaji.toLowerCase().trim() === mainTitle.toLowerCase().trim() ? native : romaji

    const entry = Store.entry(media.id)
    const count = media.episodes ?? (media.nextAiringEpisode ? media.nextAiringEpisode.episode - 1 : null)
    const ofChip = entry?.progress != null && count
      ? `${entry.progress} of ${count}`
      : count ? `${count} episodes` : media.duration ? `${media.duration} min` : 'N/A'

    const chips = U.el('div', { class: 'chip-row' }, [
      U.el('span', { class: 'chip', text: ofChip }),
      U.el('a', { class: 'chip', href: `#/search?format=${media.format ?? ''}`, text: U.format(media) }),
      U.el('a', { class: 'chip', href: `#/search?status=${media.status ?? ''}`, text: U.statusMap[media.status] ?? '' }),
      U.seasonYear(media) ? U.el('a', { class: 'chip', href: `#/search?season=${media.season ?? ''}&year=${media.seasonYear ?? ''}`, text: String(U.seasonYear(media)) }) : null,
      media.averageScore ? U.el('span', { class: 'chip', style: `background:${ratingColor(media.averageScore)};color:white;`, text: media.averageScore + '%' }) : null
    ])

    const desc = U.el('div', { class: 'detail-desc clamped', text: U.plainDesc(media.description) })
    desc.addEventListener('click', () => desc.classList.toggle('clamped'))

    wrap.append(U.el('div', { class: 'detail-hero-row' }, [
      U.el('div', { class: 'detail-cover' }, [U.el('img', { src: U.cover(media), alt: mainTitle })]),
      U.el('div', { class: 'detail-headings' }, [
        secondary ? U.el('h2', { class: 'detail-secondary', text: secondary }) : null,
        U.el('h1', { class: 'detail-title', text: mainTitle }),
        chips,
        desc
      ])
    ]))

    // ---- action row: tinted Play + entry editor + icon buttons ----
    const nextEp = (Store.entry(media.id)?.progress ?? 0) + 1
    const actions = U.el('div', { class: 'detail-actions-row' })

    const playGroup = U.el('div', { class: 'play-group' }, [
      U.el('a', { class: 'play-btn', href: `#/watch/${media.id}:${nextEp}` }, [
        U.svg(C.PLAY, 15),
        document.createTextNode(Store.entry(media.id)?.progress ? ` Ep ${nextEp}` : ' Play')
      ]),
      this.entrySelect(media)
    ])
    actions.append(playGroup)

    const iconBtn = (content, title, onclick, active = false) => {
      const btn = U.el('button', { class: 'detail-icon-btn' + (active ? ' active' : ''), title, onclick })
      btn.append(content)
      return btn
    }

    // favourite (heart)
    const heart = U.svg(C.HEART, 15)
    if (Store.isFavourite(media.id)) heart.style.fill = 'currentColor'
    actions.append(iconBtn(heart, 'Favourite', e => {
      const now = Store.toggleFavourite(media.id)
      heart.style.fill = now ? 'currentColor' : 'none'
      e.currentTarget.classList.toggle('active', now)
      U.toast(now ? 'Added to favourites' : 'Removed from favourites')
    }, Store.isFavourite(media.id)))

    // bookmark (quick planning add)
    const inList = !!Store.entry(media.id)
    actions.append(iconBtn(
      U.svg('<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>', 15),
      inList ? 'On your list' : 'Add to Planning',
      e => {
        if (Store.entry(media.id)) return U.toast('Already on your list')
        Store.saveEntry(media, { status: 'PLANNING' })
        e.currentTarget.classList.add('active')
        U.toast('Added to Planning')
        window.App.navigate()
      },
      inList
    ))

    // share
    actions.append(iconBtn(
      U.svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/>', 15),
      'Share',
      () => {
        navigator.clipboard?.writeText(`https://hayase.watch/anime/${media.id}`)
          .then(() => U.toast('Link copied'))
      }
    ))

    // trailer (clapperboard)
    if (media.trailer?.id) {
      actions.append(iconBtn(
        U.svg('<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1-.3 2.1.3 2.4 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>', 15),
        'Trailer',
        () => C.trailerModal(media.trailer)
      ))
    }

    // AniList / MAL links
    actions.append(U.el('a', { class: 'detail-icon-btn', title: 'AniList', href: `https://anilist.co/anime/${media.id}`, target: '_blank', rel: 'noopener', text: 'AL' }))
    if (media.idMal) {
      actions.append(U.el('a', { class: 'detail-icon-btn', title: 'MyAnimeList', href: `https://myanimelist.net/anime/${media.idMal}`, target: '_blank', rel: 'noopener', text: 'MAL' }))
    }

    wrap.append(actions)

    // ---- genre + tag chips row (scrollable) ----
    const chipScroll = U.el('div', { class: 'chips-scroll' })
    for (const genre of media.genres ?? []) {
      chipScroll.append(U.el('a', { class: 'genre-chip', href: `#/search?genre=${encodeURIComponent(genre)}`, text: genre }))
    }
    const tags = (media.tags ?? []).slice().sort((a, b) => (b?.rank ?? 0) - (a?.rank ?? 0))
    for (const tag of tags.slice(0, 20)) {
      if (!tag?.name || tag.isAdult) continue
      const spoiler = tag.isMediaSpoiler || tag.isGeneralSpoiler
      chipScroll.append(U.el('span', { class: 'tag-chip' + (spoiler ? ' spoiler' : ''), title: tag.rank ? tag.rank + '%' : null, text: tag.name }))
    }
    if (chipScroll.children.length) wrap.append(chipScroll)

    // ---- tabs: Episodes | Relations | Comments | Recommendations ----
    const tabDefs = [['episodes', 'Episodes'], ['relations', 'Relations'], ['comments', 'Comments'], ['recommendations', 'Recommendations']]
    const tabBar = U.el('div', { class: 'dtabs' })
    const tabContent = U.el('div', { class: 'dtab-content' })
    const rendered = {}

    const select = name => {
      tabBar.querySelectorAll('.dtab').forEach(t => t.classList.toggle('active', t.dataset.tab === name))
      tabContent.replaceChildren()
      if (!rendered[name]) {
        rendered[name] = U.el('div')
        this['renderTab' + name[0].toUpperCase() + name.slice(1)](rendered[name], media)
      }
      tabContent.append(rendered[name])
    }

    for (const [name, label] of tabDefs) {
      tabBar.append(U.el('button', { class: 'dtab', dataset: { tab: name }, text: label, onclick: () => select(name) }))
    }
    wrap.append(tabBar, tabContent)
    select('episodes')
  },

  // status editor attached to the Play button, like the original EntryEditor
  entrySelect (media) {
    const entry = Store.entry(media.id)
    const select = U.el('select', {
      class: 'entry-select',
      title: 'List status',
      onchange: e => {
        if (e.target.value === '') {
          Store.removeEntry(media.id)
          U.toast('Removed from list')
        } else {
          Store.saveEntry(media, { status: e.target.value })
          U.toast(`Set to ${U.listStatusMap[e.target.value]}`)
        }
        window.App.navigate()
      }
    }, [
      U.el('option', { value: '', text: entry ? '✕ Remove' : '+ Add' }),
      ...Object.entries(U.listStatusMap).map(([value, label]) =>
        U.el('option', { value, text: label, ...(entry?.status === value ? { selected: '' } : {}) }))
    ])
    return select
  },

  renderTabEpisodes (wrap, media) {
    const list = U.el('div', { class: 'episodes' }, [U.el('div', { class: 'spinner' })])
    wrap.append(list)
    this.renderEpisodes(list, media).catch(() => {
      list.replaceChildren(U.el('div', { class: 'empty-state', text: 'No episode data available.' }))
    })
  },

  renderTabRelations (wrap, media) {
    const relations = (media.relations?.edges ?? [])
      .filter(e => e.node?.type !== 'MANGA' && e.relationType !== 'CHARACTER' && e.node?.coverImage)
    if (!relations.length) {
      wrap.append(U.el('div', { class: 'empty-state', text: 'No known relations.' }))
      return
    }
    const row = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;flex-wrap:wrap;' })
    for (const edge of relations) {
      const card = C.card(edge.node)
      card.prepend(U.el('div', { class: 'relation-label', text: (edge.relationType ?? '').replaceAll('_', ' ') }))
      row.append(card)
    }
    wrap.append(row)

    // characters live under relations, like supplementary info
    const characters = media.characters?.edges ?? []
    if (characters.length) {
      const crow = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;' })
      for (const edge of characters) {
        crow.append(U.el('div', { class: 'char-card' }, [
          U.el('img', { src: edge.node.image?.large ?? '', alt: edge.node.name?.userPreferred, loading: 'lazy' }),
          U.el('div', { class: 'char-name', text: edge.node.name?.userPreferred ?? '' }),
          U.el('div', { class: 'char-role', text: edge.role ?? '' })
        ]))
      }
      wrap.append(U.el('h2', { class: 'detail-section-title', text: 'Characters' }), crow)
    }
  },

  renderTabComments (wrap, media) {
    wrap.append(C.commentsSection(media))
  },

  renderTabRecommendations (wrap, media) {
    const recs = (media.recommendations?.nodes ?? []).map(n => n.mediaRecommendation).filter(Boolean)
    if (!recs.length) {
      wrap.append(U.el('div', { class: 'empty-state', text: 'No recommendations yet.' }))
      return
    }
    wrap.append(C.grid(recs))
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

// contrast text (black/white) for a hex background, like text-contrast upstream
function contrastColor (color) {
  const hex = color.startsWith('#') ? color.slice(1) : null
  if (!hex || hex.length < 6) return 'white'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? 'black' : 'white'
}

// score chip color, like getBGColorForRating upstream
function ratingColor (score) {
  if (score >= 75) return 'hsl(142 60% 38%)'
  if (score >= 60) return 'hsl(45 85% 42%)'
  return 'hsl(0 65% 45%)'
}

window.PageAnime = PageAnime
