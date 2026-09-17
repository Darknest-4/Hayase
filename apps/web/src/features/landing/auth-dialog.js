/* global document */
// Belépés és regisztráció egy felugró ablakban.
//
// A landingen a bejelentkezés nem szekció a lap alján, hanem egy profil-ikon a
// fejlécben: aki olvasni jött, azt ne állítsa meg egy űrlap, aki pedig belépni
// jött, annak ne kelljen a lap aljára görögnie.
//
// AZ ABLAK MEGMARADT, A LAP MELLETT. A `#/login` az, amire hivatkozni lehet —
// a hozzáférési kapuból, egy levélből —, ez pedig az, ami nem visz el onnan,
// ahol a látogató épp olvas. A KETTŐ UGYANAZT AZ ŰRLAPOT használja
// (`features/auth/auth-form.js`): ez a fájl innentől csak keret.
//
// Két fül, nem egy szövegre kattintás. A „Nincs még fiókod? Regisztrálj"
// link a régi kártyán elrejtette, hogy egyáltalán van választás — a
// szegmentált kapcsoló mindkét lehetőséget kiteszi, és megmutatja, melyikben
// vagy. A fülsávot maga az űrlap hozza.

import { P } from '../../shared/ui/primitives.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { createAuthForm } from '../auth/auth-form.js'

/**
 * @param {Function} onAuthed  sikeres belépés vagy regisztráció után fut le
 * @returns {HTMLElement} a háttér, már a dokumentumhoz fűzve
 */
export function openAuthDialog (onAuthed = () => {}) {
  const form = createAuthForm({
    onAuthed: () => { close(); onAuthed() }
  })

  // A widget iframe-et és időzítőt hagyna maga után, ha csak a háttér tűnne el.
  function close () {
    form.destroy()
    backdrop.remove()
  }

  const backdrop = P.dialog(T('Yume account'), [
    U.el('div', { class: 'auth-body' }, [form.node])
  ], {
    // Nincs külön „Belépés" gomb a lábon: az űrlapé küld, és így az Enter is
    // működik minden mezőből, külön billentyűfigyelő nélkül.
    actions: [P.button(T('Cancel'), { variant: 'ghost', onclick: () => close() })],
    onClose: () => close()
  })
  backdrop.classList.add('auth-modal')
  document.body.append(backdrop)
  form.focus()
  return backdrop
}
