/* global MutationObserver */
// Kereső és böngésző — #/search?q=…&genre=…&season=…&year=…&format=…&status=…&sort=…
//
// 2026-09, újratervezve. Ami változott, és miért:
//
//   * AZ ÁLLAPOT A CÍMBEN ÉL. A szűrők eddig csak betöltéskor olvastak a
//     címből, utána nem írtak bele: egy szűrt találati lista nem volt
//     megosztható, és a vissza gomb az adatlapról a szűretlen keresőbe tért
//     vissza. Most minden változás `replaceState`-tel a címbe kerül.
//
//   * A RENDEZÉS SZÖVEGES KERESÉSNÉL IS HAT. A katalógus keresője ismeri
//     (relevancia, népszerűség, pontszám, legújabb, cím) — a kliens eddig nem
//     küldte el. A „Felkapott" szöveges keresésnél relevanciát jelent: a
//     keresőnek nincs felkapottsági sorrendje, és ezt ki is írjuk.
//
//   * AKTÍV SZŰRŐK CSEMPÉKBEN, egy „Mind törlése" gombbal. Telefonon a szűrők
//     egy lenyíló panelben vannak, a gombon a számukkal.
//
// Csak azokat a szűrőket kínáljuk, amiket a katalógus végpontja elfogad (lásd
// apps/api/src/modules/catalogue/public-routes.ts): műfaj, évad, év, formátum,
// állapot, rendezés.

import { featureOn } from '../shared/lib/site-config.js'
import { Catalogue } from '../entities/anime/catalogue.js'
import { C } from '../shared/ui/components.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { P } from '../shared/ui/primitives.js'
import { trackEvent } from '../shared/lib/analytics.js'
import { U } from '../shared/lib/dom.js'

const SEARCH_ICON = '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'
const X_ICON = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
const FILTER_ICON = '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'
const IMAGE_ICON = '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'

