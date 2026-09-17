// Érintéses gesztusok.
//
// Négy gesztus, és mindegyiknél az a nehéz rész, hogy MIT NEM szabad annak
// venni:
//
//   * KOPPINTÁS — vezérlők be/ki. Nem koppintás, ha közben elmozdult az ujj;
//     az görgetés volt;
//   * DUPLA KOPPINTÁS a széleken — tekerés. Nem dupla, ha túl lassú volt, és
//     nem a széleken van a közép;
//   * FÜGGŐLEGES CSÚSZTATÁS — hangerő jobbra, fényerő balra. Nem az, ha
//     inkább vízszintes volt;
//   * VÍZSZINTES CSÚSZTATÁS — tekerés előnézettel.
//
// A felismerés DOM-mentes: koordinátákat és időpontokat kap, gesztusnevet ad.

/** Ennyi képpontnál kisebb elmozdulás még koppintás, nem csúsztatás. */
export const TAP_SLOP_PX = 12
/** Két koppintás ezen belül dupla koppintás. */
export const DOUBLE_TAP_MS = 320
/** Csúsztatásnak ennyit kell mennie, hogy irányt válasszunk. */
export const SWIPE_THRESHOLD_PX = 24
/** A szélső sáv szélessége arányban — ekkora rész a „dupla koppintás oldala". */
export const EDGE_ZONE = 0.35

/**
 * Egy befejezett érintésből gesztus.
 *
 * @param {object} touch `{ startX, startY, endX, endY, startedAt, endedAt, width, height }`
 * @param {object} previous az előző koppintás (`{ x, at }`), vagy `null`
 * @returns {{type: string, side?: string, axis?: string, delta?: number}|null}
 */
export function gestureFor (touch, previous = null) {
  const dx = (touch.endX ?? touch.startX) - touch.startX
  const dy = (touch.endY ?? touch.startY) - touch.startY
  const distance = Math.hypot(dx, dy)
  const elapsed = (touch.endedAt ?? touch.startedAt) - touch.startedAt

  if (distance >= SWIPE_THRESHOLD_PX) {
    // Az ELMOZDULÁS NAGYOBB TENGELYE dönt, nem a szög: aki tekerni akar, az
    // vízszintesen indul, és a közben belecsúszó függőleges összetevő nem
    // változtathatja hangerőre félúton.
    if (Math.abs(dx) > Math.abs(dy)) return { type: 'swipe', axis: 'x', delta: dx }
    const side = touch.startX < (touch.width ?? 0) / 2 ? 'left' : 'right'
    return { type: 'swipe', axis: 'y', delta: -dy, side }
  }

  if (distance > TAP_SLOP_PX) return null // görgetés volt, nem koppintás

  const width = touch.width ?? 0
  const zone = width * EDGE_ZONE
  const side = touch.startX < zone ? 'left' : touch.startX > width - zone ? 'right' : 'center'

  // A második koppintásnak KÖZEL kell lennie az elsőhöz. Enélkül a bal
  // szélen tekerés után a jobb szélre koppintás is „dupla" lenne, és
  // visszatekerne — pedig a néző előre akart menni.
  if (previous && touch.startedAt - previous.at <= DOUBLE_TAP_MS &&
      Math.abs(touch.startX - previous.x) <= width * 0.25) {
    // A `side` a hívó dolga: a KÖZÉPEN a bevett jelentés a teljes képernyő, a
    // széleken a tekerés. Itt csak megmondjuk, hol történt.
    return { type: 'double-tap', side }
  }

  // A hosszú nyomás nem koppintás: azon a gyorsítás ül.
  if (elapsed > 500) return { type: 'long-press', side }

  return { type: 'tap', side }
}

/**
 * A gesztusok rákötése egy elemre.
 *
 * A `handlers`: `tap`, `doubleTap(side)`, `swipe({axis, delta, side})`,
 * `longPressStart`, `longPressEnd`.
 */
export function attachGestures (player, surface, handlers = {}) {
  let start = null
  let lastTap = null
  let longPressTimer = null
  let longPressFired = false

  const clearLongPress = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
  }

  player.listen(surface, 'touchstart', (event) => {
    const point = event.touches?.[0]
    if (!point) return
    const rect = typeof surface.getBoundingClientRect === 'function'
      ? surface.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 }
    start = {
      startX: point.clientX - rect.left,
      startY: point.clientY - rect.top,
      // A képernyőkoordináta is kell: a `touchmove` a MOZGÁST méri, és azt
      // két képernyőpont különbségéből kapjuk. Az elemhez viszonyított és a
      // képernyőhöz viszonyított koordináta összekeverése itt egy egész
      // elemszélességnyi hibát adott, és minden mozdulat „csúsztatás" lett.
      clientX: point.clientX,
      clientY: point.clientY,
      startedAt: Date.now(),
      width: rect.width,
      height: rect.height
    }
    longPressFired = false
    if (typeof handlers.longPressStart === 'function') {
      longPressTimer = setTimeout(() => { longPressFired = true; handlers.longPressStart() }, 500)
    }
  }, { passive: true })

  player.listen(surface, 'touchmove', (event) => {
    if (!start) return
    const point = event.touches?.[0]
    if (!point) return
    // Amint elmozdult, a hosszú nyomás lekerül az asztalról.
    if (Math.hypot(point.clientX - start.clientX, point.clientY - start.clientY) > TAP_SLOP_PX) clearLongPress()
  }, { passive: true })

  player.listen(surface, 'touchend', (event) => {
    if (!start) return
    clearLongPress()
    if (longPressFired) {
      handlers.longPressEnd?.()
      start = null
      return
    }
    const point = event.changedTouches?.[0]
    const rect = typeof surface.getBoundingClientRect === 'function'
      ? surface.getBoundingClientRect()
      : { left: 0, top: 0, width: start.width, height: start.height }
    const gesture = gestureFor({
      ...start,
      endX: point ? point.clientX - rect.left : start.startX,
      endY: point ? point.clientY - rect.top : start.startY,
      endedAt: Date.now()
    }, lastTap)

    if (gesture?.type === 'tap') {
      lastTap = { x: start.startX, at: start.startedAt }
      handlers.tap?.(gesture.side)
    } else if (gesture?.type === 'double-tap') {
      lastTap = null // a harmadik koppintás ne legyen megint „dupla"
      handlers.doubleTap?.(gesture.side)
    } else if (gesture?.type === 'swipe') {
      lastTap = null
      handlers.swipe?.(gesture)
    }
    start = null
  })

  return () => { clearLongPress(); start = null }
}
