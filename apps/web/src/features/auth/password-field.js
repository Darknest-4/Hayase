// A jelszómező (megmutató gombbal) és a kiszolgáló hibáinak magyar mondatai.
//
// Külön modulban, mert a beállítások oldal is ezekkel dolgozik (jelszócsere,
// kijelentkezés mindenhol, fióktörlés), a belépőűrlap többi része — a fülek, az
// emberpróba (`turnstile.js`) — viszont neki nem kell. Az `auth-form.js`
// innen importálja és adja tovább őket.

import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'

const EYE = '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'
const EYE_OFF = '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>'

/**
 * A kiszolgáló válaszából egy mondat, amit a néző ért.
 *
 * Csak azt fordítjuk, amit biztosan felismerünk. Egy ismeretlen hiba a saját
 * szövegével marad — egy rossz „fordítás" rosszabb, mint az eredeti.
 *
 * @param {Error & { status?: number }} error
 * @param {'login'|'register'|'forgot'|'reset'} mode
 */
export function authErrorMessage (error, mode) {
  const status = error?.status
  const detail = String(error?.message ?? '')
  if (!status) {
    // A fetch maga hasalt el: nincs hálózat, vagy a kiszolgáló nem felel.
    if (error?.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(detail)) {
      return T('We cannot reach the server. Check your connection and try again.')
    }
    return detail || T('Something went wrong. Please try again.')
  }
  if (status === 429) return T('Too many attempts. Wait a few minutes and try again.')
  if (status >= 500) return T('The server ran into a problem. Please try again in a moment.')
  if (mode === 'login' && status === 401) return T('Wrong email, username or password.')
  if (mode === 'login' && status === 403 && /^Account /.test(detail)) return T('This account is suspended.')
  if (mode === 'register' && status === 409) return T('That email address or username is already taken.')
  if (mode === 'register' && status === 403 && /closed/i.test(detail)) return T('Registration is closed on this site.')
  if (mode === 'reset' && status === 400) return T('This reset link is invalid, already used or expired. Request a new one.')
  if (status === 400 && /body\//.test(detail)) return T('Check the details you entered.')
  return detail
}

/**
 * Egy jelszómező a megmutató gombbal együtt.
 *
 * @param {HTMLInputElement} input
 */
export function passwordField (input) {
  const toggle = U.el('button', {
    class: 'icon-btn icon-btn-sm icon-btn-quiet input-trail',
    type: 'button',
    'aria-label': T('Show password'),
    'aria-pressed': 'false',
    onclick: () => {
      const show = input.getAttribute('type') === 'password'
      input.setAttribute('type', show ? 'text' : 'password')
      toggle.setAttribute('aria-pressed', String(show))
      toggle.setAttribute('aria-label', show ? T('Hide password') : T('Show password'))
      toggle.replaceChildren(U.svg(show ? EYE_OFF : EYE, 18))
      input.focus()
    }
  }, [U.svg(EYE, 18)])
  return U.el('div', { class: 'input-wrap input-wrap-trail' }, [input, toggle])
}
