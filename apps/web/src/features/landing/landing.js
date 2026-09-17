/* global window, document */
// A kezdőképernyő.
//
// Nem csak a bejelentkezés előtti kapu: saját útvonala van (#/landing), és
// belépve is elérhető marad. Aki már fiókkal jön, annak is van joga megnézni,
// mit ígér az oldal.
//
// A belépés nem szekció a lap alján, hanem egy profil-ikon a fejlécben. Aki
// olvasni jött, azt ne állítsa meg egy űrlap; aki belépni, annak ne kelljen a
// lap aljára görögnie. A fejléc átlátszó, és csak görgetés közben tömörödik
// be — így az első képernyőn semmi nem takarja a címet.
//
// Szándékosan nincs rajta katalógusadat. A referenciaoldal nyitóképernyőjén
// sincs borító: óriás cím, egy sor alcím, két gomb és egy vízjel. Ez itt
// szerencse is, mert a példány privát, és élő borítókat mutatni kijelentkezett
// látogatóknak szabályzati döntés, nem oldalszerkesztés.

import { C } from '../../shared/ui/components.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'

/** Szekciócím, az első szón színátmenettel — ahogy a referencia csinálja. */
function displayHeading (lead, rest) {
  return U.el('h2', { class: 'lp-display' }, [
    U.el('span', { class: 'lp-display-lead', text: lead }),
    document.createTextNode(rest)
  ])
}

function feature (icon, title, body) {
  return U.el('div', { class: 'lp-feature' }, [
    U.el('div', { class: 'lp-feature-icon' }, [icon]),
    U.el('div', {}, [
      U.el('h3', { class: 'lp-feature-title', text: title }),
      U.el('p', { class: 'lp-feature-body', text: body })
    ])
  ])
}

const ICON = {
  fast: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  library: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  sync: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/><path d="M21 3v6h-6"/>',
  together: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  schedule: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  free: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'
}

