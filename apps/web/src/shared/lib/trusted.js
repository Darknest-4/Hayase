// Trusted Types — az EGYETLEN hely, ahol szövegből HTML vagy szkriptcím lesz.
//
// MIÉRT. A szerver CSP-je (apps/api/src/middleware/security.ts) kéri a
// `require-trusted-types-for 'script'` irányelvet. Ezzel a böngésző MEGTAGAD
// minden `innerHTML = '…'`-t, `DOMParser`-elemzést és `script.src = '…'`-t,
// ami nem egy megnevezett szabályon (policy) ment át. Egy új, nyers HTML-írás
// így nem XSS-ként derül ki, hanem azonnal — kivételként, a fejlesztő saját
// böngészőjében. A Chromium-alapú böngészők kényszerítik ki; a többiben ez a
// modul átengedő, és a viselkedés változatlan.
//
// KÉT SZABÁLY, KÉT KÜLÖN ÍGÉRET:
//
//   yume        SAJÁT, statikus sablonok: ikonok, a lejátszó váza. A külső adat
//               bennük escape()-elve vagy utólag textContent-ként kerül — ezt a
//               hívó ígéri, és a web/test/trusted-sinks.test.mjs csak ezen a
//               modulon át engedi a nyelőket.
//   yume-inert  KÜLSŐ, megbízhatatlan szöveg, de KIZÁRÓLAG inert elemzésre (a
//               DOMParser dokumentumának nincs böngészési kontextusa: nem tölt
//               be és nem futtat semmit), amiből csak a textContent-et olvassuk.
//               Élő dokumentumba soha nem kerül.
//
// Szkriptcím csak a Turnstile eredetéről jöhet — Trusted Types nélkül is ez a
// szabály, nem csak ott, ahol a böngésző kikényszeríti.

const SCRIPT_ORIGINS = new Set(['https://challenges.cloudflare.com'])

function create (name, rules) {
  const factory = globalThis.trustedTypes
  if (!factory?.createPolicy) return null
  try {
    return factory.createPolicy(name, rules)
  } catch (error) {
    // A CSP `trusted-types` listája nem engedi ezt a nevet: minden nyelő
    // hibát fog dobni. Ezt hangosan kell tudni, nem egy üres oldalból.
    console.error(`[trusted-types] a(z) „${name}" szabály nem hozható létre:`, error)
    return null
  }
}

function checkedScriptURL (value) {
  const url = new URL(String(value), globalThis.location?.href)
  if (!SCRIPT_ORIGINS.has(url.origin)) throw new TypeError(`Nem engedélyezett szkript-eredet: ${url.origin}`)
  return url.href
}

/*
 * A SZABÁLYOK A DOKUMENTUMÉI, NEM A MODULPÉLDÁNYÉI.
 *
 * Ugyanez a modul két címről is betöltődhet — az oldal a `/b/<bélyeg>/src/…`
 * alól tölti, egy próbapad (tests/e2e/player2.test.mjs) a `/src/…` alól. Két
 * cím két példány, és a második a CSP zárt névlistája miatt NEM hozhatja létre
 * újra a `yume` szabályt: minden nyelője kivételt dobott. Az E2E így fogta meg,
 * a lejátszó csúszkájánál. A CSP-t ezért nem lazítjuk (`'allow-duplicates'`),
 * hanem az első példány szabályait a többi is megkapja.
 */
const SHARED = Symbol.for('yume.trusted-types')
function policies () {
  if (!globalThis[SHARED]) {
    // Nem felsorolható és nem felülírható; törölni lehet (a tesztek ezzel
    // kezdenek tiszta lappal) — egy újrakért szabályt a CSP névlistája úgyis
    // megtagadna.
    Object.defineProperty(globalThis, SHARED, {
      configurable: true,
      value: Object.freeze({
        templates: create('yume', { createHTML: html => html, createScriptURL: checkedScriptURL }),
        inert: create('yume-inert', { createHTML: html => html })
      })
    })
  }
  return globalThis[SHARED]
}
const { templates, inert } = policies()

/** Saját, statikus HTML-sablon — a külső adat benne escape()-elve. */
export function trustedHTML (html) {
  return templates ? templates.createHTML(html) : html
}

/** Egy szkript címe; csak a Turnstile eredetéről. */
export function trustedScriptURL (url) {
  const checked = checkedScriptURL(url)
  return templates ? templates.createScriptURL(checked) : checked
}

/** Külső HTML-szöveg, KIZÁRÓLAG inert elemzésre (DOMParser → textContent). */
export function inertHTML (html) {
  return inert ? inert.createHTML(html) : html
}

/** A CSP `trusted-types` irányelvébe írandó nevek — a szerver tesztje ezt veti össze. */
export const POLICY_NAMES = ['yume', 'yume-inert']
