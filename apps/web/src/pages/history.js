// Előzmények — a profil „Előzmények" füle (#/profile?tab=history).
//
// Az előzményeket a BÖNGÉSZŐ vezeti (Store.history: profilonként, legfeljebb
// 200 tétel), nem a kiszolgáló — nincs olyan végpont, ami a néző saját nézési
// naplóját visszaadná. Ezért a lap ki is mondja, hogy „ezen az eszközön": egy
// másik gépen megnézett rész itt nem jelenik meg, és nem is szabad úgy tenni,
// mintha megjelenne.
//
// 2026-09, újratervezve: a törlés megerősítése a saját párbeszédablakunk (a
// böngésző angol `confirm()`-ja helyett), a „Ma" / „Tegnap" fordítva, a sorok
// a könyvtár sorformáját kapják (borító, cím → adatlap, külön lejátszógomb).
// A különálló `render()` törölve: a `#/history` cím a profil fülére irányít
// (router `REDIRECTS`), a függvényt semmi nem hívta.

/* global document */
import { navigate } from '../shared/lib/shell.js'
import { C } from '../shared/ui/components.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { Store } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'

const CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'

/** `ÉÉÉÉ-HH-NN` a helyi naptár szerint — a `<time datetime>` értéke. */
const localDate = d => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, '0')).join('-')

export const PageHistory = {
  /** A profil fülének tartalma. */
  body (pad) {
    const history = Store.history()

    pad.append(U.el('div', { class: 'history-head' }, [
      U.el('p', { class: 'history-note', text: T('Your watch history is kept on this device only.') }),
      history.length
        ? U.el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => this._clear() }, [
          document.createTextNode(T('Clear history'))
        ])
        : null
    ]))

    if (!history.length) {
      pad.append(P.emptyState(T('Nothing watched on this device yet. Play an episode and it shows up here.'), {
        icon: CLOCK,
        action: U.el('a', { class: 'btn btn-primary', href: '#/search', text: T('Browse the catalogue') })
      }))
      return
    }

    // Napokra bontva, a helyi naptár szerint.
    const groups = new Map()
    for (const item of history) {
      const key = new Date(item.at).toDateString()
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }

    const now = new Date()
    const today = now.toDateString()
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString()

    for (const [key, items] of groups) {
      const day = new Date(items[0].at)
      const label = key === today
        ? T('Today')
        : key === yesterday
          ? T('Yesterday')
          : day.toLocaleDateString(I18n.locale(), { weekday: 'long', month: 'long', day: 'numeric' })
      pad.append(U.el('section', { class: 'section history-day' }, [
        U.el('h2', { class: 'section-title' }, [U.el('time', { datetime: localDate(day), text: label })]),
        U.el('ol', { class: 'lib-rows' }, items.map(item => this._row(item)))
      ]))
    }
  },

  _row (item) {
    const media = item.media ?? { id: item.id }
    const id = media.id ?? item.id
    const title = U.title(media)
    const at = new Date(item.at)
    const cover = media.coverImage?.large ?? ''
    const episode = I18n.f(T('Episode {n}'), { n: item.episode })
    return U.el('li', { class: 'lib-row history-row' }, [
      // A borító ugyanoda visz, mint a cím: egérrel kényelmes célpont, a
      // billentyűzetnek és a felolvasónak viszont elég egyszer (a cím).
      U.el('a', { class: 'lib-cover', href: `#/anime/${id}`, tabindex: '-1', 'aria-hidden': 'true' }, [
        cover ? U.el('img', { src: cover, alt: '', loading: 'lazy', decoding: 'async' }) : null
      ]),
      U.el('div', { class: 'lib-main' }, [
        U.el('a', { class: 'lib-title', href: `#/anime/${id}`, text: title }),
        U.el('p', { class: 'lib-sub' }, [
          document.createTextNode(episode + ' · '),
          U.el('time', {
            datetime: at.toISOString(),
            text: at.toLocaleTimeString(I18n.locale(), { hour: '2-digit', minute: '2-digit' })
          })
        ])
      ]),
      U.el('div', { class: 'lib-controls' }, [
        U.el('a', {
          class: 'btn btn-secondary btn-sm',
          href: `#/watch/${id}:${item.episode}`,
          'aria-label': `${T('Play')}: ${title} — ${episode}`
        }, [U.svg(C.PLAY, 14), document.createTextNode(T('Play'))])
      ])
    ])
  },

  async _clear () {
    const ok = await C.confirm({
      title: T('Clear history'),
      message: T('This clears the list on this device only. Your library and progress stay as they are.'),
      confirmLabel: T('Clear history'),
      danger: true
    })
    if (!ok) return
    Store.clearHistory()
    U.toast(T('History cleared'))
    navigate()
  }
}
