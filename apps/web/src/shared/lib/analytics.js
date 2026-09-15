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
