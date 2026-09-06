/* global window, document, U, C, Catalogue, Store, T, I18n */
// Anime detail page — faithful to the original Hayase layout:
// content scrolls over the global banner; cover bottom-aligned next to a
// huge title; chips tinted with the cover's dominant color (score chip
// colored by rating); a wide tinted Play button with the list editor and
// icon actions; genre + tag chips; then tabs:
// Episodes | Relations | Comments | Recommendations.

const PageAnime = {
  async render (root, params, id) {
    root.append(U.el('div', { class: 'spinner' }))

    // Catalogue first, AniList as the fallback — see js/catalogue.js. `id` is
    // an AniList id or a Yume uuid; the resolver accepts either, which is what
    // makes a catalogue-only title reachable at all.
    let media
    try {
      media = await Catalogue.media(id)
    } catch (e) {
      root.replaceChildren(U.el('div', { class: 'error-state', text: T('Failed to load anime: ') + e.message }))
      return
    }
    if (!media) {
      root.replaceChildren(U.el('div', { class: 'empty-state', text: T('Anime not found.') }))
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
      media.averageScore ? U.el('span', { class: 'chip', style: `background:${ratingColor(media.averageScore)};color:white;`, text: media.averageScore + '%' }) : null,
      media.nextAiringEpisode?.airingAt
        ? U.el('span', { class: 'chip chip-airing', text: `Ep ${media.nextAiringEpisode.episode} ${U.relTime(new Date(media.nextAiringEpisode.airingAt * 1000))}` })
        : null
    ])

    // star rating badge (reference: "★ 9.08")
    const starRow = media.averageScore
      ? U.el('div', { class: 'score-badges' }, [
        U.el('span', { class: 'score-star' }, [
          U.svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor" stroke="none"/>', 13),
          document.createTextNode((media.averageScore / 10).toFixed(2))
        ]),
        media.favourites ? U.el('span', { class: 'score-favs', text: `${media.favourites.toLocaleString(I18n.locale())} favourites` }) : null
      ])
      : null

    const descText = U.plainDesc(media.description)
    const desc = U.el('div', { class: 'detail-desc clamped', text: descText })

    // Say so when the description is not in the language the viewer asked for.
    //
    // 25,703 synopses are English and a Hungarian one exists only once somebody
    // writes it. An unexplained English paragraph on a Hungarian site reads as
    // the site being broken; the same paragraph labelled as an untranslated one
    // reads as what it is, and costs one line to say.
    const wantLang = window.Prefs?.get('language.content') ?? 'hu'
    const gotLang = media._lang?.synopsis ?? null
    const descNote = descText && gotLang && gotLang !== wantLang && gotLang !== 'unknown'
      ? U.el('p', { class: 'detail-desc-note', text: T('This description has not been translated yet.') })
      : null
    const moreBtn = descText.length > 220
      ? U.el('button', {
        class: 'showmore',
        onclick: e => {
          const clamped = desc.classList.toggle('clamped')
          e.currentTarget.textContent = clamped ? 'Show more ⌄' : 'Show less ⌃'
        }
      }, [document.createTextNode(T('Show more ⌄'))])
      : null

    const titleEl = U.el('h1', { class: 'detail-title', text: mainTitle })

    wrap.append(U.el('div', { class: 'detail-hero-row' }, [
      U.el('div', { class: 'detail-cover' }, [U.el('img', { src: U.cover(media), alt: mainTitle })]),
      U.el('div', { class: 'detail-headings' }, [
        titleEl,
        secondary ? U.el('h2', { class: 'detail-secondary', style: 'margin-top:.1rem;', text: secondary }) : null,
        starRow,
        chips,
        descNote,
        desc,
        moreBtn
      ])
    ]))

    // A metadata extension may carry the translation the catalogue lacks.
    // Deliberately after the hero is on screen: the untranslated text appears
    // immediately and is replaced when and if an answer arrives, rather than
    // the page waiting on a network call that usually has nothing to add.
    this._applyTranslations(media, { titleEl, desc, descNote, wantLang })
      .catch(error => console.warn('[anime] translations failed:', error))

    // ---- action row: Continue Watching + list editor + icon buttons ----
    const progress = Store.entry(media.id)?.progress ?? 0
    // resume mid-episode? point at it; otherwise the next unwatched episode
    const resumeNextEp = Store.getResume(media.id, progress + 1)
    const resumeCurEp = progress > 0 ? Store.getResume(media.id, progress) : 0
    const targetEp = resumeNextEp || !resumeCurEp ? progress + 1 : progress
    const resumeAt = resumeNextEp || resumeCurEp
    const estTotal = (media.duration || 24) * 60

    const playLabel = progress || resumeAt ? 'Continue Watching' : 'Start Watching'
    const playSub = resumeAt
      ? `Episode ${targetEp} • ${U.fmtTime(resumeAt)} / ${U.fmtTime(estTotal)}`
      : `Episode ${targetEp}`

    const actions = U.el('div', { class: 'detail-actions-row' })
    const playGroup = U.el('div', { class: 'play-group' }, [
      U.el('a', { class: 'play-btn play-btn-rich', href: `#/watch/${media.id}:${targetEp}` }, [
        U.svg(C.PLAY, 16),
        U.el('span', { class: 'play-btn-text' }, [
          U.el('b', { text: playLabel }),
          U.el('small', { text: playSub })
        ]),
        resumeAt ? U.el('span', { class: 'play-btn-bar' }, [U.el('span', { style: `width:${Math.min(100, resumeAt / estTotal * 100)}%;` })]) : null
      ]),
      this.entrySelect(media)
    ])
    actions.append(playGroup)

    // `title` shows a tooltip; `aria-label` is what a screen reader reads.
    // These buttons have no text at all, so without the second one they are
    // announced as "button" and nothing else.
    const iconBtn = (content, title, onclick, active = false) => {
      const btn = U.el('button', { class: 'detail-icon-btn' + (active ? ' active' : ''), title, 'aria-label': title, onclick })
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
        if (Store.entry(media.id)) return U.toast(T('Already on your list'))
        Store.saveEntry(media, { status: 'PLANNING' })
        e.currentTarget.classList.add('active')
        U.toast(T('Added to Planning'))
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
          .then(() => U.toast(T('Link copied')))
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
    // Only when we actually have the mapping: media.id may be a Yume uuid for a
    // catalogue-only title, and pointing anilist.co at that builds a dead link.
    const anilistId = media.anilistId ?? (typeof media.id === 'number' ? media.id : null)
    if (anilistId) {
      actions.append(U.el('a', { class: 'detail-icon-btn', title: T('AniList'), href: `https://anilist.co/anime/${anilistId}`, target: '_blank', rel: 'noopener', text: T('AL') }))
    }
    if (media.idMal) {
      actions.append(U.el('a', { class: 'detail-icon-btn', title: T('MyAnimeList'), href: `https://myanimelist.net/anime/${media.idMal}`, target: '_blank', rel: 'noopener', text: T('MAL') }))
    }

    wrap.append(actions)

    // ---- genre chips row (tags live in the sidebar card) ----
    const chipScroll = U.el('div', { class: 'chips-scroll' })
    for (const genre of media.genres ?? []) {
      chipScroll.append(U.el('a', { class: 'genre-chip', href: `#/search?genre=${encodeURIComponent(genre)}`, text: genre }))
    }
    if (chipScroll.children.length) wrap.append(chipScroll)

    // ---- underline tabs with icons ----
    const TAB_ICONS = {
      episodes: '<polygon points="6 3 20 12 6 21 6 3"/>',
      relations: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/>',
      characters: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
      comments: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
      recommendations: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
    }
    const tabDefs = [['episodes', 'Episodes'], ['relations', 'Relations'], ['characters', 'Characters'], ['comments', 'Comments'], ['recommendations', 'Recommendations']]
    const tabBar = U.el('div', { class: 'dtabs' })
    const tabContent = U.el('div', { class: 'dtab-content' })
    const rendered = {}

    const select = name => {
      tabBar.querySelectorAll('.dtab').forEach(t => t.classList.toggle('active', t.dataset.tab === name))
      tabContent.replaceChildren()
      if (!rendered[name]) {
        rendered[name] = U.el('div')
        // Some tab renderers are async — they draw synchronously and then fill
        // in from extensions. The node is appended either way, so the promise
        // is deliberately not awaited; it is caught so a failure cannot become
        // an unhandled rejection.
        Promise
          .resolve(this['renderTab' + name[0].toUpperCase() + name.slice(1)](rendered[name], media))
          .catch(error => console.warn('[anime] tab failed:', name, error))
      }
      tabContent.append(rendered[name])
    }

    for (const [name, label] of tabDefs) {
      tabBar.append(U.el('button', { class: 'dtab', dataset: { tab: name }, onclick: () => select(name) }, [
        U.svg(TAB_ICONS[name], 14),
        document.createTextNode(label)
      ]))
    }

    // two-column body: tabs on the left, info sidebar on the right
    const main = U.el('div', { class: 'detail-main-col' }, [tabBar, tabContent])
    wrap.append(U.el('div', { class: 'detail-columns' }, [main, this.sidePanel(media)]))
    select('episodes')
  },

  // ---- right-hand info sidebar: facts, airing countdown, where to watch ----
  sidePanel (media) {
    const side = U.el('aside', { class: 'detail-side' })

    // next airing countdown card
    const air = media.nextAiringEpisode
    if (air?.airingAt) {
      side.append(U.el('div', { class: 'side-card side-airing' }, [
        U.el('div', { class: 'side-airing-label', text: T('Next episode') }),
        U.el('div', { class: 'side-airing-ep', text: `Episode ${air.episode}` }),
        U.el('div', { class: 'side-airing-time', text: U.relTime(new Date(air.airingAt * 1000)) })
      ]))
    }

    const prettify = v => v ? String(v).replaceAll('_', ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()) : null
    const start = media.startDate?.year
      ? [media.startDate.year, media.startDate.month, media.startDate.day].filter(Boolean).join('.')
      : null

    const rows = [
      ['Format', U.format(media)],
      ['Episodes', media.episodes ? String(media.episodes) : null],
      ['Duration', media.duration ? `${media.duration} min` : null],
      ['Status', U.statusMap[media.status]],
      ['Season', U.seasonYear(media) || null],
      ['Start date', start],
      ['Studio', media.studios?.nodes?.[0]?.name],
      ['Source', prettify(media.source)],
      ['Country', media.countryOfOrigin],
      ['Mean score', media.meanScore ? media.meanScore + '%' : null],
      ['Popularity', media.popularity ? media.popularity.toLocaleString(I18n.locale()) : null],
      ['Favourites', media.favourites ? media.favourites.toLocaleString(I18n.locale()) : null]
    ].filter(([, v]) => v)

    side.append(U.el('div', { class: 'side-card' }, [
      U.el('h3', { class: 'side-card-title', text: T('Information') }),
      U.el('div', { class: 'side-rows' }, rows.map(([label, value]) =>
        U.el('div', { class: 'side-row' }, [
          U.el('span', { class: 'side-row-label', text: label }),
          U.el('span', { class: 'side-row-value', text: value })
        ])))
    ]))

    // your progress ring (only when the anime is on the list)
    const entry = Store.entry(media.id)
    if (entry && media.episodes) {
      const done = entry.progress ?? 0
      const pct = Math.min(100, Math.round(done / media.episodes * 100))
      side.append(U.el('div', { class: 'side-card' }, [
        U.el('h3', { class: 'side-card-title', text: T('Your Progress') }),
        U.el('div', { class: 'side-progress' }, [
          U.el('div', { class: 'side-ring', style: `--pct:${pct};` }, [
            U.el('div', { class: 'side-ring-inner' }, [
              U.el('b', { text: `${done} of ${media.episodes}` }),
              U.el('span', { text: T('episodes') })
            ])
          ]),
          U.el('div', { class: 'side-rows', style: 'flex-grow:1;' }, [
            U.el('div', { class: 'side-row' }, [U.el('span', { class: 'side-row-label', text: T('Status') }), U.el('span', { class: 'side-row-value', text: U.listStatusMap[entry.status] ?? '—' })]),
            entry.score ? U.el('div', { class: 'side-row' }, [U.el('span', { class: 'side-row-label', text: T('Your score') }), U.el('span', { class: 'side-row-value', text: entry.score + '/10' })]) : null,
            Store.isFavourite(media.id) ? U.el('div', { class: 'side-row' }, [U.el('span', { class: 'side-row-label', text: T('Favourite') }), U.el('span', { class: 'side-row-value', text: '❤' })]) : null
          ])
        ])
      ]))
    }

    // official streaming links
    const streams = (media.externalLinks ?? []).filter(l => l.type === 'STREAMING')
    if (streams.length) {
      side.append(U.el('div', { class: 'side-card' }, [
        U.el('h3', { class: 'side-card-title', text: T('Where to watch') }),
        U.el('div', { class: 'side-streams' }, streams.slice(0, 8).map(link =>
          U.el('a', { class: 'side-stream', href: link.url, target: '_blank', rel: 'noopener' }, [
            U.el('span', { class: 'side-stream-dot', style: link.color ? `background:${link.color};` : null }),
            document.createTextNode(link.site)
          ])))
      ]))
    }

    // tags card (spoilers blurred until hover)
    const tags = (media.tags ?? []).filter(t => t?.name && !t.isAdult)
      .sort((a, b) => (b?.rank ?? 0) - (a?.rank ?? 0)).slice(0, 14)
    if (tags.length) {
      side.append(U.el('div', { class: 'side-card' }, [
        U.el('h3', { class: 'side-card-title', text: T('Tags') }),
        U.el('div', { class: 'side-tags' }, tags.map(tag =>
          U.el('span', {
            class: 'tag-chip' + (tag.isMediaSpoiler || tag.isGeneralSpoiler ? ' spoiler' : ''),
            title: tag.rank ? tag.rank + '%' : null,
            text: tag.name
          })))
      ]))
    }

    // synonyms (compact)
    if (media.synonyms?.length) {
      side.append(U.el('div', { class: 'side-card' }, [
        U.el('h3', { class: 'side-card-title', text: T('Also known as') }),
        U.el('div', { class: 'side-synonyms', text: media.synonyms.slice(0, 4).join(' · ') })
      ]))
    }

    return side
  },

  // status editor attached to the Play button, like the original EntryEditor
  entrySelect (media) {
    const entry = Store.entry(media.id)
    const select = U.el('select', {
      class: 'entry-select',
      title: T('List status'),
      onchange: e => {
        if (e.target.value === '') {
          Store.removeEntry(media.id)
          U.toast(T('Removed from list'))
        } else {
          Store.saveEntry(media, { status: e.target.value })
          U.toast(`Set to ${U.listStatusMap[e.target.value]}`)
        }
        window.App.navigate()
      }
    }, [
      U.el('option', { value: '', text: entry ? T('✕ Remove from list') : T('＋ Add to List') }),
      ...Object.entries(U.listStatusMap).map(([value, label]) =>
        U.el('option', { value, text: label, ...(entry?.status === value ? { selected: '' } : {}) }))
    ])
    return select
  },

  renderTabEpisodes (wrap, media) {
    const list = U.el('div', { class: 'episodes' }, [U.el('div', { class: 'spinner' })])
    wrap.append(list)
    this.renderEpisodes(list, media).catch(() => {
      list.replaceChildren(U.el('div', { class: 'empty-state', text: T('No episode data available.') }))
    })
  },

  /**
   * Where this title sits in its franchise, and what it is attached to.
   *
   * Two different questions, so two blocks. The relation graph answers "what
   * is next to this one"; it cannot answer "what do I watch first", because
   * season three does not link to season one and the films are attached to
   * whichever entry happened to spawn them. The watch order above comes from
   * the franchise endpoint, which walks past the immediate neighbours and
   * sorts by release date — a total order, which the graph is not.
   */
  async renderTabRelations (wrap, media) {
    if (media.yumeId) await this.renderWatchOrder(wrap, media)

    const relations = (media.relations?.edges ?? [])
      .filter(e => e.node?.type !== 'MANGA' && e.relationType !== 'CHARACTER' && e.node?.coverImage)
    if (!relations.length) {
      if (!wrap.childElementCount) wrap.append(U.el('div', { class: 'empty-state', text: T('No known relations.') }))
      return
    }
    wrap.append(U.el('h3', { class: 'detail-section-title', text: T('Related') }))
    const row = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;flex-wrap:wrap;' })
    for (const edge of relations) {
      const card = C.card(edge.node)
      card.prepend(U.el('div', { class: 'relation-label', text: (edge.relationType ?? '').replaceAll('_', ' ') }))
      row.append(card)
    }
    wrap.append(row)
  },

  /** Release order, grouped the way a viewer thinks about a franchise. */
  FRANCHISE_GROUPS: [
    ['seasons', 'Seasons', ['TV', 'TV_SHORT', 'ONA']],
    ['films', 'Films', ['MOVIE']],
    ['extras', 'Specials & OVAs', ['SPECIAL', 'OVA', 'MUSIC']]
  ],

  async renderWatchOrder (wrap, media) {
    const result = await Catalogue.franchise(media.yumeId)
    const entries = result.data
    // One entry is this title on its own: a franchise of one is not a
    // franchise, and a heading over a single card is noise.
    if (entries.length < 2) return

    const box = U.el('div', { class: 'franchise' })
    box.append(U.el('h3', { class: 'detail-section-title', text: T('Watch order') }))

    for (const [key, label, formats] of this.FRANCHISE_GROUPS) {
      const inGroup = entries.filter(e => formats.includes(e.format))
      if (!inGroup.length) continue
      box.append(U.el('div', { class: 'franchise-group', text: T(label) }))
      const list = U.el('div', { class: 'franchise-list', dataset: { group: key } })
      for (const e of inGroup) {
        const current = e.id === media.yumeId
        const year = e.start_date ? String(e.start_date).slice(0, 4) : (e.season_year ?? null)
        list.append(U.el(current ? 'div' : 'a', {
          class: 'franchise-item' + (current ? ' current' : ''),
          // Navigate by whichever id the rest of the client understands, the
          // same rule the relation cards use.
          ...(current ? {} : { href: `#/anime/${e.anilist_id ?? e.id}` })
        }, [
          U.el('span', { class: 'franchise-year', text: year ? String(year) : '—' }),
          U.el('span', { class: 'franchise-title', text: e.canonical_title }),
          U.el('span', {
            class: 'franchise-meta',
            text: [e.episode_count ? `${e.episode_count} ep` : null, current ? T('you are here') : null]
              .filter(Boolean).join(' · ')
          })
        ]))
      }
      box.append(list)
    }

    // Only said when it is true: a franchise big enough to be cut off is one
    // where "this is not all of it" is worth knowing.
    if (result.truncated) {
      box.append(U.el('p', { class: 'franchise-note', text: T('Only the closest entries are shown — this franchise is larger.') }))
    }
    wrap.append(box)
  },

  /**
   * Ask metadata extensions about this title.
   *
   * Cached on the page instance for the life of the render: the characters and
   * the recommendations tabs both want the answer, and they are drawn at
   * different times, so without this the same query runs twice.
   *
   * Returns [] on any failure. An empty tab is the status quo; an error state
   * where a tab used to be is a regression.
   */
  async _extensionMetadata (media) {
    const host = window.ExtensionHost
    if (!host?.collect || !media?.id) return []
    if (this._metaCache?.id === media.id) return this._metaCache.records

    let records = []
    try {
      const query = window.StreamEngine?.buildQuery(media, 1) ?? { anilistId: media.id }
      const out = await host.collect('metadata', query, { types: ['metadata'] })
      records = out.results ?? []
    } catch (e) {
      records = []
    }
    this._metaCache = { id: media.id, records }
    return records
  },

  /**
   * Swap in translated text from a metadata extension.
   *
   * Only where the catalogue has none: `_lang` says which language each field
   * actually resolved to, and overwriting an editorial Hungarian synopsis with
   * a feed's version would be the extension outranking the catalogue, which is
   * backwards.
   */
  async _applyTranslations (media, { titleEl, desc, descNote, wantLang }) {
    const records = await this._extensionMetadata(media)
    const pick = field => records.find(r =>
      r?.kind === 'translation' && r.field === field && r.language === wantLang && typeof r.text === 'string' && r.text.trim()
    )

    if (media._lang?.title !== wantLang) {
      const title = pick('title')
      if (title && titleEl.isConnected) titleEl.textContent = title.text
    }

    if (media._lang?.synopsis !== wantLang) {
      const synopsis = pick('description')
      if (synopsis && desc.isConnected) {
        desc.textContent = synopsis.text
        // The note said this had not been translated yet. It has now.
        descNote?.remove()
      }
    }
  },

  _charCard (name, role, image) {
    return U.el('div', { class: 'char-card' }, [
      U.el('img', { src: image ?? '', alt: name ?? '', loading: 'lazy' }),
      U.el('div', { class: 'char-name', text: name ?? '' }),
      U.el('div', { class: 'char-role', text: role ?? '' })
    ])
  },

  async renderTabCharacters (wrap, media) {
    let characters = media.characters?.edges ?? []

    // A catalogue title carries no cast on the record: it is fetched when this
    // tab is opened, because most visits never open it. Before the deep
    // AniList pass existed these tables were empty and this tab could only
    // ever say "No character data." for a locally-served title.
    if (!characters.length && media.yumeId) {
      characters = await Catalogue.characters(media.yumeId)
      if (characters.length) media.characters = { edges: characters }
    }

    if (characters.length) {
      const crow = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;flex-wrap:wrap;' })
      for (const edge of characters) {
        crow.append(this._charCard(edge.node.name?.userPreferred, edge.role, edge.node.image?.large))
      }
      wrap.append(crow)

      // Staff sits under the cast on the same tab: it comes from the same
      // import and nobody looks for a director on a separate screen.
      const staff = media.staff?.edges ?? await Catalogue.staff(media.yumeId)
      if (staff.length) {
        wrap.append(U.el('h3', { class: 'sec-sub', text: T('Staff') }))
        const srow = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;flex-wrap:wrap;' })
        for (const edge of staff) {
          srow.append(this._charCard(edge.node.name?.userPreferred, edge.role, edge.node.image?.large))
        }
        wrap.append(srow)
      }
      return
    }

    // Still nothing: no backend, or a title the deep pass has not reached.
    // Metadata extensions are the way to fill it.
    const placeholder = U.el('div', { class: 'empty-state', text: T('No character data.') })
    wrap.append(placeholder)

    const records = await this._extensionMetadata(media)
    const cast = records.filter(r => r?.kind === 'character' && r.name)
    const staff = records.filter(r => r?.kind === 'staff' && r.name)
    if (!cast.length && !staff.length) return

    placeholder.remove()

    if (cast.length) {
      const crow = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;flex-wrap:wrap;' })
      for (const row of cast) crow.append(this._charCard(row.name, row.role, row.image))
      wrap.append(crow)
    }

    // Staff has no tab of its own; a second section under the cast is where a
    // viewer would look for it, and adding a tab for it would push the row
    // past what fits on a phone.
    if (staff.length) {
      wrap.append(U.el('h3', { class: 'detail-section-title', text: T('Staff') }))
      const srow = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;flex-wrap:wrap;' })
      for (const row of staff) srow.append(this._charCard(row.name, row.role, row.image))
      wrap.append(srow)
    }
  },

  renderTabComments (wrap, media) {
    wrap.append(C.commentsSection(media))
  },

  async renderTabRecommendations (wrap, media) {
    let recs = (media.recommendations?.nodes ?? []).map(n => n.mediaRecommendation).filter(Boolean)

    // Same as the cast: fetched on open, not with the record.
    if (!recs.length && media.yumeId) recs = await Catalogue.recommendations(media.yumeId)

    if (recs.length) {
      wrap.append(C.grid(recs))
      return
    }

    const placeholder = U.el('div', { class: 'empty-state', text: T('No recommendations yet.') })
    wrap.append(placeholder)

    const records = await this._extensionMetadata(media)
    const fromExtensions = records
      .filter(r => r?.kind === 'recommendation' && r.anilistId)
      // Back into the shape C.grid draws, so the cards are the same cards
      // everywhere else on the site rather than a second kind that looks
      // almost right.
      .map(r => ({
        id: r.anilistId,
        title: { userPreferred: r.title, romaji: r.titleRomaji, english: r.titleEnglish },
        coverImage: { large: r.image },
        format: r.format || null,
        averageScore: r.score || null,
        episodes: r.episodes || null
      }))

    if (!fromExtensions.length) return
    placeholder.remove()
    wrap.append(C.grid(fromExtensions))
  },

  async renderEpisodes (wrap, media) {
    const episodes = await Catalogue.episodes(media)

    if (!episodes.length) {
      wrap.replaceChildren(U.el('div', { class: 'empty-state', text: media.status === 'NOT_YET_RELEASED' ? 'Not yet aired.' : 'No episode data available.' }))
      return
    }

    // range paging for long series (reference-style "1 – 25" chips)
    const RANGE = 25
    let rangeStart = 1
    if (episodes.length > 30) {
      const entryProg = Store.entry(media.id)?.progress ?? 0
      rangeStart = Math.floor(Math.max(0, Math.min(entryProg, episodes.length - 1)) / RANGE) * RANGE + 1
    }

    const render = () => {
      const entry = Store.entry(media.id)
      const progress = entry?.progress ?? 0
      wrap.replaceChildren()

      // header: count + duration + range chips
      const head = U.el('div', { class: 'eplist-head' }, [
        U.el('div', { class: 'eplist-title' }, [
          U.el('b', { text: T('Episodes') }),
          U.el('span', { text: `${episodes.length} episodes${media.duration ? ` • ${media.duration} min each` : ''}` })
        ])
      ])
      if (episodes.length > 30) {
        const ranges = U.el('div', { class: 'eplist-ranges' })
        for (let s = 1; s <= episodes.length; s += RANGE) {
          const e = Math.min(s + RANGE - 1, episodes.length)
          ranges.append(U.el('button', {
            class: 'eplist-range' + (s === rangeStart ? ' active' : ''),
            text: `${s} – ${e}`,
            onclick: () => { rangeStart = s; render() }
          }))
        }
        head.append(ranges)
      }
      wrap.append(head)

      const visible = episodes.length > 30
        ? episodes.filter(ep => ep.episode >= rangeStart && ep.episode < rangeStart + RANGE)
        : episodes

      /*
       * Can this episode be played at all?
       *
       * `sourceCount` is undefined when the episode list came from ani.zip —
       * we do not hold the episode, so we do not know, and "unknown" must not
       * gate the same way as "none". A loaded provider extension can answer
       * for an episode the catalogue has nothing registered for, so it counts
       * too; once nothing is installed, the gate is the catalogue's own
       * sources and nothing else.
       */
      const providers = window.StreamEngine?.hasProviders?.() ?? false
      const playable = ep => ep.sourceCount === undefined || ep.sourceCount > 0 || providers

      for (const ep of visible) {
        const watched = progress >= ep.episode
        const canPlay = playable(ep)
        const thumb = U.el('div', { class: 'episode-thumb' }, [
          ep.image ? U.el('img', { src: ep.image, loading: 'lazy', alt: `Episode ${ep.episode}` }) : null,
          U.el('div', { class: 'ep-num', text: T('Ep ') + ep.episode }),
          ep.filler ? U.el('div', { class: 'ep-filler', text: T('FILLER') }) : null
        ])
        if (watched) {
          thumb.append(U.el('div', { class: 'ep-watched-overlay' }, [U.svg(C.CHECK, 24)]))
        }

        const metaText = [ep.airdate ? U.airDate(ep.airdate) : null, ep.runtime ? `${ep.runtime} min` : null, ep.rating ? `★ ${ep.rating}` : null].filter(Boolean).join(' • ')

        wrap.append(U.el('div', {
          class: 'episode' + (canPlay ? '' : ' episode-unplayable'),
          title: canPlay ? `Watch episode ${ep.episode}` : T('Nothing to play this episode from yet.'),
          // No handler rather than a handler that refuses: an episode that
          // cannot play should not look like a button at all.
          ...(canPlay ? { onclick: () => { window.location.hash = `#/watch/${media.id}:${ep.episode}` } } : {})
        }, [
          thumb,
          U.el('div', { class: 'episode-body' }, [
            U.el('div', { style: 'display:flex;align-items:center;gap:.5rem;' }, [
              U.el('div', { class: 'episode-title', style: 'flex-grow:1;', text: ep.title ?? `Episode ${ep.episode}` }),
              canPlay ? null : U.el('span', { class: 'episode-nosource', text: T('No source') }),
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
            ep.summary ? U.el('div', { class: 'episode-summary', text: ep.summary }) : null,
            (() => {
              // in-episode resume position → thin progress bar (reference style)
              const resume = Store.getResume(media.id, ep.episode)
              if (!resume) return null
              const totalSec = (ep.runtime ?? media.duration ?? 24) * 60
              return U.el('div', { class: 'episode-resume' }, [
                U.el('div', { style: `width:${Math.min(100, resume / totalSec * 100)}%;` })
              ])
            })()
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
