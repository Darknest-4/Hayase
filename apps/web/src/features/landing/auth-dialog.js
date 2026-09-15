/* global document */
// Belépés és regisztráció egy felugró ablakban.
//
// A landingen a bejelentkezés nem szekció a lap alján, hanem egy profil-ikon a
// fejlécben: aki olvasni jött, azt ne állítsa meg egy űrlap, aki pedig belépni
// jött, annak ne kelljen a lap aljára görögnie.
//
// Két fül, nem egy szövegre kattintás. A „Nincs még fiókod? Regisztrálj"
// link a régi kártyán elrejtette, hogy egyáltalán van választás — a
// szegmentált kapcsoló mindkét lehetőséget kiteszi, és megmutatja, melyikben
// vagy.

import { P } from '../../shared/ui/primitives.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'

/**
 * @param {Function} onAuthed  sikeres belépés vagy regisztráció után fut le
 * @returns {HTMLElement} a háttér, már a dokumentumhoz fűzve
 */
export function openAuthDialog (onAuthed = () => {}) {
  let mode = 'login'

  const email = P.input({ type: 'email', placeholder: 'te@pelda.hu', autocomplete: 'email' })
  const identifier = P.input({ type: 'text', placeholder: T('E-mail vagy felhasználónév'), autocomplete: 'username' })
  const username = P.input({ type: 'text', placeholder: T('Felhasználónév'), autocomplete: 'username' })
  const password = P.input({ type: 'password', placeholder: T('Legalább 8 karakter'), autocomplete: 'current-password' })

  const fields = U.el('div', { class: 'auth-fields' })
  const error = U.el('p', { class: 'field-error', hidden: true })

  const submit = P.button('', { variant: 'primary', onclick: () => { send().catch(() => {}) } })

  const tabs = P.tabs(
    [{ id: 'login', label: T('Belépés') }, { id: 'register', label: T('Regisztráció') }],
    { selected: 'login', onSelect: id => { mode = id; paint() } }
  )

  function paint () {
    error.hidden = true
    fields.replaceChildren(
      ...(mode === 'login'
        ? [P.field(T('E-mail vagy felhasználónév'), identifier), P.field(T('Jelszó'), password)]
        : [P.field(T('E-mail cím'), email), P.field(T('Felhasználónév'), username), P.field(T('Jelszó'), password, { hint: T('Legalább 8 karakter.') })])
    )
    submit.textContent = mode === 'login' ? T('Belépés') : T('Fiók létrehozása')
    // A jelszómező autocomplete-je attól függ, melyik módban vagyunk: a
    // böngésző különben új jelszót ajánlana belépéskor.
    password.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password')
  }

  async function send () {
    error.hidden = true
    submit.disabled = true
    submit.dataset.loading = '1'
    try {
      if (mode === 'login') await YumeAPI.login(identifier.value.trim(), password.value)
      else await YumeAPI.register(email.value.trim(), username.value.trim(), password.value)
      U.toast(T('Szia, ') + YumeAPI.user().username)
      backdrop.remove()
      onAuthed()
    } catch (e) {
      // A hiba a mező alatt marad, nem toastban: egy eltűnő üzenet nem az,
      // amit valaki egy elrontott jelszó után keres.
      error.textContent = e.message
      error.hidden = false
    } finally {
      submit.disabled = false
      delete submit.dataset.loading
    }
  }

  for (const field of [identifier, password, email, username]) {
    field.addEventListener('keydown', e => { if (e.key === 'Enter') send().catch(() => {}) })
  }

  paint()

  const backdrop = P.dialog(T('Yume-fiók'), [
    U.el('div', { class: 'auth-body' }, [tabs, fields, error])
  ], {
    actions: [P.button(T('Mégse'), { variant: 'ghost', onclick: () => backdrop.remove() }), submit],
    onClose: () => backdrop.remove()
  })
  backdrop.classList.add('auth-modal')
  document.body.append(backdrop)
  ;(mode === 'login' ? identifier : email).focus()
  return backdrop
}