export const Landing = {
  /**
   * @param {HTMLElement} root  ide kerül az oldal
   * @param {object} site       a /v1/config `site` blokkja: { name, tagline }
   * @param {Function} onAuth   megmarad a hívó kedvéért; a belépés a `#/login`
   *                              lapon történik, ami maga frissíti a krómot
   */
  render (root, site, onAuth = () => {}) {
    const name = site?.name ?? 'Yume'
    const page = U.el('div', { class: 'landing' })
    root.append(page)

    // ---- fejléc ------------------------------------------------------------
    // Egyetlen gomb jobb felül. Belépve a felhasználó kezdőbetűje, kilépve egy
    // személy-ikon — ugyanaz a hely, ugyanaz a méret, csak más a tartalma, így
    // a fejléc nem ugrik meg belépés után.
    const account = U.el('button', {
      class: 'lp-account',
      type: 'button',
      'aria-label': T('Fiók'),
      /*
       * A BELÉPÉSNEK SAJÁT LAPJA VAN (`#/login`), fülekkel. Itt korábban egy
       * felugró ablak nyílt: ugyanaz az űrlap, másik keretben. Két felület
       * ugyanarra a dologra azt jelenti, hogy az egyik előbb-utóbb lemarad
       * egy változásról — pontosan ez történt, amikor az emberpróba bekerült.
       */
      onclick: () => {
        window.location.hash = YumeAPI.user() ? '#/profile' : '#/login'
      }
    })

    const paintAccount = () => {
      const user = YumeAPI.user()
      account.replaceChildren(
        user
          ? U.el('span', { class: 'lp-account-letter', text: (user.username?.[0] ?? '?').toUpperCase() })
          : U.svg(ICON.user, 18)
      )
      account.title = user ? user.username : T('Belépés')
    }
    paintAccount()

    const header = U.el('header', { class: 'lp-header' }, [
      U.el('a', { class: 'lp-brand', href: '#/landing' }, [
        U.el('span', { class: 'lp-brand-mark', text: name[0] ?? 'Y' }),
        U.el('span', { class: 'lp-brand-name', text: name.toLowerCase() })
      ]),
      U.el('nav', { class: 'lp-header-nav' }, [
        U.el('a', { href: '#what', text: T('Mit tud?') }),
        U.el('a', { href: '#/home', text: T('Belépés a webre') })
      ]),
      account
    ])
    page.append(header)

    // Átlátszó, amíg a lap tetején vagyunk. A `.page` a görgető, nem az ablak
    // — lásd style.css `.app-shell` —, úgyhogy a figyelő is oda kerül.
    const scroller = root.closest('.page') ?? root
    const onScroll = () => header.classList.toggle('lp-header-solid', scroller.scrollTop > 24)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    onScroll()

    // ---- hero --------------------------------------------------------------
    page.append(U.el('div', { class: 'lp-hero' }, [
      U.el('div', { class: 'lp-watermark', 'aria-hidden': 'true', text: name }),
      U.el('h1', { class: 'lp-title' }, [
        U.el('span', { class: 'lp-title-lead', text: T('Nézz animét') }),
        document.createTextNode(' ' + T('úgy, ahogy neked jó.'))
      ]),
      U.el('p', { class: 'lp-sub', text: T('Kövesd, amit nézel. Találd meg, amit keresel. Folytasd ott, ahol abbahagytad — bármelyik eszközön.') }),
      U.el('div', { class: 'lp-cta' }, [
        U.el('a', { class: 'btn btn-primary', href: '#/home' }, [document.createTextNode(T('Kezdés'))]),
        U.el('a', { class: 'btn btn-ghost', href: '#what' }, [document.createTextNode(T('Mit tud?'))])
      ])
    ]))

    // ---- mit tud -----------------------------------------------------------
    page.append(U.el('section', { class: 'lp-section', id: 'what' }, [
      U.el('p', { class: 'lp-eyebrow', text: T('MINDEN, AMIRE SZÜKSÉGED VAN') }),
      displayHeading(T('Anime'), T(' egyszerűen, gyorsan.')),
      U.el('p', { class: 'lp-lead', text: T('Egy hely a könyvtáradnak, a menetrendednek és annak, amit a barátaiddal néztek.') }),
      U.el('div', { class: 'lp-features' }, [
        feature(U.svg(ICON.fast, 22), T('Gyors, és nem áll az utadban'), T('Az oldalváltás ezredmásodpercek kérdése. Semmi felesleges animáció, semmi várakozás.')),
        feature(U.svg(ICON.library, 22), T('A könyvtárad, rendben tartva'), T('Pontszám, haladás, állapot és kedvencek — a nézett epizódok maguktól követve, nem kézzel pipálva.')),
        feature(U.svg(ICON.sync, 22), T('AniList és MyAnimeList'), T('Hozd magaddal a listádat, és tartsd szinkronban. Nem kell két helyen vezetned ugyanazt.')),
        feature(U.svg(ICON.schedule, 22), T('Tudd, mikor jön a következő'), T('Vetítési naptár a saját időzónádban, visszaszámlálóval a következő epizódig.')),
        feature(U.svg(ICON.together, 22), T('Nézzétek együtt'), T('Szinkronizált lejátszás és chat, akárhol vagytok. Egy link, és kezdődhet.')),
        feature(U.svg(ICON.free, 22), T('Ingyenes, és az is marad'), T('Nincs előfizetés és nincs prémium szint. Ami működik, mindenkinek működik.'))
      ])
    ]))

    // ---- záró ---------------------------------------------------------------
    page.append(U.el('section', { class: 'lp-section lp-close' }, [
      displayHeading(T('Kezdjük.'), ''),
      U.el('p', { class: 'lp-lead', text: T('Fiók kell hozzá — így tudjuk megjegyezni, hol tartasz.') }),
      U.el('div', { class: 'lp-cta' }, [
        U.el('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => {
            window.location.hash = YumeAPI.user() ? '#/home' : '#/login/register'
          }
        }, [document.createTextNode(YumeAPI.user() ? T('Tovább a főoldalra') : T('Fiók létrehozása'))])
      ])
    ]))

    page.append(C.footer())
    return page
  }
}
