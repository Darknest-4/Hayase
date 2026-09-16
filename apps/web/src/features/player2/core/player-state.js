// A lejátszó EGYETLEN állapota.
//
// MIÉRT EGY. Ma a „megy-e a videó" kérdésre három hely tud válaszolni: a
// `video.paused`, a `shell.classList`, és a közös nézés saját nyilvántartása.
// Három igazság, ami eltérhet — és el is tér, amikor a közös nézés szüneteltet,
// a `classList` meg nem tud róla.
//
// Itt egy fa van. Aki tudni akarja, mi történik, ONNAN olvassa; aki
// megváltoztatja, ODA írja; és minden változás ugyanazon a buszon jelenik meg.

import { EV } from './player-events.js'

/** A kiinduló állapot. A mezők a `PLAYER_2_ARCHITECTURE.md` fája szerint. */
export function initialState () {
  return {
    status: 'idle',
    playback: {
      playing: false, currentTime: 0, duration: 0, buffered: 0,
      volume: 1, muted: false, rate: 1, seeking: false
    },
    source: { current: null, candidates: [], type: null },
    quality: { current: 'auto', available: [], auto: true },
    subtitles: { enabled: false, current: null, tracks: [] },
    audio: { current: null, tracks: [] },
    episode: { current: null, next: null, previous: null },
    ui: {
      controlsVisible: true, fullscreen: false, pip: false,
      cinema: false, ambient: false, miniPlayer: false,
      loadingPhase: 'INITIALIZING',
      // Az éppen felajánlható átugrás, vagy `null`. A mezőnek ITT a helye, és
      // nem csak akkor kell léteznie, amikor van mit ajánlani: egy
      // `undefined` mezőre feliratkozó felület nem tudja megkülönböztetni a
      // „nincs átugrás"-t attól, hogy „még nem kérdeztük meg".
      skipSegment: null,
      /** Közös nézés szobájában vagyunk-e. A felület ebből tudja a jelvényt. */
      party: false
    },
    network: { online: true },
    error: null
  }
}

/**
 * A lejátszó betöltési fázisai.
 *
 * Nem ugyanaz, mint a `status`: a `status` azt mondja meg, MI a lejátszó
 * helyzete, ez pedig azt, MIT LÁT a néző a betöltőképernyőn. A kettő
 * szétválasztása azért kell, mert egy forrásváltás közben a lejátszó
 * `playing` marad (a néző szerint megy a film), miközben a betöltő
 * `SWITCHING_SOURCE`-t mutat.
 */
export const LOADING_PHASE = Object.freeze({
  INITIALIZING: 'INITIALIZING',
  LOADING_SOURCE: 'LOADING_SOURCE',
  LOADING_METADATA: 'LOADING_METADATA',
  BUFFERING: 'BUFFERING',
  SWITCHING_SOURCE: 'SWITCHING_SOURCE',
  READY: 'READY'
})

/** Sekély összeolvasztás névterenként. Egy szint mély — mélyebbre nincs szükség. */
function merge (current, patch) {
  const next = { ...current }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        current[key] && typeof current[key] === 'object' && !Array.isArray(current[key])) {
      const slice = { ...current[key], ...value }
      // Referencia-összehasonlítás nem elég: a `{...a, ...b}` mindig új objektum.
      // Mezőnként nézzük, különben minden `patch` változásnak látszana, és az
      // UI másodpercenként négyszer rajzolna újra a semmiért.
      if (Object.keys(value).some(k => current[key][k] !== value[k])) {
        next[key] = slice
        changed = true
      }
    } else if (current[key] !== value) {
      next[key] = value
      changed = true
    }
  }
  return changed ? next : current
}

/**
 * Az állapottároló.
 *
 * @param {ReturnType<import('./player-events.js').createBus>} bus
 */
export function createState (bus) {
  let state = initialState()
  const subscribers = new Set()
  let destroyed = false

  const get = () => state

  /**
   * Változtatás. Csak akkor értesít, ha TÉNYLEGESEN változott valami.
   *
   * Ez nem optimalizálás, hanem helyesség: a `timeupdate` másodpercenként
   * négyszer jön, és a benne lévő `currentTime` néha ugyanaz. Ha minden
   * `patch` értesítene, a felirat-, a haladás- és a vezérlőréteg is
   * újrarajzolna olyankor is, amikor semmi nem történt.
   */
  const patch = (changes) => {
    if (destroyed) return state
    const next = merge(state, changes)
    if (next === state) return state
    const previous = state
    state = next
    for (const fn of [...subscribers]) {
      try { fn(state, previous) } catch (error) { console.error('[player] állapot-figyelő hibázott:', error) }
    }
    bus?.emit(EV.STATE_CHANGED, state)
    return state
  }

  const subscribe = (fn) => {
    if (destroyed || typeof fn !== 'function') return () => {}
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  /**
   * Feliratkozás a fa EGY SZELETÉRE.
   *
   * A legtöbb UI-elem egyetlen mezőre figyel — a hangerőgomb a
   * `playback.volume`-ra. Enélkül minden elem minden változásnál lefutna, és
   * maga szűrne; ez a szűrés egy helyen, jól van megírva.
   */
  const select = (selector, fn) => subscribe((next, previous) => {
    const a = selector(next)
    const b = selector(previous)
    if (a !== b) fn(a, b)
  })

  const destroy = () => {
    destroyed = true
    subscribers.clear()
    state = { ...initialState(), status: 'destroyed' }
  }

  return { get, patch, subscribe, select, destroy, get destroyed () { return destroyed } }
}
