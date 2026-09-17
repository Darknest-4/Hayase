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
import { createTurnstile, needed as turnstileNeeded } from '../../shared/lib/turnstile.js'

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

  /*
   * AZ EMBERPRÓBA, ha ez a példány kér ilyet.
   *
   * EGY WIDGET, NEM KETTŐ. A két fül ugyanazt az ablakot használja, és a
   * Cloudflare a tokent a MŰVELETHEZ köti — a kiszolgáló visszautasít egy
   * belépésre szerzett tokent regisztrációnál. Ezért fülváltáskor a widget
   * újraépül a másik művelettel, nem pedig két példány ül egymás mellett,
   * amiből az egyik mindig rossz.
   *
   * `null`, ha a példány nem kér emberpróbát — ilyenkor az idegen eredetű
   * szkript be sem töltődik.
   */
  let turnstile = null

  function syncTurnstile () {
    if (turnstile) { turnstile.destroy(); turnstile = null }
    if (turnstileNeeded(mode)) turnstile = createTurnstile(mode)
  }

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

    syncTurnstile()
    if (turnstile) fields.append(turnstile.node)
  }

  async function send () {
    error.hidden = true
    submit.disabled = true
    submit.dataset.loading = '1'
    try {
      // A tokent MÉG A KÜLDÉS ELŐTT kérjük el. A widget általában azonnal ad
      // egyet, de nem mindig — és ha nem tud, jobb itt megállni egy érthető
      // üzenettel, mint a kiszolgálótól visszakapni egy 403-at.
      const token = turnstile ? await turnstile.token() : undefined

      if (mode === 'login') await YumeAPI.login(identifier.value.trim(), password.value, token)
      else await YumeAPI.register(email.value.trim(), username.value.trim(), password.value, token)
      U.toast(T('Szia, ') + YumeAPI.user().username)
      close()
      onAuthed()
    } catch (e) {
      // A hiba a mező alatt marad, nem toastban: egy eltűnő üzenet nem az,
      // amit valaki egy elrontott jelszó után keres.
      error.textContent = e.message
      error.hidden = false
      /*
       * A TOKEN EGYSZER HASZNÁLATOS. Akármi miatt bukott el a küldés — rossz
       * jelszó is —, a token elhasználódott, és a következő próbálkozás
       * ugyanazzal biztosan elbukna. Ezért MINDEN hiba után újrarajzolunk,
       * nem csak a `turnstile_failed` kódnál.
       */
      turnstile?.reset()
    } finally {
      submit.disabled = false
      delete submit.dataset.loading
    }
  }

  for (const field of [identifier, password, email, username]) {
    field.addEventListener('keydown', e => { if (e.key === 'Enter') send().catch(() => {}) })
  }

  // A widget iframe-et és időzítőt hagyna maga után, ha csak a háttér tűnne el.
  function close () {
    turnstile?.destroy()
    turnstile = null
    backdrop.remove()
  }

  paint()

  const backdrop = P.dialog(T('Yume-fiók'), [
    U.el('div', { class: 'auth-body' }, [tabs, fields, error])
  ], {
    actions: [P.button(T('Mégse'), { variant: 'ghost', onclick: () => close() }), submit],
    onClose: () => close()
  })
  backdrop.classList.add('auth-modal')
  document.body.append(backdrop)
  ;(mode === 'login' ? identifier : email).focus()
  return backdrop
}
