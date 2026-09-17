// A belépés és a regisztráció űrlapja — EGY példányban.
//
// Eddig három volt belőle: a landing felugró ablakában, a beállításokban és a
// közösségi lapon lévő kártyában, meg a hozzáférési kapuban. Három másolat
// ugyanabból a logikából, és a szokásos következménnyel: amikor az emberpróba
// bekerült, KETTŐBE nem került bele, vagyis onnan a regisztráció 403-mal
// hasalt volna el — némán, mert a kártya a hibát csak egy eltűnő toastban
// mutatta.
//
// Ez a modul az egy hely. Aki űrlapot akar, ezt kéri; aki csak beléptetni
// akar valakit, a `#/login` lapra küldi.
//
// VALÓDI `<form>`, nem egymás mellé rakott mezők. Ezen múlik, hogy:
//
//   * az Enter küldjön, minden mezőből, külön billentyűfigyelő nélkül;
//   * a jelszókezelők felismerjék, mit mentsenek és mit töltsenek ki
//     (ehhez kell a `name`, az `autocomplete` és az, hogy a felhasználónév
//     mező a jelszó ELŐTT álljon);
//   * a böngésző saját érvényesítése („töltsd ki ezt a mezőt") lefusson,
//     mielőtt bármit hálózatra küldenénk.

import { P } from '../../shared/ui/primitives.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'
import { createTurnstile, needed as turnstileNeeded } from '../../shared/lib/turnstile.js'

/**
 * @param {object} options
 * @param {'login'|'register'} [options.mode]      melyik füllel induljon
 * @param {Function} [options.onAuthed]            sikeres belépés után fut le
 * @param {Function} [options.onModeChange]        fülváltáskor — a cím átírásához
 * @param {boolean}  [options.tabs]                legyen-e fülsáv (a lapon igen)
 * @returns {{node: HTMLElement, focus: Function, destroy: Function, setMode: Function}}
 */
export function createAuthForm ({
  mode = 'login',
  onAuthed = () => {},
  onModeChange = () => {},
  tabs = true
} = {}) {
  /*
   * A HELYKITÖLTŐ NEM ISMÉTLI A CÍMKÉT.
   *
   * Minden mezőnek van látható címkéje. Egy „Felhasználónév" címke alatt egy
   * „Felhasználónév" helykitöltő nem mond semmit, viszont elfoglalja azt a
   * helyet, ahol egy PÉLDA állhatna — és pont a példa az, ami segít. Ahol
   * nincs értelmes példa, ott a mező üres marad.
   */
  const email = P.input({ type: 'email', name: 'email', placeholder: 'te@pelda.hu', autocomplete: 'email', required: true })
  const identifier = P.input({ type: 'text', name: 'identifier', autocomplete: 'username', required: true })
  const username = P.input({ type: 'text', name: 'username', autocomplete: 'username', required: true, minlength: 3, maxlength: 32 })
  const password = P.input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true, minlength: 8 })

  const fields = U.el('div', { class: 'auth-fields' })
  /*
   * `role="alert"`: a képernyőolvasó felolvassa, amint megjelenik. Egy
   * elrontott jelszó visszajelzése különben csak azoknak létezik, akik
   * látják.
   */
  const error = U.el('p', { class: 'field-error', role: 'alert', hidden: true })
  const submit = P.button('', { variant: 'primary', type: 'submit' })

  /*
   * AZ EMBERPRÓBA, ha ez a példány kér ilyet.
   *
   * EGY WIDGET, NEM KETTŐ. A Cloudflare a tokent a MŰVELETHEZ köti — a
   * kiszolgáló visszautasít egy belépésre szerzett tokent regisztrációnál —,
   * ezért fülváltáskor a widget újraépül a másik művelettel, nem pedig két
   * példány ül egymás mellett, amiből az egyik mindig rossz.
   *
   * `null`, ha a példány nem kér emberpróbát: ilyenkor az idegen eredetű
   * szkript be sem töltődik.
   */
  let turnstile = null

  const form = U.el('form', { class: 'auth-form', novalidate: false })

  const tabBar = tabs
    ? P.tabs(
      [{ id: 'login', label: T('Sign in') }, { id: 'register', label: T('Register') }],
      { selected: mode, onSelect: id => { setMode(id) } })
    : null

  function paint () {
    error.hidden = true

    if (turnstile) { turnstile.destroy(); turnstile = null }
    if (turnstileNeeded(mode)) turnstile = createTurnstile(mode)

    fields.replaceChildren(
      ...(mode === 'login'
        ? [P.field(T('Email or username'), identifier), P.field(T('Password'), password)]
        : [
            P.field(T('Email'), email),
            // A hossz EGYSZER szerepel. Helykitöltőben és súgóban is kiírva
            // ugyanaz a mondat állt kétszer egymás alatt.
            P.field(T('Username'), username, { hint: T('3–32 characters, letters and numbers.') }),
            P.field(T('Password'), password, { hint: T('At least 8 characters.') })
          ]),
      turnstile ? turnstile.node : null
    )

    submit.textContent = mode === 'login' ? T('Sign in') : T('Create account')
    // A jelszómező autocomplete-je a módtól függ: a böngésző különben új
    // jelszót ajánlana belépéskor, és a mentettet nem kínálná fel.
    password.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password')
    onModeChange(mode)
  }

  function setMode (next) {
    if (next === mode) return
    mode = next
    paint()
    ;(mode === 'login' ? identifier : email).focus()
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

      U.toast(T('Signed in as ') + YumeAPI.user().username)
      onAuthed()
    } catch (e) {
      // A hiba a mező alatt marad, nem toastban: egy eltűnő üzenet nem az,
      // amit valaki egy elrontott jelszó után keres.
      error.textContent = e.message
      error.hidden = false
      /*
       * A TOKEN EGYSZER HASZNÁLATOS. Akármi miatt bukott el a küldés — rossz
       * jelszó is —, a token elhasználódott, és a következő próbálkozás
       * ugyanazzal biztosan elbukna. Ezért MINDEN hiba után újrarajzolunk.
       */
      turnstile?.reset()
    } finally {
      submit.disabled = false
      delete submit.dataset.loading
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    send().catch(() => {})
  })

  paint()
  form.append(...[tabBar, fields, error, U.el('div', { class: 'auth-actions' }, [submit])].filter(Boolean))

  return {
    node: form,
    get mode () { return mode },
    setMode,
    focus () { (mode === 'login' ? identifier : email).focus() },
    /** A widget iframe-et és időzítőt hagyna maga után. */
    destroy () {
      turnstile?.destroy()
      turnstile = null
    }
  }
}
