/* global window */
// Új jelszó a visszaállító levél linkjéből: #/reset?token=…
//
// A kiszolgáló oldala régóta kész volt (POST /v1/auth/forgot és /reset), a
// kliensben viszont sem a kérés, sem a beváltás nem létezett — a levélben
// kapott tokennel nem volt hová menni. Ez a lap a beváltás; a kérés a
// belépőűrlap „Elfelejtetted a jelszavad?" módja.
//
// A token a CÍMSORBÓL jön. Nem ellenőrizzük itt: a kiszolgáló dönt, és egy
// lejárt vagy már felhasznált tokenre érthető hibát ad vissza.

import { P } from '../shared/ui/primitives.js'
import { T } from '../shared/i18n/i18n.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'
import { setTitle } from '../shared/lib/shell.js'
import { authErrorMessage, passwordField } from '../features/auth/auth-form.js'

export const PageReset = {
  /**
   * @param {HTMLElement} root
   * @param {URLSearchParams} params
   */
  render (root, params) {
    const token = params.get('token') ?? ''
    setTitle(T('Új jelszó'))

    const wrap = U.el('div', { class: 'auth-page' })
    const main = U.el('div', { class: 'auth-main' })
    wrap.append(main)
    root.append(wrap)

    const card = U.el('div', { class: 'auth-card' })
    main.append(card)
    card.append(U.el('h1', { class: 'auth-title', text: T('Új jelszó') }))

    if (!token) {
      card.append(
        U.el('p', { class: 'auth-sub', text: T('Ebből a linkből hiányzik a visszaállító kód. Nyisd meg újra a levélben kapott linket, vagy kérj újat.') }),
        U.el('div', { class: 'auth-actions' }, [
          P.button(T('Új link kérése'), { variant: 'primary', onclick: () => { window.location.hash = '#/login?forgot=1' } })
        ])
      )
      return
    }

    card.append(U.el('p', { class: 'auth-sub', text: T('Adj meg egy új jelszót. Utána minden eszközön újra be kell lépned.') }))

    const errorId = 'reset-error-' + Math.random().toString(36).slice(2, 9)
    const password = P.input({ type: 'password', name: 'new-password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128 })
    const again = P.input({ type: 'password', name: 'confirm-password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128 })
    const error = U.el('p', { class: 'field-error', role: 'alert', hidden: true, id: errorId })
    const submit = P.button(T('Jelszó mentése'), { variant: 'primary', type: 'submit', class: 'btn btn-primary btn-lg btn-block' })

    const form = U.el('form', { class: 'auth-form' }, [
      U.el('div', { class: 'auth-fields' }, [
        P.field(T('Új jelszó'), passwordField(password), { hint: T('At least 8 characters.') }),
        P.field(T('Még egyszer'), passwordField(again))
      ]),
      error,
      U.el('div', { class: 'auth-actions' }, [submit])
    ])
    card.append(form)

    const fail = message => {
      error.textContent = message
      error.hidden = false
      password.setAttribute('aria-invalid', 'true')
      password.setAttribute('aria-describedby', errorId)
    }

    form.addEventListener('submit', async event => {
      event.preventDefault()
      error.hidden = true
      password.removeAttribute('aria-invalid')
      if (password.value !== again.value) {
        fail(T('A két jelszó nem egyezik.'))
        return
      }
      submit.disabled = true
      submit.dataset.loading = '1'
      try {
        await YumeAPI.resetPassword(token, password.value)
        card.replaceChildren(
          U.el('h1', { class: 'auth-title', text: T('Kész') }),
          U.el('p', { class: 'auth-sub', text: T('Az új jelszavad él. Lépj be vele.') }),
          U.el('div', { class: 'auth-actions' }, [
            P.button(T('Sign in'), { variant: 'primary', onclick: () => { window.location.hash = '#/login' } })
          ])
        )
      } catch (e) {
        fail(authErrorMessage(e, 'reset') || T('A jelszót nem sikerült menteni.'))
        // Egy lejárt vagy már felhasznált link után az út egy új link felé visz.
        if (e?.status === 400 && !card.querySelector('.reset-again')) {
          form.append(U.el('p', { class: 'reset-again' }, [
            U.el('a', { class: 'link', href: '#/login?forgot=1', text: T('Új link kérése') })
          ]))
        }
      } finally {
        submit.disabled = false
        delete submit.dataset.loading
      }
    })

    main.append(U.el('a', { class: 'auth-back', href: '#/login', text: T('Vissza a belépéshez') }))
    password.focus()
  }
}
