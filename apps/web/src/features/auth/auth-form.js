// A belépés, a regisztráció és az elfelejtett jelszó űrlapja — egy helyen.
//
// Egy példányban él, mert a másolatai szétfutottak: amikor az emberpróba
// bekerült, a fiókkártya saját űrlapjába nem került bele, és a regisztráció
// onnan némán 403-mal hasalt el. A belépőlap (pages/login.js) ezt rajzolja.
//
// 2026-09, újratervezve:
//
//   * A HIBA A NÉZŐ NYELVÉN. A kiszolgáló angolul felel („Invalid
//     credentials", „Email or username already in use", „Rate limit exceeded
//     — retry in 5 minutes"), és ez a szöveg eddig változatlanul került egy
//     magyar oldal űrlapja alá. A státuszkódból és a válaszból most érthető
//     mondat lesz; amit nem ismerünk fel, az marad, ami volt.
//
//   * ZÁRT REGISZTRÁCIÓNÁL NINCS REGISZTRÁCIÓS FÜL. A példány kiírja
//     (`site.registrationOpen`), a kiszolgáló be is tartja — az űrlap viszont
//     eddig felkínálta, és csak a beküldés után derült ki, hogy hiába.
//
//   * ELFELEJTETT JELSZÓ: csak ott van űrlap, ahol van kézbesítés
//     (`site.recoveryAvailable`). Ahol nincs, a lap megmondja, kihez lehet
//     fordulni, és nem kínál egy kérést, ami semmit nem küldene ki.
//
//   * A JELSZÓ MEGMUTATHATÓ. Telefonon egy elgépelt jelszó a leggyakoribb
//     sikertelen belépés, és a mező eddig nem engedte ellenőrizni.

import { P } from '../../shared/ui/primitives.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'
import { createTurnstile, needed as turnstileNeeded } from '../../shared/lib/turnstile.js'
import { site } from '../../shared/lib/site-config.js'
import { authErrorMessage, passwordField } from './password-field.js'

// A két segéd a `password-field.js`-ben él: a beállítások oldal is használja
// őket (jelszócsere, fióktörlés), és nem kell neki az egész űrlap az
// emberpróbával együtt. Innen tovább is adjuk, hogy a belépőlapok egy helyről
// importálhassanak.
export { authErrorMessage, passwordField }

const INFO = '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'

