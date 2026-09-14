// What a visitor sees before they have an account.
//
// Until now that was a padlock, four words and a sign-in card: correct, and it
// told a first-time visitor nothing about what the site is. This is the same
// gate — nothing is unlocked here, `require_login` still decides what is
// reachable — with the reasons to sign in put in front of the form instead of
// behind it.
//
// Deliberately no catalogue data. The reference site's landing screen carries
// no cover art either: a display heading, a line of subtitle, two buttons and
// a watermark, with product shots further down. That is lucky as well as
// faithful, because this instance is private and a showcase of live covers
// would be a policy change rather than a page — one for the owner to make, not
// for a landing page to assume.

import { C } from '../../shared/ui/components.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'

/** A section heading with the first word in a gradient, as the reference does. */
function displayHeading (lead, rest) {
  return U.el('h2', { class: 'lp-display' }, [
    U.el('span', { class: 'lp-display-lead', text: lead }),
    document.createTextNode(rest)
  ])
}

/** icon + bold title + muted body, left aligned, one per scroll. */
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
  free: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'
}

export const Landing = {
  /**
   * @param {HTMLElement} root  where the page goes
   * @param {object} site       the /v1/config site block: { name, tagline }
   * @param {Function} onAuth   called after a successful sign-in or register
   */
  render (root, site, onAuth) {
    const name = site?.name ?? 'Yume'
    const page = U.el('div', { class: 'landing' })
    root.append(page)

    // ---- hero -------------------------------------------------------------
    // The watermark is the site's own name, outlined and barely there. It is
    // aria-hidden: it is texture, and a screen reader announcing the name twice
    // before the heading is noise.
    page.append(U.el('div', { class: 'lp-hero' }, [
      U.el('div', { class: 'lp-watermark', 'aria-hidden': 'true', text: name }),
      U.el('h1', { class: 'lp-title' }, [
        U.el('span', { class: 'lp-title-lead', text: T('Nézz animét') }),
        document.createTextNode(' ' + T('úgy, ahogy neked jó.'))
      ]),
      U.el('p', { class: 'lp-sub', text: site?.tagline ?? T('Track, discover and watch anime — your way.') }),
      U.el('div', { class: 'lp-cta' }, [
        U.el('a', { class: 'btn btn-primary', href: '#signin' }, [document.createTextNode(T('Kezdés'))]),
        U.el('a', { class: 'btn btn-ghost', href: '#what' }, [document.createTextNode(T('Mit tud?'))])
      ])
    ]))

    // ---- what it does -----------------------------------------------------
    page.append(U.el('section', { class: 'lp-section', id: 'what' }, [
      U.el('p', { class: 'lp-eyebrow', text: T('MINDEN, AMIRE SZÜKSÉGED VAN') }),
      displayHeading(T('Anime'), T(' streaming, egyszerűen.')),
      U.el('p', { class: 'lp-lead', text: T('Egy hely, ahol követed amit nézel, megtalálod amit keresel, és folytatod ott, ahol abbahagytad — bármelyik eszközön.') }),
      U.el('div', { class: 'lp-features' }, [
        feature(U.svg(ICON.fast, 22), T('Gyors, és nem áll az utadban'), T('Az oldal váltása ezredmásodpercek kérdése, nem másodperceké. Semmi felesleges animáció, semmi várakozás a tartalomra.')),
        feature(U.svg(ICON.library, 22), T('A könyvtárad, rendben tartva'), T('Pontszám, haladás, állapot és kedvencek — és a nézett epizódok maguktól követve, nem kézzel pipálva.')),
        feature(U.svg(ICON.sync, 22), T('AniList és MyAnimeList'), T('Hozd magaddal a listádat, és tartsd szinkronban. Nem kell két helyen vezetned ugyanazt.')),
        feature(U.svg(ICON.schedule, 22), T('Tudd, mikor jön a következő'), T('Vetítési naptár a saját időzónádban, visszaszámlálóval a következő epizódig.')),
        feature(U.svg(ICON.together, 22), T('Nézzétek együtt'), T('Szinkronizált lejátszás és chat, akárhol vagytok. Egy link, és kezdődhet.')),
        feature(U.svg(ICON.free, 22), T('Ingyenes, és az is marad'), T('Nincs előfizetés és nincs prémium szint. Ami működik, mindenkinek működik.'))
      ])
    ]))

    // ---- sign in ----------------------------------------------------------
    // The form is the end of the page, not the beginning: everything above is
    // the answer to "why would I".
    page.append(U.el('section', { class: 'lp-section lp-signin', id: 'signin' }, [
      displayHeading(T('Kezdjük.'), ''),
      U.el('p', { class: 'lp-lead', text: T('Fiók kell hozzá — így tudjuk megjegyezni, hol tartasz.') }),
      C.authCard(onAuth)
    ]))

    page.append(C.footer())
    return page
  }
}
