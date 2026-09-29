/* global document */
// Admin — Hibák.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('errors')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { C } from '../../../shared/ui/components.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
  // ---- Errors: the triage loop ----
  //
  // The API for this existed and had no interface: errorGroups,
  // errorOccurrences and setErrorGroupStatus were all written and none had a
  // caller, so a 500 was only ever noticed because a user complained.

  ERR_STATUS: { open: ['Nyitott', 'vis-hidden'], resolved: ['Megoldva', 'vis-public'], ignored: ['Figyelmen kívül', 'vis-unlisted'] },

  async renderErrors (content) {
    const state = { status: 'open', open: null }
    const wrap = U.el('div', { class: 'err-layout' })
    const list = U.el('div', { class: 'err-list' })
    const detail = U.el('div', { class: 'err-detail' })

    /*
     * Look up the failure somebody is quoting.
     *
     * A 500 tells the caller "Request <id> failed — quote this id when
     * reporting it". This is where it gets quoted to. Before the id was
     * recorded on the occurrence, that sentence sent people to an operator
     * with no way to search for the number they were carrying.
     */
    const lookup = U.el('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Illessz be egy kérésazonosítót…',
      style: 'max-width:22rem;',
      'aria-label': 'Hiba keresése kérésazonosító alapján',
      onkeydown: async e => {
        if (e.key !== 'Enter') return
        const id = e.target.value.trim()
        if (!id) return
        detail.replaceChildren(P.spinner())
        try {
          const { occurrence, group } = await YumeAPI.admin.errorByRequest(id)
          if (group) { await showDetail(group) } else { detail.replaceChildren() }
          // The occurrence is what happened to that person at that moment; the
          // group above is whether it is happening to everybody.
          detail.prepend(U.el('div', { class: 'err-lookup-hit' }, [
            U.el('div', { class: 'err-lookup-line', text: `${occurrence.context?.code ?? 'no code'} · ${occurrence.context?.method ?? ''} ${occurrence.context?.route ?? ''}`.trim() }),
            U.el('time', { class: 'err-lookup-when', text: new Date(occurrence.created_at).toLocaleString() })
          ]))
        } catch (err) {
          detail.replaceChildren(C.errorState(err))
        }
      }
    })

    const bar = U.el('div', { class: 'admin-toolbar' }, [
      U.el('select', {
        class: 'select',
        onchange: e => { state.status = e.target.value; load() }
      }, [['open', 'Nyitott'], ['all', 'Mind'], ['resolved', 'Megoldva'], ['ignored', 'Figyelmen kívül']].map(([v, l]) =>
        U.el('option', { value: v, text: l, selected: v === state.status }))),
      lookup
    ])

    const showDetail = async group => {
      state.open = group.id
      detail.replaceChildren(P.spinner())
      try {
        const { group: g, occurrences } = await YumeAPI.admin.error(group.id)
        detail.replaceChildren()
        detail.append(U.el('div', { class: 'err-detail-head' }, [
          U.el('h3', { class: 'err-detail-title', text: g.title }),
          U.el('div', { class: 'err-detail-meta', text: `${g.event_count} events · first ${U.relTime(g.first_seen)} · last ${U.relTime(g.last_seen)}` }),
          U.el('div', { class: 'err-actions' }, ['resolved', 'ignored', 'open']
            .filter(v => v !== g.status)
            .map(v => U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: async () => {
                try { await YumeAPI.admin.setErrorStatus(g.id, v); U.toast(`Marked ${v}`); load() } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode(v === 'open' ? 'Reopen' : 'Mark ' + v)])))
        ]))
        if (!occurrences.length) {
          detail.append(P.emptyState('Nincs rögzített előfordulás.'))
          return
        }
        const occList = U.el('div', { class: 'err-occurrences' })
        detail.append(occList)
        for (const occ of occurrences) {
          occList.append(U.el('details', { class: 'err-occ' }, [
            U.el('summary', { text: `${U.relTime(occ.created_at)} · ${occ.context?.method ?? ''} ${occ.context?.route ?? occ.source}` }),
            U.el('pre', { class: 'err-stack', text: occ.stack || occ.message })
          ]))
        }
      } catch (e) { detail.replaceChildren(P.errorState(e.message)) }
    }

    const load = async () => {
      list.replaceChildren(P.spinner())
      try {
        const { data } = await YumeAPI.admin.errors(state.status)
        list.replaceChildren()
        if (!data.length) {
          list.append(P.emptyState(state.status === 'open' ? 'No open errors. ' : 'Nothing here.'))
          detail.replaceChildren(U.el('div', { class: 'cat-placeholder', text: 'Nincs mit megnézni.' }))
          return
        }
        for (const g of data) {
          const [label, cls] = this.ERR_STATUS[g.status] ?? this.ERR_STATUS.open
          list.append(U.el('button', {
            class: 'err-row' + (g.id === state.open ? ' active' : ''),
            onclick: () => { list.querySelectorAll('.err-row').forEach(r => r.classList.remove('active')); showDetail(g) }
          }, [
            U.el('div', { class: 'err-row-count', text: String(g.event_count) }),
            U.el('div', { class: 'err-row-main' }, [
              U.el('div', { class: 'err-row-title', text: g.title }),
              U.el('div', { class: 'err-row-sub', text: 'legutóbb ' + U.relTime(g.last_seen) })
            ]),
            U.el('span', { class: 'cat-badge ' + cls, text: label })
          ]))
        }
        if (!state.open) detail.replaceChildren(U.el('div', { class: 'cat-placeholder', text: 'Válassz egy hibát, és megjelenik a hívási lánc.' }))
      } catch (e) { list.replaceChildren(P.errorState(e.message)) }
    }

    content.replaceChildren(bar, wrap)
    wrap.append(list, detail)
    load()
  }
}
