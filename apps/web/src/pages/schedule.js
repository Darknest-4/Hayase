// Menetrend — #/schedule?day=YYYY-MM-DD&mine=1
//
// 2026-09, újratervezve: kártyasorok helyett napokra bontott idővonal. Egy
// menetrendben az IDŐ a fő adat — melyik rész, mikor —, a borító csak
// segít felismerni a címet. A napok fülek (darabszámmal), a kiválasztott nap
// és a „csak a listámon" szűrő a címben él, így megosztható és a vissza gomb
// megtartja.

import { Catalogue } from '../entities/anime/catalogue.js'
import { C } from '../shared/ui/components.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { P } from '../shared/ui/primitives.js'
import { Store } from '../shared/state/store.js'
import { U } from '../shared/lib/dom.js'

const CAL = '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>'

const dayKey = date => {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const PageSchedule = {
  async render (root, params) {
    const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return '' } })()
    const pad = U.el('div', { class: 'page-pad sched-page' })
    root.append(pad)
    pad.append(U.el('header', { class: 'page-header' }, [
      U.el('div', { class: 'page-header-text' }, [
        U.el('h1', { class: 'page-title', text: T('schedule.title') }),
        U.el('p', { class: 'page-sub', text: zone ? I18n.f(T('The next seven days, in your time zone ({zone}).'), { zone }) : T('What drops this week, day by day') })
      ])
    ]))

    const container = U.el('div', { class: 'sched-body', 'aria-busy': 'true' }, [this.skeleton()])
    pad.append(container)

    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date(+start + 7 * 86400000)
    let schedules
    try {
      schedules = await Catalogue.scheduleOrAniList(start, end)
    } catch (e) {
      container.removeAttribute('aria-busy')
      container.replaceChildren(C.errorState(e, () => { root.replaceChildren(); this.render(root, params) }))
      return
    }
    container.removeAttribute('aria-busy')
    container.replaceChildren()
    if (!schedules?.length) {
      container.append(P.emptyState(T('schedule.empty'), { icon: CAL }))
      return
    }

    // Napokra bontva, időrendben.
    const byDay = new Map()
    for (let i = 0; i < 7; i++) byDay.set(dayKey(+start + i * 86400000), [])
    for (const item of schedules.slice().sort((a, b) => a.airingAt - b.airingAt)) {
      const key = dayKey(item.airingAt * 1000)
      if (byDay.has(key)) byDay.get(key).push(item)
    }

    const state = {
      day: byDay.has(params.get('day')) ? params.get('day') : dayKey(start),
      mine: params.get('mine') === '1'
    }
    const inLibrary = item => !!Store.entry(item.media?.id)
    const todayKey = dayKey(Date.now())
    const tomorrowKey = dayKey(Date.now() + 86400000)
    const labelFor = key => {
      if (key === todayKey) return T('schedule.today')
      if (key === tomorrowKey) return T('schedule.tomorrow')
      const [y, m, d] = key.split('-').map(Number)
      return new Date(y, m - 1, d).toLocaleDateString(I18n.locale(), { weekday: 'long' })
    }
    const dateFor = key => {
      const [y, m, d] = key.split('-').map(Number)
      return new Date(y, m - 1, d).toLocaleDateString(I18n.locale(), { month: 'short', day: 'numeric' })
    }

    const syncUrl = () => {
      const q = new URLSearchParams()
      if (state.day !== todayKey) q.set('day', state.day)
      if (state.mine) q.set('mine', '1')
      window.history.replaceState(window.history.state, '', '#/schedule' + (q.toString() ? '?' + q : ''))
    }

    const counts = () => Object.fromEntries([...byDay].map(([key, items]) => [key, (state.mine ? items.filter(inLibrary) : items).length]))
    const bar = P.tabs([...byDay.keys()].map(key => ({ id: key, label: `${labelFor(key)} · ${dateFor(key)}`, count: counts()[key] })), {
      selected: state.day,
      label: T('schedule.title'),
      onSelect: key => { state.day = key; syncUrl(); paint() }
    })
    const mineToggle = U.el('button', {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(state.mine),
      onclick: () => {
        state.mine = !state.mine
        mineToggle.setAttribute('aria-pressed', String(state.mine))
        const n = counts()
        for (const tab of bar.querySelectorAll('[role="tab"]')) {
          const count = tab.querySelector('.tab-count')
          if (count) count.textContent = String(n[tab.dataset.tab] ?? 0)
        }
        syncUrl()
        paint()
      }
    }, [document.createTextNode(T('Only titles in my library'))])

    container.append(bar, U.el('div', { class: 'sched-tools' }, [mineToggle]), bar.panel)

    const paint = () => {
      const items = (byDay.get(state.day) ?? []).filter(item => !state.mine || inLibrary(item))
      if (!items.length) {
        bar.panel.replaceChildren(P.emptyState(state.mine ? T('Nothing from your library airs on this day.') : T('Nothing airs on this day.'), { icon: CAL }))
        return
      }
      const now = Date.now()
      const list = U.el('ol', { class: 'sched-list' })
      let nextMarked = false
      for (const item of items) {
        const at = new Date(item.airingAt * 1000)
        const aired = at.getTime() <= now
        const isNext = !aired && !nextMarked
        if (isNext) nextMarked = true
        const media = item.media
        list.append(U.el('li', { class: 'sched-row' + (aired ? ' sched-aired' : '') + (isNext ? ' sched-next' : '') + (inLibrary(item) ? ' sched-mine' : '') }, [
          U.el('time', { class: 'sched-time tabular', datetime: at.toISOString(), text: I18n.time(at) }),
          U.el('a', { class: 'sched-cover', href: `#/anime/${media.id}`, tabindex: '-1', 'aria-hidden': 'true' }, [
            U.el('img', { src: U.cover(media), alt: '', loading: 'lazy', decoding: 'async' })
          ]),
          U.el('div', { class: 'sched-main' }, [
            U.el('a', { class: 'sched-title', href: `#/anime/${media.id}`, text: U.title(media) }),
            U.el('p', { class: 'sched-sub' }, [
              U.el('span', { class: 'sched-ep', text: I18n.f(T('Episode {n}'), { n: item.episode }) }),
              U.format(media) ? document.createTextNode(' · ' + U.format(media)) : null,
              inLibrary(item) ? U.el('span', { class: 'badge badge-accent sched-badge', text: T('On your list') }) : null
            ])
          ]),
          U.el('span', { class: 'sched-when', text: aired ? T('Aired') : U.relTime(at) })
        ]))
      }
      bar.panel.replaceChildren(list)
    }
    paint()
  },

  skeleton () {
    return U.el('div', { class: 'sched-list', 'aria-hidden': 'true' }, Array.from({ length: 6 }, () =>
      U.el('div', { class: 'sched-row' }, [
        U.el('div', { class: 'skeleton skel-text', style: 'width:3rem' }),
        U.el('div', { class: 'sched-cover skeleton' }),
        U.el('div', { class: 'sched-main' }, [
          U.el('div', { class: 'skeleton skel-text skel-line-mid' }),
          U.el('div', { class: 'skeleton skel-text skel-text-sm skel-line-short' })
        ])
      ])))
  }
}
