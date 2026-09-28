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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function send (route, entityId) {
  const now = Date.now()
  if (route === last.route && now - last.at < 2000) return
  last = { route, at: now }

  const body = { route, screenWidth: window.innerWidth || undefined }
  if (entityId && UUID.test(entityId)) body.entityId = entityId
  if (referrer) { body.referrer = referrer; referrer = '' }
  if (utm && !utmSent) { body.utm = utm; utmSent = true }

  // Szándékosan elnyelve: a statisztika hibája nem a felhasználó gondja, és
  // egy hibajelentés belőle csak zaj a triázsban.
  YumeAPI.analytics?.view(body)?.catch(() => {})
}

/*
 * A CÍMHEZ TARTOZÓ OLDAL MEGVÁRJA A CÍM AZONOSÍTÓJÁT.
 *
 * A kiszolgáló `entityId`-ként katalógus-azonosítót (uuid) fogad el. A címsor
 * viszont legtöbbször AniList-számot hordoz (`#/anime/21`), és a router eddig
 * ezt küldte: a séma 400-zal dobta el, vagyis MINDEN így megnyitott adatlap és
 * lejátszó kiesett a látogatottságból. Mérve, a helyi példányon: 26 elutasított
 * jelzés 26 adatlap-megnyitásra.
 *
 * Ezért egy számmal nyitott címoldal jelzése függőben marad, amíg a lap fel
 * nem oldja a címet (`viewEntity`). Ha nem oldja fel — nincs ilyen cím, vagy a
 * lap elhasalt —, öt másodperc után, vagy a következő navigációnál, azonosító
 * nélkül megy el: az oldalletöltés akkor is megtörtént.
 */
let pending = null

function flushPending () {
  if (!pending) return
  const { route } = pending
  clearTimeout(pending.timer)
  pending = null
  send(route)
}

/**
 * Egy oldalletöltés.
 *
 * @param {string} route     az alkalmazás útvonala, például `/anime/:id`
 * @param {string} [entityId] a cím katalógus-azonosítója (uuid), ha ismert
 */
export function pageView (route, entityId) {
  flushPending()
  send(route, entityId)
}

/**
 * Egy címhez tartozó oldal, aminek az azonosítóját a lap fogja feloldani.
 *
 * @param {string} route
 */
export function pendingView (route) {
  flushPending()
  pending = { route, timer: setTimeout(flushPending, 5000) }
}

/**
 * A lap feloldotta a címet: a függő jelzés most megy el, azonosítóval.
 * Függő jelzés nélkül nem csinál semmit — egy uuid-del nyitott lapot a
 * router már jelentett.
 *
 * @param {string} entityId
 */
export function viewEntity (entityId) {
  if (!pending) return
  const { route } = pending
  clearTimeout(pending.timer)
  pending = null
  send(route, entityId)
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
