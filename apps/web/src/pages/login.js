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
// A KERET KÉT HASÁB, nem egy doboz a semmi közepén. A régi elrendezés egy
// 26rem-es kártya volt egy üres fekete lapon: a látómező háromnegyede semmi,
// sehol egy márkajel, és a doboz ugyanúgy nézett ki, mint bármelyik másik
// alkalmazásé. Bal oldalt most ott van, hogy HOVÁ lép be az ember és mit kap
// tőle; jobb oldalt az űrlap. Telefonon egy hasáb marad, mert ott a
// meggyőzésnél fontosabb, hogy a mezők a hüvelykujj közelében legyenek.
//
// Címek:
//   #/login                  belépés
//   #/login/register         regisztráció
//   #/login?next=list        siker után ide megy tovább

import { P } from '../shared/ui/primitives.js'
import { T } from '../shared/i18n/i18n.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'
import { site } from '../shared/lib/site-config.js'
import { afterAuth, setTitle } from '../shared/lib/shell.js'
import { createAuthForm } from '../features/auth/auth-form.js'

/*
 * A bal hasáb pontjai. Vonalas ikonok, ugyanabból a készletből, amit a
 * kezdőképernyő is használ — nem új ikonnyelv, csak három darab belőle.
 */
const ICON = {
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  resume: '<path d="M12 22a10 10 0 1 1 10-10"/><path d="M12 7v5l3 2"/><path d="M17 17h5v5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'
}

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

/** Egy pont a bal hasábban: ikon, cím, egy mondat. */
function pont (icon, cim, szoveg) {
  return U.el('li', { class: 'auth-point' }, [
    U.el('span', { class: 'auth-point-icon', 'aria-hidden': 'true' }, [U.svg(icon, 18)]),
    U.el('div', {}, [
      U.el('strong', { class: 'auth-point-title', text: cim }),
      U.el('span', { class: 'auth-point-text', text: szoveg })
    ])
  ])
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
    const name = site()?.name ?? 'Yume'

    const wrap = U.el('div', { class: 'auth-page' })
    root.append(wrap)

    /*
     * A BAL HASÁB. `aria-hidden`, mert nem tartalmaz olyat, amit egy
     * képernyőolvasónak a belépéshez tudnia kell — a márkanév a fejlécből és
     * a lap címéből is megvan, a három pont pedig díszítő ismétlés. Aki
     * hanggal navigál, annak az űrlap az első dolog, nem egy reklámszöveg.
     */
    wrap.append(U.el('aside', { class: 'auth-aside', 'aria-hidden': 'true' }, [
      U.el('a', { class: 'lp-brand', href: '#/landing' }, [
        U.el('span', { class: 'lp-brand-mark', text: name[0] ?? 'Y' }),
        U.el('span', { class: 'lp-brand-name', text: name.toLowerCase() })
      ]),
      U.el('p', { class: 'auth-pitch', text: T('Egy fiók, és a lista ott folytatódik, ahol abbahagytad.') }),
      U.el('ul', { class: 'auth-points' }, [
        pont(ICON.list, T('A saját listád'), T('Amit nézel, amit terveztél, amit befejeztél — egy helyen.')),
        pont(ICON.resume, T('Folytatás bárhonnan'), T('A megállás helye átjön a telefonról a gépre és vissza.')),
        pont(ICON.shield, T('A tiéd marad'), T('Nincs hirdetés és nincs követés; a fiókod bármikor törölhető.'))
      ])
    ]))

    const fo = U.el('div', { class: 'auth-main' })
    wrap.append(fo)

    /*
     * AKI MÁR BENT VAN, annak ez a lap nem űrlap, hanem egy elágazás. A régi
     * viselkedés az volt, hogy egy belépett látogató is üres mezőket kapott —
     * amiből az következett volna, hogy nincs is bejelentkezve.
     */
    const user = YumeAPI.user()
    if (user) {
      fo.append(U.el('div', { class: 'auth-card' }, [
        U.el('h1', { class: 'auth-title', text: T('Már be vagy lépve') }),
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

    fo.append(U.el('div', { class: 'auth-card' }, [cim, alcim, form.node]))

    /*
     * A KIJÁRAT A KEZDŐKÉPERNYŐRE VISZ, nem a főoldalra.
     *
     * A `#/home` a kapu mögött van: zárt példányon egy ki nem lépett
     * látogatót a kapu azonnal visszadobna ide, tehát a link egy kört futott
     * volna és ugyanitt köt ki. A kezdőképernyő az, ami belépés nélkül is a
     * miénk.
     */
    fo.append(U.el('a', { class: 'auth-back', href: '#/landing' }, [
      document.createTextNode(T('Vissza a kezdőképernyőre'))
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
