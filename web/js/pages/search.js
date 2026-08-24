/* global C, Catalogue, MutationObserver, U, window, T */
// Search page — text search plus the same filters the original search route has
// (genre, season, year, format, status, sort), with load-more pagination.

const PageSearch = {
  GENRES: ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'],
  FORMATS: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA'],
  STATUSES: ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED', 'CANCELLED'],
  SORTS: [
    ['TRENDING_DESC', 'Trending'],
    ['POPULARITY_DESC', 'Popularity'],
    ['SCORE_DESC', 'Score'],
    ['START_DATE_DESC', 'Newest'],
    ['TITLE_ROMAJI', 'Title']
  ],

  render (root, params) {
    const state = {
      search: params.get('q') ?? '',
      genre: params.get('genre') ?? '',
      season: params.get('season') ?? '',
      year: params.get('year') ?? '',
      format: params.get('format') ?? '',
      status: params.get('status') ?? '',
      sort: params.get('sort') ?? 'TRENDING_DESC',
      page: 1
    }

    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    const years = []
    for (let y = new Date().getFullYear() + 1; y >= 1970; y--) years.push(y)

    const mkSelect = (label, key, options, labelMap = v => v) => {
      const select = U.el('select', {
        class: 'select',
        onchange: e => { state[key] = e.target.value; reset() }
      }, [
        U.el('option', { value: '', text: T('Any') }),
        ...options.map(value => U.el('option', {
          value: String(value),
          text: labelMap(value),
          ...(String(value) === String(state[key]) ? { selected: '' } : {})
        }))
      ])
      return U.el('div', { class: 'filter-group' }, [U.el('label', { text: label }), select])
    }

    const searchInput = U.el('input', {
      class: 'input search-input-big',
      type: 'text',
      placeholder: T('Search anime...'),
      value: state.search,
      oninput: U.debounce(e => { state.search = e.target.value; reset() })
    })

    // image search (trace.moe): button, paste or drop a frame anywhere
    const imageSearch = async blob => {
      results.replaceChildren(U.el('div', { class: 'spinner' }))
      loadMoreWrap.replaceChildren()
      try {
        const res = await fetch('https://api.trace.moe/search?anilistInfo&cutBorders', { method: 'POST', body: blob })
        if (!res.ok) throw new Error('trace.moe ' + res.status)
        const json = await res.json()
        const hits = (json.result ?? []).filter(r => r.similarity >= 0.8 && r.anilist?.id)
        const ids = [...new Set(hits.map(r => r.anilist.id))].slice(0, 10)
        if (!ids.length) {
          results.replaceChildren(U.el('div', { class: 'empty-state', text: T('No confident match for that frame.') }))
          return
        }
        const page = await Catalogue.searchOrAniList({ ids, perPage: 20 })
        results.replaceChildren(C.grid(page.media ?? []))
        U.toast(`Best match: ${Math.round(hits[0].similarity * 100)}% • episode ${hits[0].episode ?? '?'}`)
      } catch (e) {
        results.replaceChildren(U.el('div', { class: 'error-state', text: T('Image search failed: ') + e.message }))
      }
    }

    const filePick = U.el('input', { type: 'file', accept: 'image/*', style: 'display:none;' })
    filePick.addEventListener('change', () => { if (filePick.files[0]) imageSearch(filePick.files[0]) })
    const imageBtn = U.el('button', { class: 'btn btn-ghost', title: T('Search by image (or paste/drop a frame)'), onclick: () => filePick.click() }, [document.createTextNode(T('Upload a frame'))])

    const onPaste = e => {
      const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'))
      if (item) imageSearch(item.getAsFile())
    }
    const onDrop = e => {
      e.preventDefault()
      const file = [...(e.dataTransfer?.files ?? [])].find(f => f.type.startsWith('image/'))
      if (file) imageSearch(file)
    }
    document.addEventListener('paste', onPaste)
    document.addEventListener('dragover', e => e.preventDefault())
    document.addEventListener('drop', onDrop)
    const cleanup = new MutationObserver(() => {
      if (!document.body.contains(pad)) {
        document.removeEventListener('paste', onPaste)
        document.removeEventListener('drop', onDrop)
        cleanup.disconnect()
      }
    })
    cleanup.observe(document.getElementById('page'), { childList: true })

    const imageOn = !window.App || window.App.featureOn('image_search')

    /**
     * The filter panel is collapsible, and starts collapsed on a phone.
     *
     * At 390px it filled the entire first screen, so the results it filters
     * were never visible at the same time as the filters — every search meant
     * scrolling past the whole form to see whether it had worked. A <details>
     * carries its own toggle and keyboard behaviour, so nothing here has to
     * reimplement either.
     *
     * Open on anything wider, where the panel is a row and costs nothing.
     */
    const filterBox = U.el('details', { class: 'filters-box', open: !window.matchMedia('(max-width: 560px)').matches }, [
      U.el('summary', { class: 'filters-summary' }, [
        U.el('span', { text: T('Filters') }),
        U.el('span', { class: 'filters-hint', text: T('search, genre, season, year, format, status, sort') })
      ])
    ])
    pad.append(filterBox)
    filterBox.append(U.el('div', { class: 'filters' }, [
      U.el('div', { class: 'filter-group', style: 'flex-grow:1;' }, [U.el('label', { text: T('Search') }), searchInput]),
      // A blank label put this control under the neighbouring field's heading,
      // so on a phone the image-search button read as part of GENRE. It says
      // what it is now.
      imageOn ? U.el('div', { class: 'filter-group' }, [U.el('label', { text: T('By image') }), imageBtn]) : null,
      imageOn ? filePick : null,
      mkSelect('Genre', 'genre', this.GENRES),
      mkSelect('Season', 'season', Object.keys(U.seasonMap), v => U.seasonMap[v]),
      mkSelect('Year', 'year', years),
      mkSelect('Format', 'format', this.FORMATS, v => U.formatMap[v]),
      mkSelect('Status', 'status', this.STATUSES, v => U.statusMap[v]),
      mkSelect('Sort', 'sort', this.SORTS.map(([v]) => v), v => this.SORTS.find(([value]) => value === v)?.[1] ?? v)
    ]))

    const results = U.el('div')
    const loadMoreWrap = U.el('div', { class: 'load-more-wrap' })
    pad.append(results, loadMoreWrap)

    let token = 0

    const variables = () => ({
      search: state.search || null,
      genre: state.genre ? [state.genre] : null,
      season: state.season || null,
      seasonYear: state.year ? Number(state.year) : null,
      format: state.format ? [state.format] : null,
      status: state.status ? [state.status] : null,
      sort: [state.search && state.sort === 'TRENDING_DESC' ? 'SEARCH_MATCH' : state.sort],
      page: state.page,
      perPage: 30
    })

    const load = async (append = false) => {
      const current = ++token
      if (!append) {
        results.replaceChildren(U.el('div', { class: 'grid' }, Array.from({ length: 12 }, () => C.skeletonCard())))
        loadMoreWrap.replaceChildren()
      } else {
        loadMoreWrap.replaceChildren(U.el('div', { class: 'spinner' }))
      }

      try {
        const page = await Catalogue.searchOrAniList(variables())
        if (current !== token) return

        const grid = append ? results.querySelector('.grid') : null
        const media = page.media ?? []

        if (!append) {
          if (!media.length) {
            results.replaceChildren(U.el('div', { class: 'empty-state', text: T('No results found.') }))
          } else {
            results.replaceChildren(C.grid(media))
          }
        } else if (grid) {
          for (const m of media) grid.append(C.card(m))
        }

        loadMoreWrap.replaceChildren()
        if (page.pageInfo?.hasNextPage) {
          loadMoreWrap.append(U.el('button', {
            class: 'btn btn-secondary',
            onclick: () => { state.page++; load(true) }
          }, [document.createTextNode(T('Load more'))]))
        }
      } catch (e) {
        if (current !== token) return
        results.replaceChildren(U.el('div', { class: 'error-state', text: T('Failed to load results: ') + e.message }))
        loadMoreWrap.replaceChildren()
      }
    }

    const reset = () => { state.page = 1; load(false) }

    load(false)
  }
}

window.PageSearch = PageSearch
