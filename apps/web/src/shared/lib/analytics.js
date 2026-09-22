// Oldalletöltés jelzése.
//
// Ez a kliens teljes szerepe a látogatottságban: megmondja, melyik oldalra
// lépett. Ki ő, mikor volt, milyen eszközről — mindezt a kiszolgáló állapítja
// meg, mert amit a kliens mond, azt hamisítani is tudja.
//
// Négy szabály, mind az „ne rontsa el az oldalt" családból:
//
//   * nem blokkol. A jelzés elindul, és senki nem várja meg;
//   * nem hibázik. Egy elbukott statisztikai hívás nem lehet hibaüzenet a
//     képernyőn, és nem kerülhet a hibanaplóba sem;
//   * nem tárol semmit a böngészőben. Nincs süti, nincs azonosító — így
//     hozzájárulási sáv sem kell hozzá;
//   * nem ismétel. Ugyanaz az útvonal két másodpercen belül egy jelzés, mert
//     a kliens is tud kétszer navigálni ugyanoda.

import { YumeAPI } from '../api/yume.js'

let last = { route: '', at: 0 }

/** A hivatkozó — csak az első betöltésnél, utána már mi magunk volnánk az. */
let referrer = typeof document !== 'undefined' ? document.referrer : ''

/**
 * Az UTM-paraméterek a belépő címből.
 *
 * Egyszer olvassuk ki, az első betöltéskor: a kampányparaméterek a belépéshez
 * tartoznak, nem minden későbbi kattintáshoz.
 */
const utm = (() => {
  try {
    const p = new URLSearchParams(window.location.search)
    const out = {}
    for (const key of ['source', 'medium', 'campaign']) {
      const value = p.get('utm_' + key)
      if (value) out[key] = value.slice(0, 80)
    }
    return Object.keys(out).length ? out : undefined
  } catch { return undefined }
})()
let utmSent = false

/**
 * Egy oldalletöltés.
 *
 * @param {string} route     az alkalmazás útvonala, például `/anime/:id`
 * @param {string} [entityId] a cím azonosítója, ha a lap egy címhez tartozik
 */
export function pageView (route, entityId) {
  const now = Date.now()
  if (route === last.route && now - last.at < 2000) return
  last = { route, at: now }

  const body = { route, screenWidth: window.innerWidth || undefined }
  if (entityId) body.entityId = entityId
  if (referrer) { body.referrer = referrer; referrer = '' }
  if (utm && !utmSent) { body.utm = utm; utmSent = true }

  // Szándékosan elnyelve: a statisztika hibája nem a felhasználó gondja, és
  // egy hibajelentés belőle csak zaj a triázsban.
  YumeAPI.analytics?.view(body)?.catch(() => {})
}

/**
 * EGY ESEMÉNY — nem oldalletöltés, hanem SZÁNDÉK.
 *
 * Az oldalletöltés a keret: hol jár a látogató. Az esemény az, hogy mit
 * AKART: rákattintott egy találatra, felvett egy címet. A kettő külön
 * végponton megy, mert más az alakjuk és más a megőrzésük.
 *
 * UGYANAZ A NÉGY SZABÁLY: nem blokkol, nem hibázik, nem tárol semmit a
 * böngészőben, és a kiszolgáló dönti el, ki a hívó és mikor volt. Amit a
 * kliens küld — típus, alany, pozíció —, az minden; a `userId` vagy egy
 * időbélyeg innen hatástalan, a séma ledobja.
 *
 * @param {string} type       zárt szótárból, lásd `analytics/events.ts`
 * @param {object} [detail]   { subjectType, subjectId, position, searchId }
 */
export function trackEvent (type, detail = {}) {
  const body = { type }
  if (detail.subjectType) body.subjectType = String(detail.subjectType).slice(0, 32)
  if (detail.subjectId) body.subjectId = String(detail.subjectId).slice(0, 64)
  if (Number.isFinite(detail.position)) body.position = Math.max(1, Math.min(500, Math.round(detail.position)))
  if (detail.searchId) body.searchId = String(detail.searchId).slice(0, 64)

  YumeAPI.analytics?.event(body)?.catch(() => {})
}
