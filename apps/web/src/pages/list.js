/* global CSS */
// Könyvtár — #/list?status=CURRENT|PLANNING|COMPLETED|PAUSED|DROPPED|REPEATING|FAVOURITES
//
// 2026-09, újratervezve:
//
//   * A SOR HIVATKOZÁS. Eddig egy `div` volt kattintáskezelővel: egérrel
//     megnyílt, billentyűzettel nem. Most a borító és a cím valódi linkek, a
//     vezérlők (±1 rész, állapot, törlés) mellettük külön gombok.
//
//   * A TÖRLÉS VISSZAVONHATÓ. Egy mellékattintás eddig nyom nélkül vitte el a
//     bejegyzést a haladással és a pontszámmal együtt; most a toast visszaadja.
//
//   * KERESÉS ÉS RENDEZÉS A KÖNYVTÁRON BELÜL, és a választott állapot a
//     címben él (`?status=`), így a főoldal „Továbbiak" linkje a megfelelő
//     fülre visz.

import { Catalogue } from '../entities/anime/catalogue.js'
import { C } from '../shared/ui/components.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { Store } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'

const PAGE = 60
const BOOK = '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'
const SEARCH = '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'

export const PageList = {
  render (root, params) {
    const tabs = [...Object.keys(U.listStatusMap), 'FAVOURITES']
    const wanted = params.get('status') ?? params.get('tab')
    const state = {
      tab: tabs.includes(wanted) ? wanted : 'CURRENT',
      shown: PAGE,
      query: '',
      sort: 'updated'
    }

    const pad = U.el('div', { class: 'page-pad lib-page' })
    root.append(pad)

    const total = Object.keys(Store.list()).length
    pad.append(U.el('header', { class: 'page-header' }, [
      U.el('div', { class: 'page-header-text' }, [
        U.el('h1', { class: 'page-title', text: T('Library') }),
        U.el('p', { class: 'page-sub', text: total ? I18n.f(T('{n} titles tracked'), { n: I18n.number(total) }) : T('Your anime, tracked') })
      ]),
      U.el('div', { class: 'page-header-actions' }, [
        U.el('a', { class: 'btn btn-secondary', href: '#/search' }, [U.svg(SEARCH, 16), document.createTextNode(T('Browse the catalogue'))])
      ])
    ]))

    const counts = () => {
      const list = Object.values(Store.list())
      const out = { FAVOURITES: Store.favourites().length }
      for (const key of Object.keys(U.listStatusMap)) out[key] = list.filter(e => e.status === key).length
      return out
    }

    const label = key => key === 'FAVOURITES' ? T('Favourites') : T(U.listStatusMap[key])
    const initial = counts()
    const bar = P.tabs(tabs.map(id => ({ id, label: label(id), count: initial[id] })), {
      selected: state.tab,
      label: T('Library'),
      onSelect: id => {
        state.tab = id
        state.shown = PAGE
        const url = '#/list' + (id === 'CURRENT' ? '' : `?status=${id}`)
        window.history.replaceState(window.history.state, '', url)
        renderContent()
      }
    })
    // A számok helyben frissülnek: a fülsor újraépítése elvinné a fókuszt.
    const refreshTabs = () => {
      const n = counts()
      for (const tab of bar.querySelectorAll('[role="tab"]')) {
        const count = tab.querySelector('.tab-count')
        if (count) count.textContent = String(n[tab.dataset.tab] ?? 0)
      }
    }

    const filter = U.el('input', {
      class: 'input',
      type: 'search',
      placeholder: T('Filter by title'),
      'aria-label': T('Filter by title'),
      oninput: U.debounce(() => { state.query = filter.value.trim().toLowerCase(); state.shown = PAGE; renderContent() }, 200)
    })
    const sort = P.select([
      ['updated', T('Recently updated')],
      ['title', T('Title')],
      ['score', T('Score')],
      ['progress', T('Progress')]
    ], { value: state.sort, 'aria-label': T('Sort'), onchange: () => { state.sort = sort.value; renderContent() } })

    const content = U.el('div', { class: 'lib-content' })
    bar.panel.append(
      U.el('div', { class: 'lib-toolbar' }, [
        U.el('div', { class: 'input-wrap lib-filter' }, [U.svg(SEARCH, 16), filter]),
        sort
      ]),
      content
    )
    pad.append(bar, bar.panel)

    const sorted = entries => {
      const title = e => U.title(e.media).toLowerCase()
      const by = {
        updated: (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
        title: (a, b) => title(a).localeCompare(title(b), I18n.locale()),
        score: (a, b) => (U.score(b.media) ?? 0) - (U.score(a.media) ?? 0),
        progress: (a, b) => (b.progress ?? 0) - (a.progress ?? 0)
      }[state.sort]
      return entries.sort(by)
    }

    const renderContent = async () => {
      content.replaceChildren()

      if (state.tab === 'FAVOURITES') {
        const favs = Store.favourites()
        if (!favs.length) {
          content.append(P.emptyState(T('Tap the heart on a title to keep it here.'), {
            title: T('No favourites yet.'),
            icon: C.HEART,
            action: U.el('a', { class: 'btn btn-primary', href: '#/search', text: T('Browse the catalogue') })
          }))
          return
        }
        content.append(U.el('div', { class: 'grid' }, favs.slice(0, 12).map(() => C.skeletonCard())))
        try {
          const page = await Catalogue.searchOrAniList({ ids: favs.slice(0, 50), perPage: 50 })
          const media = (page.media ?? []).filter(m => !state.query || U.title(m).toLowerCase().includes(state.query))
          content.replaceChildren(media.length ? C.grid(media) : P.emptyState(T('No results found.')))
        } catch (e) {
          content.replaceChildren(C.errorState(e, () => renderContent()))
        }
        return
      }

      const all = Object.values(Store.list()).filter(e => e.status === state.tab)
      const entries = sorted(all.filter(e => !state.query || U.title(e.media).toLowerCase().includes(state.query)))
      if (!all.length) {
        content.append(P.emptyState(T('Add titles from their page with the list button.'), {
          title: I18n.f(T('Nothing in “{status}” yet'), { status: label(state.tab) }),
          icon: BOOK,
          action: U.el('a', { class: 'btn btn-primary', href: '#/search', text: T('Browse the catalogue') })
        }))
        return
      }
      if (!entries.length) {
        content.append(P.emptyState(T('No results found.'), { icon: SEARCH }))
        return
      }

      const list = U.el('ol', { class: 'lib-rows' })
      /*
       * A FÓKUSZ NEM VÉSZ EL. A sor a változás után újrarajzolódik, és a
       * billentyűzetes néző „+1 rész" gombja ezzel eltűnt a keze alól. A
       * megnyomott vezérlő nevét megjegyezzük, és az új sorban ugyanott folytatjuk.
       */
      const onChange = () => {
        const active = document.activeElement
        const row = active?.closest?.('.lib-row')
        const again = row ? { id: row.dataset.id, ctl: active.dataset?.ctl } : null
        refreshTabs()
        renderContent().then(() => {
          if (!again?.ctl) return
          const target = content.querySelector(`.lib-row[data-id="${CSS.escape(again.id)}"] [data-ctl="${again.ctl}"]`)
          if (target && !target.disabled) target.focus()
          else content.querySelector('.lib-row .lib-title')?.focus()
        })
      }
      for (const entry of entries.slice(0, state.shown)) list.append(this.row(entry, { onChange }))
      content.append(list)

      const remaining = entries.length - Math.min(entries.length, state.shown)
      if (remaining > 0) {
        content.append(U.el('div', { class: 'load-more-wrap' }, [
          P.button(`${T('Show more')} (${I18n.number(remaining)})`, {
            variant: 'secondary',
            onclick: () => { state.shown += PAGE; renderContent() }
          })
        ]))
      }
    }

    renderContent()
  },

  /** Egy könyvtári sor: borító, cím, haladás, vezérlők. */
  row (entry, { onChange }) {
    const media = entry.media
    const href = `#/anime/${media.id}`
    const total = media.episodes ?? null
    const progress = entry.progress ?? 0
    const sub = [U.format(media), U.seasonYear(media), U.status(media)].filter(Boolean).join(' · ')

    const step = delta => {
      Store.setProgress(media, (Store.entry(media.id)?.progress ?? 0) + delta)
      onChange()
    }

    const status = P.select(Object.entries(U.listStatusMap).map(([value, name]) => [value, T(name)]), {
      value: entry.status,
      class: 'select lib-status',
      dataset: { ctl: 'status' },
      'aria-label': I18n.f(T('Status of {title}'), { title: U.title(media) }),
      onchange: () => {
        Store.saveEntry(media, { status: status.value })
        U.toast(I18n.f(T('Saved as: {status}'), { status: T(U.listStatusMap[status.value]) }), 'success')
        onChange()
      }
    })

    const remove = U.el('button', {
      class: 'icon-btn icon-btn-quiet',
      type: 'button',
      'aria-label': I18n.f(T('Remove {title} from the list'), { title: U.title(media) }),
      title: T('Remove from list'),
      onclick: () => {
        const snapshot = Store.entry(media.id)
        Store.removeEntry(media.id)
        onChange()
        U.toast(T('Removed from list'), '', {
          action: {
            label: T('Undo'),
            onClick: () => {
              Store.saveEntry(media, { status: snapshot.status, progress: snapshot.progress ?? 0, score: snapshot.score ?? 0 })
              onChange()
            }
          }
        })
      }
    }, [U.svg(C.TRASH, 16)])

    const counter = entry.status === 'PLANNING'
      ? null
      : U.el('div', { class: 'lib-counter', role: 'group', 'aria-label': T('Progress') }, [
        U.el('button', {
          class: 'icon-btn icon-btn-sm',
          type: 'button',
          disabled: progress <= 0,
          'aria-label': T('-1 episode'),
          dataset: { ctl: 'minus' },
          onclick: () => step(-1)
        }, [U.svg(C.MINUS, 14)]),
        U.el('span', { class: 'lib-count tabular', 'aria-live': 'polite', text: total ? `${progress} / ${total}` : String(progress) }),
        U.el('button', {
          class: 'icon-btn icon-btn-sm',
          type: 'button',
          disabled: !!total && progress >= total,
          'aria-label': T('+1 episode'),
          dataset: { ctl: 'plus' },
          onclick: () => step(1)
        }, [U.svg(C.PLUS, 14)])
      ])

    return U.el('li', { class: 'lib-row', dataset: { id: String(media.id) } }, [
      U.el('a', { class: 'lib-cover', href, tabindex: '-1', 'aria-hidden': 'true' }, [
        U.el('img', { src: media.coverImage?.large ?? '', alt: '', loading: 'lazy', decoding: 'async' })
      ]),
      U.el('div', { class: 'lib-main' }, [
        U.el('a', { class: 'lib-title', href, text: U.title(media) }),
        U.el('p', { class: 'lib-sub', text: sub }),
        total && entry.status !== 'PLANNING'
          ? U.el('div', { class: 'progress lib-progress', 'aria-hidden': 'true' }, [U.el('span', { style: `width:${Math.min(100, progress / total * 100)}%` })])
          : null
      ]),
      U.el('div', { class: 'lib-controls' }, [counter, status, remove])
    ])
  }
}