export function createAuthForm ({
  mode = 'login',
  onAuthed = () => {},
  onModeChange = () => {},
  tabs = true
} = {}) {
  const registrationOpen = site()?.registrationOpen !== false

  const email = P.input({ type: 'email', name: 'email', placeholder: 'te@pelda.hu', autocomplete: 'email', required: true, maxlength: 254 })
  const identifier = P.input({ type: 'text', name: 'identifier', autocomplete: 'username', required: true, minlength: 3, maxlength: 254, autocapitalize: 'none', spellcheck: 'false' })
  const username = P.input({
    type: 'text',
    name: 'username',
    autocomplete: 'username',
    required: true,
    minlength: 3,
    maxlength: 32,
    pattern: '[A-Za-z0-9_]+',
    autocapitalize: 'none',
    spellcheck: 'false'
  })
  const password = P.input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true, minlength: 8, maxlength: 128 })
  const passwordWrap = passwordField(password)

  const fields = U.el('div', { class: 'auth-fields', id: 'auth-fields-' + Math.random().toString(36).slice(2, 9) })
  const errorId = 'auth-error-' + Math.random().toString(36).slice(2, 9)
  const error = U.el('p', { class: 'field-error auth-error', role: 'alert', hidden: true, id: errorId })
  const notice = U.el('p', { class: 'callout callout-ok auth-notice', role: 'status', hidden: true })

  const forgotLink = U.el('button', {
    type: 'button', class: 'link auth-link', text: T('Elfelejtetted a jelszavad?'), onclick: () => setMode('forgot')
  })
  const backLink = U.el('button', {
    type: 'button', class: 'link auth-link', text: T('Vissza a belépéshez'), onclick: () => setMode('login')
  })
  const submit = P.button('', { variant: 'primary', type: 'submit', class: 'btn btn-primary btn-lg btn-block' })

  /**
   * Az emberpróba, ha a példány kéri az adott művelethez.
   *
   * `null`, ha a példány nem kér emberpróbát: ilyenkor az idegen eredetű
   * szkript be sem töltődik.
   */
  let turnstile = null

  const form = U.el('form', { class: 'auth-form', novalidate: false })

  // Zárt regisztrációnál a regisztrációs fül nem jelenik meg: olyan
  // lehetőséget kínálna, amit a kiszolgáló úgyis elutasít.
  const tabBar = tabs && registrationOpen
    ? P.tabs(
      [{ id: 'login', label: T('Sign in') }, { id: 'register', label: T('Register') }],
      { selected: mode === 'register' ? 'register' : 'login', onSelect: id => { setMode(id) }, label: T('Account'), controls: fields.id })
    : null

  function paint () {
    error.hidden = true
    notice.hidden = true
    submit.hidden = false
    submit.disabled = false
    jelol(false)
    tabBar?.select?.(mode === 'register' ? 'register' : 'login', { silent: true })
    if (tabBar) tabBar.hidden = mode === 'forgot'

    if (turnstile) { turnstile.destroy(); turnstile = null }
    if (turnstileNeeded(mode)) turnstile = createTurnstile(mode)

    const recovery = site()?.recoveryAvailable !== false
    const closed = mode === 'register' && !registrationOpen

    fields.replaceChildren(
      ...(mode === 'forgot'
        ? [
            recovery
              ? U.el('p', { class: 'auth-sub', text: T('Add meg a fiókod e-mail-címét vagy felhasználónevét, és küldünk egy linket az új jelszóhoz.') })
              : U.el('div', { class: 'callout callout-info' }, [
                U.svg(INFO, 18),
                U.el('p', { text: T('Ezen a példányon nincs automatikus jelszó-visszaállítás. Írj az oldal üzemeltetőjének.') })
              ]),
            ...(recovery ? [P.field(T('Email or username'), identifier)] : []),
            backLink
          ]
        : closed
          ? [U.el('div', { class: 'callout callout-info' }, [
              U.svg(INFO, 18),
              U.el('p', { text: T('Registration is closed on this site.') })
            ])]
          : mode === 'login'
            ? [
                P.field(T('Email or username'), identifier),
                P.field(T('Password'), passwordWrap),
                forgotLink
              ]
            : [
                P.field(T('Email'), email),
                P.field(T('Username'), username, { hint: T('3–32 characters, letters and numbers.') }),
                P.field(T('Password'), passwordWrap, { hint: T('At least 8 characters.') })
              ]),
      ...[turnstile ? turnstile.node : null].filter(Boolean)
    )

    submit.textContent = mode === 'login' ? T('Sign in') : mode === 'forgot' ? T('Link küldése') : T('Create account')
    if ((mode === 'forgot' && !recovery) || closed) submit.hidden = true
    password.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password')
    // Módváltáskor a jelszó újra rejtett — egy megmutatott jelszó ne maradjon
    // látva egy másik űrlapon.
    password.setAttribute('type', 'password')
    onModeChange(mode)
  }

  function setMode (next) {
    if (next === mode) return
    mode = next
    paint()
    const first = mode === 'register' ? email : identifier
    if (first.isConnected) first.focus()
  }

  function aktivMezok () {
    if (mode === 'forgot') return [identifier]
    return mode === 'login' ? [identifier, password] : [email, username, password]
  }

  /**
   * A HIBA A MEZŐN IS LÁTSZIK, nem csak alatta: `aria-invalid` és egy
   * `aria-describedby` a hibaüzenetre, hogy a képernyőolvasó a mezőben
   * állva is meghallja, mi volt a baj.
   */
  function jelol (hibas) {
    for (const mezo of [identifier, password, email, username]) {
      if (hibas && aktivMezok().includes(mezo)) {
        mezo.setAttribute('aria-invalid', 'true')
        mezo.setAttribute('aria-describedby', errorId)
      } else {
        mezo.removeAttribute('aria-invalid')
        // A mező saját súgója (pl. „legalább 8 karakter") visszakapja a helyét.
        const hint = mezo.dataset?.hintId
        if (hint) mezo.setAttribute('aria-describedby', hint)
        else mezo.removeAttribute('aria-describedby')
      }
    }
  }

  async function send () {
    error.hidden = true
    jelol(false)
    submit.disabled = true
    submit.dataset.loading = '1'
    try {
      const token = turnstile ? await turnstile.token() : undefined
      if (mode === 'forgot') {
        await YumeAPI.forgotPassword(identifier.value.trim(), token)
        notice.textContent = T('Ha van ilyen fiók, elküldtük a linket. Nézd meg a leveleidet — a link egy óráig érvényes.')
        notice.hidden = false
        turnstile?.reset()
        return
      }
      if (mode === 'login') await YumeAPI.login(identifier.value.trim(), password.value, token)
      else await YumeAPI.register(email.value.trim(), username.value.trim(), password.value, token)
      U.toast(T('Signed in as ') + YumeAPI.user().username, 'success')
      onAuthed()
    } catch (e) {
      error.textContent = authErrorMessage(e, mode)
      error.hidden = false
      jelol(true)
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
  form.append(...[tabBar, fields, error, notice, U.el('div', { class: 'auth-actions' }, [submit])].filter(Boolean))

  return {
    node: form,
    get mode () { return mode },
    setMode,
    focus () { (mode === 'register' ? email : identifier).focus() },
    destroy () {
      turnstile?.destroy()
      turnstile = null
    }
  }
}
