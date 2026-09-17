/* global document, window, setTimeout, clearTimeout */
// Cloudflare Turnstile — a widget, és minden, ami körülötte elromolhat.
//
// A SZKRIPT IDEGEN EREDETŰ, és ez az egyetlen ilyen az oldalon. Ezért:
//
//   * csak akkor töltjük be, ha ez a példány tényleg kér emberpróbát (a
//     kiszolgáló a `/v1/config`-ban mondja meg) — egy Turnstile nélküli
//     telepítés böngészője rá se nézzen;
//   * egyszer töltjük be, akárhány űrlap kéri;
//   * és NEM feltételezzük, hogy sikerül. Reklámszűrő, vállalati proxy,
//     szakadó hálózat: bármelyik megeheti. Ilyenkor a felhasználónak meg kell
//     tudnia, miért nem tud belépni — egy örökké pörgő gomb a legrosszabb
//     válasz.
//
// A TOKEN EGYSZER HASZNÁLATOS, és néhány perc múlva lejár. Ebből két szabály
// következik, amit a hívónak nem kell fejben tartania: küldés után magától
// újrarajzolunk, lejáratkor pedig eldobjuk, amink van.

import { site } from './site-config.js'

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/** A globális név, amit a Turnstile a betöltés végén meghív. */
const READY_CALLBACK = 'yumeTurnstileReady'

/** Meddig várunk egy tokenre, mielőtt feladjuk. */
const TOKEN_TIMEOUT_MS = 20000

/** A helyszín kulcsa, vagy `null`, ha ez a példány nem kér emberpróbát. */
export function siteKey () {
  return site()?.turnstileSiteKey ?? null
}

/**
 * Kell-e emberpróba ehhez a művelethez.
 *
 * A kiszolgáló sorolja fel, MELYIK űrlapot védi. Enélkül vagy mindenhová
 * kitennénk a widgetet, vagy sehová — és utóbbinál a küldés akadna el egy
 * olyan hibával, amit a látogató nem tud értelmezni.
 */
export function needed (action) {
  const key = siteKey()
  if (!key) return false
  const on = site()?.turnstileOn
  // Lista híján feltételezzük, hogy kell: egy fölösleges widget zavaró, egy
  // hiányzó viszont megakadályozza a belépést.
  return Array.isArray(on) ? on.includes(action) : true
}

let loading = null

/** A szkript betöltése — egyszer, akárhány hívóra. */
function load () {
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    if (window.turnstile) { resolve(window.turnstile); return }

    window[READY_CALLBACK] = () => resolve(window.turnstile)

    const script = document.createElement('script')
    script.src = SCRIPT_URL + '&onload=' + READY_CALLBACK
    script.async = true
    script.defer = true
    script.onerror = () => reject(new Error('az emberpróba nem tölthető be'))
    document.head.append(script)

    // Ha a szkript betöltődik, de a visszahívás mégsem fut le (blokkolt
    // iframe, félbeszakadt kérés), ne várjunk rá örökké.
    setTimeout(() => reject(new Error('az emberpróba nem válaszolt')), TOKEN_TIMEOUT_MS)
  })
  return loading
}

/**
 * Egy widget egy űrlaphoz.
 *
 * @param {string} action  amit a kiszolgáló is vár: 'register' | 'login' | 'forgot'
 * @returns {{node: HTMLElement, token: Function, reset: Function, destroy: Function}}
 */
export function createTurnstile (action) {
  const node = document.createElement('div')
  node.className = 'turnstile'

  let widgetId = null
  let held = null
  let failure = null
  let waiting = []

  const settle = () => {
    const pending = waiting
    waiting = []
    for (const { resolve, reject } of pending) {
      if (held) resolve(held)
      else reject(failure ?? new Error('az emberpróba nem adott választ'))
    }
  }

  const rendered = load().then(api => {
    widgetId = api.render(node, {
      sitekey: siteKey(),
      action,
      // A világos/sötét témát a widget a rendszerbeállításból veszi. Az
      // oldalé ettől eltérhet, de a `auto` rosszabb esetben is olvasható
      // marad — egy rögzített téma viszont egy sötét lapon fehér téglalap.
      theme: 'auto',
      callback: token => { held = token; failure = null; settle() },
      'expired-callback': () => { held = null },
      'timeout-callback': () => { held = null },
      'error-callback': () => {
        held = null
        failure = new Error('Az emberpróba nem futott le. Ellenőrizd, hogy egy bővítmény nem tiltja-e.')
        settle()
      }
    })
  }).catch(error => {
    failure = new Error('Az emberpróba nem tölthető be. Ha reklámszűrőt használsz, engedélyezd ezt az oldalt.')
    failure.cause = error
    settle()
    // A hibát ITT nyeljük el: a `rendered` ígéretre senki nem vár, és egy
    // elkapatlan elutasítás a konzolt szemeteli tele.
  })

  return {
    node,

    /**
     * A token, amivel a kérés mehet.
     *
     * Megvárja a widgetet, ha az még dolgozik. A várakozás korlátos: egy
     * gomb, ami örökké pörög, semmivel sem jobb, mint egy hibaüzenet.
     */
    async token () {
      await rendered
      if (held) return held
      if (failure) throw failure
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = waiting.filter(w => w.resolve !== wrapped)
          reject(new Error('Az emberpróba időtúllépéssel leállt. Próbáld újra.'))
        }, TOKEN_TIMEOUT_MS)
        const wrapped = value => { clearTimeout(timer); resolve(value) }
        waiting.push({ resolve: wrapped, reject: error => { clearTimeout(timer); reject(error) } })
      })
    },

    /** Küldés után. A token egyszer használatos — a következőhöz új kell. */
    reset () {
      held = null
      if (widgetId !== null && window.turnstile) {
        try { window.turnstile.reset(widgetId) } catch { /* a widget már nincs a lapon */ }
      }
    },

    /** Az ablak bezárásakor. A widget iframe-et és időzítőt hagyna maga után. */
    destroy () {
      waiting = []
      if (widgetId !== null && window.turnstile) {
        try { window.turnstile.remove(widgetId) } catch { /* már eltűnt */ }
      }
      widgetId = null
      node.remove()
    }
  }
}
