// The development log: what shipped, what is being built, what is planned.
//
// Its own route rather than a community tab, because it is the project talking
// about itself rather than people talking to each other.
//
// Everything on it comes from the database — `releases` and `release_entries`
// — so a version can be added without a deployment, and the "planned" section
// is as real as the shipped one. A hand-written page would have drifted from
// the truth by the second release.

import { I18n, T } from '../shared/i18n/i18n.js'
import { C } from '../shared/ui/components.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'

/** Kind → the label and the class that colours its stripe. */
const KINDS = {
  added: ['Added', 'kind-added'],
  changed: ['Changed', 'kind-changed'],
  fixed: ['Fixed', 'kind-fixed'],
  removed: ['Removed', 'kind-removed'],
  security: ['Security', 'kind-security']
}

const STATUS = {
  released: ['Released', 'rel-released'],
  in_progress: ['In progress', 'rel-progress'],
  planned: ['Planned', 'rel-planned']
}

export const PageChangelog = {
  async render (root, params) {
    root.append(C.spotlight(T('Development log'), { subtitle: T('What shipped, what is being built, what is next') }))
    const pad = U.el('div', { class: 'page-pad', style: 'max-width:52rem;' })
    root.append(pad)

    const filter = params.get('status')
    const rail = U.el('div', { class: 'tabs' })
    for (const [key, label] of [[null, 'Everything'], ['planned', 'Planned'], ['in_progress', 'In progress'], ['released', 'Released']]) {
      rail.append(U.el('a', {
        class: 'tab' + ((filter ?? null) === key ? ' active' : ''),
        href: '#/changelog' + (key ? `?status=${key}` : '')
      }, [U.el('span', { text: T(label) })]))
    }
    pad.append(rail)

    const list = U.el('div', { class: 'changelog' }, [U.el('div', { class: 'spinner' })])
    pad.append(list)

    let data
    try { ({ data } = await YumeAPI.changelog.list(filter ?? undefined)) } catch (e) {
      list.replaceChildren(C.errorState(e, () => this.render(root, params)))
      return
    }

    list.replaceChildren()
    if (!data.length) {
      list.append(U.el('div', { class: 'empty-state', text: T('Nothing written here yet.') }))
      return
    }

    for (const release of data) list.append(this._release(release))
  },

  _release (release) {
    const [statusLabel, statusClass] = STATUS[release.status] ?? STATUS.planned
    const date = release.released_on
      ? new Date(release.released_on).toLocaleDateString(I18n.locale(), { year: 'numeric', month: 'long', day: 'numeric' })
      : null

    // Group the lines by kind so a release reads as "what was added / what was
    // fixed" rather than as one undifferentiated list.
    const byKind = new Map()
    for (const entry of release.entries ?? []) {
      if (!byKind.has(entry.kind)) byKind.set(entry.kind, [])
      byKind.get(entry.kind).push(entry)
    }

    const groups = U.el('div', { class: 'release-groups' })
    for (const kind of Object.keys(KINDS)) {
      const entries = byKind.get(kind)
      if (!entries?.length) continue
      const [label, kindClass] = KINDS[kind]
      groups.append(U.el('div', { class: 'release-group ' + kindClass }, [
        U.el('div', { class: 'release-kind', text: T(label) }),
        U.el('ul', { class: 'release-lines' }, entries.map(entry => U.el('li', { text: entry.body })))
      ]))
    }

    return U.el('article', { class: 'release ' + statusClass }, [
      U.el('header', { class: 'release-head' }, [
        U.el('div', { class: 'release-version', text: release.version }),
        U.el('div', { class: 'release-titles' }, [
          U.el('h2', { class: 'release-title', text: release.title }),
          release.summary ? U.el('p', { class: 'release-summary', text: release.summary }) : null
        ]),
        U.el('div', { class: 'release-meta' }, [
          U.el('span', { class: 'release-status', text: T(statusLabel) }),
          date ? U.el('time', { class: 'release-date', text: date }) : null
        ])
      ]),
      groups.children.length
        ? groups
        : U.el('p', { class: 'release-empty', text: T('Nothing listed under this version yet.') })
    ])
  }
}
