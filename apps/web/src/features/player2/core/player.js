// A lejátszó életciklusa.
//
// Ez a modul köti össze a rétegeket, és ez a modul FELEL A TAKARÍTÁSÉRT.
//
// A mai lejátszó `document`-re tesz billentyűkezelőt, `setTimeout`-ot indít az
// automatikus elrejtéshez, és `setInterval`-t a haladásmentéshez — de sehol
// nincs egy pont, ami mindet elbontja. Egy oldalváltás után a régi lejátszó
// billentyűkezelője továbbra is ott figyel, és a szóköz megállít egy videót,
// ami már nincs a képernyőn.
//
// Itt minden eldobható dolog EGY nyilvántartásba kerül, és a `destroy()`
// végigmegy rajta. Ha egy modul nem adja vissza a takarítóját, az a modul
// hibája, nem egy elfelejtett `removeEventListener`.

import { createBus, EV } from './player-events.js'
import { createState, LOADING_PHASE } from './player-state.js'
import { PlayerError } from './player-errors.js'

/**
 * Egy lejátszópéldány.
 *
 * A `video` elem KÍVÜLRŐL érkezik, nem itt készül. Így a lejátszó tesztelhető
 * egy csonkkal, és a hívó dönti el, hova kerül az elem a DOM-ban — a mag
 * továbbra sem tud az elrendezésről.
 */
export function createPlayer ({ video, logger = console } = {}) {
  if (!video) throw new PlayerError('UNKNOWN', 'createPlayer: hiányzó videóelem')

  const bus = createBus()
  const state = createState(bus)

  /** Amit le kell bontani. Függvények, mind idempotens. */
  const teardowns = new Set()
  let destroyed = false

  /**
   * Bejegyzés a takarítandók közé.
   *
   * Minden erőforrás-foglalás ezen megy át — figyelő, időzítő, motor,
   * UI-modul. Aki nem ezen át foglal, az szivárog.
   */
  const own = (teardown) => {
    if (typeof teardown !== 'function') return () => {}
    if (destroyed) { teardown(); return () => {} }
    teardowns.add(teardown)
    return () => { teardowns.delete(teardown); teardown() }
  }

  /** Figyelő egy DOM-elemen, automatikus takarítással. */
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options)
    return own(() => target.removeEventListener(type, handler, options))
  }

  /** Időzítő, automatikus takarítással. */
  const timer = (fn, ms) => {
    const id = setTimeout(fn, ms)
    return own(() => clearTimeout(id))
  }

  /** Ismétlődő időzítő, automatikus takarítással. */
  const interval = (fn, ms) => {
    const id = setInterval(fn, ms)
    return own(() => clearInterval(id))
  }

  const fail = (error) => {
    const err = error instanceof PlayerError ? error : new PlayerError('UNKNOWN', String(error?.message ?? error))
    // A FEJLESZTŐI RÉSZLET a naplóba megy, a FELHASZNÁLÓI az állapotba.
    // A kettő nem keveredhet: a `detail` belső URL-t és hívásvermet is
    // tartalmazhat, és annak a képernyőn nincs helye.
    logger.error('[player]', err.code, err.detail ?? '')
    state.patch({ status: 'error', error: { code: err.code, detail: err.toUser() } })
    bus.emit(EV.ERROR, err)
    return err
  }

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    bus.emit(EV.DESTROY)
    // FORDÍTOTT SORRENDBEN. Ami utoljára foglalt, az függhet a korábbiaktól;
    // a motor például a videóelem figyelőire épül.
    for (const teardown of [...teardowns].reverse()) {
      try { teardown() } catch (error) { logger.error('[player] takarítás hibázott:', error) }
    }
    teardowns.clear()
    state.destroy()
    bus.destroy()
  }

  const player = {
    video,
    bus,
    state,
    own,
    listen,
    timer,
    interval,
    fail,
    destroy,
    get destroyed () { return destroyed },
    /** Teszthez: hány el nem bontott erőforrás van. */
    get owned () { return teardowns.size },

    /** A betöltőképernyő fázisa — az UI ebből tudja, mit írjon ki. */
    setPhase (phase) {
      if (!LOADING_PHASE[phase]) return
      state.patch({ ui: { loadingPhase: phase } })
      bus.emit(EV.LOADING_PHASE, phase)
    }
  }

  state.patch({ status: 'initializing' })
  bus.emit(EV.INIT, player)
  return player
}
