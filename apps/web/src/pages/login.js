/* global document, window, MutationObserver */
// A belépés saját lapja.
//
// MIÉRT LAP, ÉS NEM CSAK FELUGRÓ ABLAK. A felugró ablak megmarad ott, ahol jó
// — a kezdőképernyőn, ahol a látogató épp olvas, és nem akarjuk elvinni. De
// egy ablaknak nincs CÍME, és emiatt négy dolog hiányzott:
//
//   * nem lehet rá HIVATKOZNI. „Lépj be itt" egy levélben, egy Discord-üzenetben,
//     egy hibaüzenetben — mindegyikhez cím kell;
//   * a HOZZÁFÉRÉSI KAPU nem tudott hová küldeni. Aki belépés nélkül nyitott
//     meg egy zárt oldalt, egy beágyazott kis űrlapot kapott, nem egy helyet,
//     ahová megérkezik;
//   * a VISSZA gomb nem működik rajta, és telefonon ez az elsődleges kilépés;
//   * a jelszókezelők a felugró ablakot nehezebben ismerik fel, mint egy
//     önálló lapot valódi `<form>`-mal.
//
// A LAP ÉS AZ ABLAK UGYANAZT AZ ŰRLAPOT használja (`features/auth/auth-form.js`).
// Nem másolat: a különbség a keret, nem a logika.
//
// Címek:
//   #/login                  belépés
//   #/login/register         regisztráció
//   #/login?next=list        siker után ide megy tovább

import { P } from '../shared/ui/primitives.js'
import { T } from '../shared/i18n/i18n.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'
import { afterAuth, setTitle } from '../shared/lib/shell.js'
import { createAuthForm } from '../features/auth/auth-form.js'

/**
 * Hová mehetünk siker után.
 *
 * A `?next=` a CÍMSORBÓL jön, tehát bárki megírhatja. Ezért nem tisztogatjuk,
 * hanem ELLENŐRIZZÜK: csak az útvonal neve és egy opcionális azonosító lehet
 * benne — se séma, se gazda, se lekérdezés, se pont.
 *
 * Ami nem illik a mintára, az a főoldal:
 *
 *   `//rossz.example`  → a perjelek lehullanak, a pont elbuktatja → home
 *   `javascript:...`   → a kettőspont nincs a mintában          → home
 *   `login`            → önmagába vezetne                        → home
 *
 * A kör bezárásaként: az eredmény mindig `location.hash`-be megy, ami a
 * böngészőben SOSEM visz el az oldalról. A minta tehát nem az egyetlen
 * védelem, hanem az, ami miatt egy elrontott link se vigyen sehova furcsán.
 */
export function safeNext (next) {
  if (typeof next !== 'string' || !next) return 'home'
  const match = /^([a-z]+)(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(next.replace(/^#?\/+/, ''))
  if (!match) return 'home'
  const [, route, arg] = match
  if (route === 'login') return 'home'
  return arg ? `${route}/${arg}` : route
}

export const PageLogin = {
  /**
   * @param {HTMLElement} root
   * @param {URLSearchParams} params
   * @param {string|undefined} arg   `#/login/register` → 'register'
   *
   * A LAP NEM IMPORTÁLJA A ROUTERT, és ez nem stílus: a `shared/lib/shell.js`
   * ki is mondja, miért — tizenkét képernyő tette, és attól egyiket sem
   * lehetett betölteni vagy tesztelni a teljes router nélkül, miközben a
   * router minden képernyőt importál. A shell azt ajánlja fel, amit egy
   * képernyő kérhet tőle; ez a lap kettőt kér.
   */
  render (root, params, arg) {
    const next = safeNext(params.get('next'))
    const go = () => { window.location.hash = `#/${next}` }

    const wrap = U.el('div', { class: 'auth-page' })
    root.append(wrap)

    /*
     * AKI MÁR BENT VAN, annak ez a lap nem űrlap, hanem egy elágazás. A régi
     * viselkedés az volt, hogy egy belépett látogató is üres mezőket kapott —
     * amiből az következett volna, hogy nincs is bejelentkezve.
     */
    const user = YumeAPI.user()
    if (user) {
      wrap.append(U.el('div', { class: 'auth-card' }, [
        U.el('h1', { class: 'auth-title', text: T('You are signed in') }),
        U.el('p', { class: 'auth-sub', text: `${T('Signed in as ')}${user.username}.` }),
        U.el('div', { class: 'auth-actions' }, [
          P.button(T('Continue'), { variant: 'primary', onclick: go }),
          P.button(T('Sign out'), {
            variant: 'ghost',
            onclick: async () => { await YumeAPI.logout(); await afterAuth() }
          })
        ])
      ]))
      return
    }

    const cim = U.el('h1', { class: 'auth-title' })
    const alcim = U.el('p', { class: 'auth-sub' })

    const form = createAuthForm({
      // A cím útvonalrésze választja a fület: a `#/login/register` egy
      // hivatkozható regisztrációs lap, nem egy belépőlap egy extra kattintással.
      mode: arg === 'register' ? 'register' : 'login',
      onAuthed: async () => {
        /*
         * ELŐBB A CÍM, UTÁNA A FRISSÍTÉS.
         *
         * Az `onAuthed` a végén újrarajzolja az aktuális útvonalat. Ha előbb
         * frissítenénk, az a BELÉPŐLAPOT rajzolná újra („már be vagy lépve"),
         * és csak utána ugranánk tovább — egy fölösleges villanás. Fordítva a
         * frissítés már a célra érkezik.
         */
        go()
        await afterAuth()
      },
      onModeChange: mode => {
        cim.textContent = mode === 'login' ? T('Sign in') : T('Create an account')
        alcim.textContent = mode === 'login'
          ? T('Your list, your history and your settings follow you.')
          : T('It takes a moment, and nothing but an email address.')
        setTitle(cim.textContent)
        /*
         * A CÍMSOR IS KÖVESSE a fület — de `replaceState`-tel, nem
         * navigációval: a `#/login` és a `#/login/register` ugyanaz a lap, és
         * egy valódi navigáció újrarajzolná, elvéve a fókuszt és eldobva a
         * félig kitöltött mezőket. Az előzményekbe sem érdemes minden
         * fülváltást beírni: a Vissza gomb így oda visz, ahonnan jöttünk.
         */
        const query = params.get('next') ? `?next=${encodeURIComponent(params.get('next'))}` : ''
        const target = `#/login${mode === 'register' ? '/register' : ''}${query}`
        if (window.location.hash !== target) window.history?.replaceState?.(null, '', target)
      }
    })

    wrap.append(U.el('div', { class: 'auth-card' }, [
      cim,
      alcim,
      form.node,
      U.el('a', { class: 'auth-back', href: '#/home' }, [document.createTextNode(T('Back home'))])
    ]))

    form.focus()

    /*
     * TAKARÍTÁS, AMIKOR A LAP ELTŰNIK.
     *
     * Az emberpróba widgetje iframe-et és időzítőt hagyna maga után, és a
     * router navigációkor egyszerűen kicseréli a lap tartalmát — nem szól
     * senkinek. Ugyanaz a minta, amivel a lejátszó is leszereli magát: figyeljük,
     * mikor kerül ki a beágyazó elem a dokumentumból.
     */
    const observer = new MutationObserver(() => {
      if (!document.body.contains(wrap)) {
        form.destroy()
        observer.disconnect()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }
}