export const PageSearch = {
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
  FILTER_KEYS: ['genre', 'season', 'year', 'format', 'status'],
  PER_PAGE: 30,

  render (root, params) {
    const state = {
      search: params.get('q') ?? '',
      genre: params.get('genre') ?? '',
      season: params.get('season') ?? '',
      year: params.get('year') ?? '',
      format: params.get('format') ?? '',
      status: params.get('status') ?? '',
      sort: this.SORTS.some(([v]) => v === params.get('sort')) ? params.get('sort') : 'TRENDING_DESC',
      page: 1,
      cursor: null
    }

    const pad = U.el('div', { class: 'page-pad search-page' })
    root.append(pad)

    pad.append(U.el('header', { class: 'page-header' }, [
      U.el('div', { class: 'page-header-text' }, [
        U.el('h1', { class: 'page-title', text: T('Search') }),
        U.el('p', { class: 'page-sub', text: T('Find a title by name, or browse the catalogue with filters.') })
      ])
    ]))

    // ---- a keresőmező ----
    const input = U.el('input', {
      class: 'input search-field-input',
      type: 'search',
      id: 'search-q',
      name: 'q',
      placeholder: T('Title, alternative title or abbreviation'),
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      value: state.search
    })
    const clear = U.el('button', {
      class: 'icon-btn icon-btn-sm icon-btn-quiet input-trail',
      type: 'button',
      'aria-label': T('Clear search'),
      hidden: !state.search,
      onclick: () => { input.value = ''; clear.hidden = true; state.search = ''; reset(); input.focus() }
    }, [U.svg(X_ICON, 16)])
    const typed = U.debounce(() => { state.search = input.value.trim(); reset() }, 350)
    input.addEventListener('input', () => { clear.hidden = !input.value; typed() })
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); state.search = input.value.trim(); reset() }
    })

    // ---- szűrők ----
    const years = []
    for (let y = new Date().getFullYear() + 1; y >= 1970; y--) years.push(y)
    const selects = {}
    const mkSelect = (label, key, options, labelMap = v => String(v)) => {
      const id = `search-${key}`
      const select = U.el('select', {
        class: 'select',
        id,
        name: key,
        onchange: () => { state[key] = select.value; reset() }
      }, [
        key === 'sort' ? null : U.el('option', { value: '', text: T('Any') }),
        ...options.map(value => U.el('option', {
          value: String(value),
          text: labelMap(value),
          selected: String(value) === String(state[key])
        }))
      ])
      selects[key] = select
      return U.el('div', { class: 'field search-filter' }, [
        U.el('label', { class: 'field-label', for: id, text: T(label) }),
        select
      ])
    }

    const filterGrid = U.el('div', { class: 'search-filters', id: 'search-filters' }, [
      mkSelect('Genre', 'genre', this.GENRES, v => T(v)),
      mkSelect('Season', 'season', Object.keys(U.seasonMap), v => T(U.seasonMap[v])),
      mkSelect('Year', 'year', years),
      mkSelect('Format', 'format', this.FORMATS, v => T(U.formatMap[v] ?? v)),
      mkSelect('Status', 'status', this.STATUSES, v => T(U.statusMap[v] ?? v))
    ])
    const sortField = mkSelect('Sort', 'sort', this.SORTS.map(([v]) => v), v => T(this.SORTS.find(([value]) => value === v)?.[1] ?? v))
    sortField.classList.add('search-sort')

    // Telefonon a szűrők egy gomb mögött — a számukkal.
    const filterToggle = U.el('button', {
      class: 'btn btn-secondary search-filter-toggle',
      type: 'button',
      'aria-controls': 'search-filters',
      'aria-expanded': 'false',
      onclick: () => {
        const open = filterGrid.classList.toggle('open')
        filterToggle.setAttribute('aria-expanded', String(open))
      }
    })

    const imageOn = featureOn('image_search')
    const filePick = U.el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true', tabindex: '-1' })
    const imageBtn = imageOn
      ? U.el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        title: T('Search by image (or paste/drop a frame)'),
        onclick: () => filePick.click()
      }, [U.svg(IMAGE_ICON, 16), U.el('span', { text: T('By image') })])
      : null

    pad.append(U.el('div', { class: 'search-bar surface' }, [
      U.el('div', { class: 'search-bar-row' }, [
        U.el('label', { class: 'sr-only', for: 'search-q', text: T('Search anime') }),
        U.el('div', { class: 'input-wrap search-field' }, [U.svg(SEARCH_ICON, 18), input, clear]),
        filterToggle,
        imageBtn,
        imageOn ? filePick : null
      ]),
      filterGrid,
      U.el('div', { class: 'search-bar-foot' }, [
        U.el('div', { class: 'chips search-active', 'aria-live': 'polite' }),
        sortField
      ])
    ]))

    const activeRow = pad.querySelector('.search-active')
    const summary = U.el('p', { class: 'search-summary', 'aria-live': 'polite' })
    const results = U.el('div', { class: 'search-results' })
    const loadMoreWrap = U.el('div', { class: 'load-more-wrap' })
    pad.append(summary, results, loadMoreWrap)

    const labelOf = (key, value) => ({
      genre: () => T(value),
      season: () => T(U.seasonMap[value] ?? value),
      year: () => String(value),
      format: () => T(U.formatMap[value] ?? value),
      status: () => T(U.statusMap[value] ?? value)
    })[key]()

    const paintChrome = () => {
      const active = this.FILTER_KEYS.filter(k => state[k])
      filterToggle.replaceChildren(...[U.svg(FILTER_ICON, 16), U.el('span', { text: T('Filters') }),
        active.length ? U.el('span', { class: 'tab-count', text: String(active.length) }) : null].filter(Boolean))
      activeRow.replaceChildren(...active.map(key => U.el('button', {
        class: 'chip chip-removable',
        type: 'button',
        'aria-label': I18n.f(T('Remove filter: {name}'), { name: labelOf(key, state[key]) }),
        onclick: () => {
          state[key] = ''
          selects[key].value = ''
          reset()
        }
      }, [document.createTextNode(labelOf(key, state[key])), U.svg(X_ICON, 14)])))
      if (active.length > 1) {
        activeRow.append(U.el('button', {
          class: 'link search-clear-all',
          type: 'button',
          onclick: () => {
            for (const key of this.FILTER_KEYS) { state[key] = ''; selects[key].value = '' }
            reset()
          }
        }, [document.createTextNode(T('Clear all'))]))
      }
      // A szöveges keresésnek nincs felkapottsági sorrendje: relevancia szerint rendez.
      const trendingOption = selects.sort.querySelector('option[value="TRENDING_DESC"]')
      if (trendingOption) trendingOption.textContent = state.search ? T('Relevance') : T('Trending')
    }

    // ---- az állapot a címben ----
    const syncUrl = () => {
      const q = new URLSearchParams()
      if (state.search) q.set('q', state.search)
      for (const key of this.FILTER_KEYS) if (state[key]) q.set(key, state[key])
      if (state.sort !== 'TRENDING_DESC') q.set('sort', state.sort)
      const next = '#/search' + (q.toString() ? '?' + q.toString() : '')
      if (window.location.hash !== next) window.history.replaceState(window.history.state, '', next)
    }

    const variables = () => ({
      search: state.search || null,
      genre: state.genre ? [state.genre] : null,
      season: state.season || null,
      seasonYear: state.year ? Number(state.year) : null,
      format: state.format ? [state.format] : null,
      status: state.status ? [state.status] : null,
      sort: [state.search && state.sort === 'TRENDING_DESC' ? 'SEARCH_MATCH' : state.sort],
      page: state.page,
      offset: (state.page - 1) * this.PER_PAGE,
      cursor: state.cursor,
      perPage: this.PER_PAGE
    })

    // A találatra kattintás a keresés minőségéről szól: hányadik találat volt.
    results.addEventListener('click', event => {
      const card = event.target?.closest?.('a.card')
      if (!card) return
      const id = String(card.getAttribute('href') ?? '').split('#/anime/')[1]
      if (!id) return
      trackEvent('search.result.open', {
        subjectType: 'anime',
        subjectId: id,
        position: [...results.querySelectorAll('a.card')].indexOf(card) + 1
      })
    })

    let token = 0
    let shown = 0
    const load = async (append = false) => {
      const current = ++token
      if (!append) {
        shown = 0
        summary.textContent = ''
        results.setAttribute('aria-busy', 'true')
        results.replaceChildren(U.el('div', { class: 'grid' }, Array.from({ length: 12 }, () => C.skeletonCard())))
        loadMoreWrap.replaceChildren()
      } else {
        loadMoreWrap.replaceChildren(P.spinner({ small: true }))
      }
      try {
        const page = await Catalogue.searchOrAniList(variables())
        if (current !== token) return
        results.removeAttribute('aria-busy')
        const media = page.media ?? []
        if (!append) {
          if (!media.length) {
            const anyFilter = this.FILTER_KEYS.some(k => state[k])
            results.replaceChildren(P.emptyState(T('No results found.'), {
              title: state.search ? I18n.f(T('Nothing matches “{q}”'), { q: state.search }) : T('Nothing matches these filters'),
              icon: SEARCH_ICON,
              action: anyFilter
                ? P.button(T('Clear filters'), {
                  variant: 'secondary',
                  onclick: () => {
                    for (const key of this.FILTER_KEYS) { state[key] = ''; selects[key].value = '' }
                    reset()
                  }
                })
                : null
            }))
          } else {
            results.replaceChildren(C.grid(media))
          }
        } else {
          const grid = results.querySelector('.grid')
          for (const m of media) grid?.append(C.card(m))
        }
        shown += media.length
        if (shown) summary.textContent = I18n.f(T(page.pageInfo?.hasNextPage ? '{n}+ titles' : '{n} titles'), { n: shown })
        state.cursor = page.cursor ?? null
        loadMoreWrap.replaceChildren()
        if (page.pageInfo?.hasNextPage) {
          loadMoreWrap.append(P.button(T('Load more'), {
            variant: 'secondary',
            onclick: () => { state.page++; load(true) }
          }))
        }
      } catch (e) {
        if (current !== token) return
        results.removeAttribute('aria-busy')
        results.replaceChildren(C.errorState(e, () => load(append)))
        loadMoreWrap.replaceChildren()
      }
    }

    const reset = () => {
      state.page = 1
      state.cursor = null
      paintChrome()
      syncUrl()
      load(false)
    }

    // ---- képkeresés (trace.moe) ----
    //
    // A kép egy KÜLSŐ szolgáltatáshoz megy (api.trace.moe): ezt a gomb címe
    // és az eredmény is kimondja. Csak akkor él, ha az üzemeltető bekapcsolta.
    if (imageOn) {
      const imageSearch = async blob => {
        results.setAttribute('aria-busy', 'true')
        results.replaceChildren(P.spinner())
        loadMoreWrap.replaceChildren()
        summary.textContent = T('Looking the frame up at trace.moe…')
        try {
          const res = await fetch('https://api.trace.moe/search?anilistInfo&cutBorders', { method: 'POST', body: blob })
          if (!res.ok) throw new Error('trace.moe ' + res.status)
          const json = await res.json()
          const hits = (json.result ?? []).filter(r => r.similarity >= 0.8 && r.anilist?.id)
          const ids = [...new Set(hits.map(r => r.anilist.id))].slice(0, 10)
          results.removeAttribute('aria-busy')
          if (!ids.length) {
            summary.textContent = ''
            results.replaceChildren(P.emptyState(T('No confident match for that frame.'), { icon: IMAGE_ICON }))
            return
          }
          const page = await Catalogue.searchOrAniList({ ids, perPage: 20 })
          results.replaceChildren(C.grid(page.media ?? []))
          summary.textContent = I18n.f(T('Best match: {pct}% · episode {ep} (via trace.moe)'), {
            pct: Math.round(hits[0].similarity * 100),
            ep: hits[0].episode ?? '?'
          })
        } catch (e) {
          results.removeAttribute('aria-busy')
          summary.textContent = ''
          results.replaceChildren(C.errorState(T('Image search failed: ') + e.message))
        }
      }
      filePick.addEventListener('change', () => { if (filePick.files[0]) imageSearch(filePick.files[0]) })
      const onPaste = e => {
        const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'))
        if (item) imageSearch(item.getAsFile())
      }
      const onDragOver = e => e.preventDefault()
      const onDrop = e => {
        e.preventDefault()
        const file = [...(e.dataTransfer?.files ?? [])].find(f => f.type.startsWith('image/'))
        if (file) imageSearch(file)
      }
      document.addEventListener('paste', onPaste)
      document.addEventListener('dragover', onDragOver)
      document.addEventListener('drop', onDrop)
      // A dokumentumszintű figyelők a lappal együtt mennek.
      const cleanup = new MutationObserver(() => {
        if (document.body.contains(pad)) return
        document.removeEventListener('paste', onPaste)
        document.removeEventListener('dragover', onDragOver)
        document.removeEventListener('drop', onDrop)
        cleanup.disconnect()
      })
      cleanup.observe(document.getElementById('page'), { childList: true })
    }

    paintChrome()
    load(false)
    // Üres keresővel a mező kapja a fókuszt — a néző gépelni jött.
    if (!state.search && !this.FILTER_KEYS.some(k => state[k])) {
      window.requestAnimationFrame(() => { if (window.matchMedia?.('(pointer: fine)').matches) input.focus({ preventScroll: true }) })
    }
  }
}
