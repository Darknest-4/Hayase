// The news modal: what the operator wants everybody to know, once.
//
// Shown after the router has drawn a page, not before it — a message about the
// site is never more urgent than the site itself, and a modal that beats the
// first paint makes the app feel like it is asking permission to start.
//
// Only one at a time, newest first. Two modals stacked is a bug wearing a
// feature's clothes, and somebody who has three messages waiting reads them
// one after another anyway.
//
// Dismissal is server-side per profile (so closing it on a phone closes it on
// a desktop), with a local record as well: the local one is what stops it
// reappearing between the click and the request landing.

import { P } from '../../shared/ui/primitives.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'

const SEEN_KEY = 'yume-announcement-seen'

/** Ids this browser has closed, whatever the server thinks. */
function seenLocally () {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch {
    // A browser with storage blocked still gets the news; it just gets it
    // again next time, which is better than not getting it at all.
    return new Set()
  }
}

function rememberLocally (id) {
  try {
    const seen = seenLocally()
    seen.add(id)
    // Bounded: this list only exists to bridge the gap before the server
    // answers, so it does not need to be a history.
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-50)))
  } catch { /* storage unavailable — see above */ }
}

export const Announcements = {
  _shown: false,

  /**
   * Look for something to show. Safe to call on every navigation: it answers
   * at most once per page load and never twice for the same message.
   */
  async check () {
    if (this._shown) return
    const all = await YumeAPI.announcements()
    if (!all?.length) return

    const local = seenLocally()
    const next = all.find(a => !a.dismissed && !local.has(a.id))
    if (!next) return

    this._shown = true
    this.open(next)
  },

  open (a) {
    const close = () => {
      rememberLocally(a.id)
      YumeAPI.dismissAnnouncement(a.id).catch(() => {})
      backdrop.remove()
      document.removeEventListener('keydown', onKey)
    }
    const onKey = e => { if (e.key === 'Escape') close() }

    const body = U.el('div', { class: 'ann-body' })
    // Paragraph per blank-line-separated block, as text. The operator writes
    // prose, not markup, and rendering it as HTML would make the announcement
    // field an injection point with an audience of everybody.
    for (const para of String(a.body).split(/\n{2,}/)) {
      if (para.trim()) body.append(U.el('p', { text: para.trim() }))
    }

    const actions = []
    if (a.link_url && a.link_label) {
      actions.push(U.el('a', {
        class: 'btn btn-primary',
        href: a.link_url,
        target: '_blank',
        rel: 'noopener noreferrer'
      }, [document.createTextNode(a.link_label)]))
    }
    actions.push(P.button(T('Rendben'), { variant: 'secondary', onclick: close }))

    const backdrop = P.dialog(a.title, [body], { actions, onClose: close })
    backdrop.classList.add('ann-modal')
    document.body.append(backdrop)
    document.addEventListener('keydown', onKey)

    // Focus the dismiss button so Escape is not the only way out for somebody
    // on a keyboard.
    backdrop.querySelector('.dialog-foot .btn:last-child')?.focus()
    return backdrop
  }
}
