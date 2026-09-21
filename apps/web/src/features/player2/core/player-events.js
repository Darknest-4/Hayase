// A lejátszó eseményei — a modulok egyetlen közös nyelve.
//
// MIÉRT BUSZ, ÉS NEM KÖZVETLEN HÍVÁS. A mai lejátszóban a közös nézés a DOM-ot
// írja, a billentyűkezelő a gombokra kattint, a mozdulatkezelő a videóelemet
// állítja. Három út ugyanahhoz a művelethez, három helyen elrontható, és
// egyik sem tud a másikról.
//
// Itt minden szándék ugyanazon a buszon megy át. A közös nézés, a billentyűzet
// és a mozdulat így nem három implementáció, hanem három BEMENET ugyanahhoz az
// úthoz — és egy új bemenet (távoli vezérlés, hangutasítás) semmit nem kíván
// a meglévőktől.

/**
 * Az események. Sztring helyett konstans, mert egy elgépelt `'timeupdae'`
 * csendben soha nem tüzel — és pontosan az ilyen hibát nem lehet kinézni.
 */
export const EV = Object.freeze({
  // életciklus
  INIT: 'player:init',
  READY: 'player:ready',
  DESTROY: 'player:destroy',

  // lejátszás
  PLAY: 'playback:play',
  PAUSE: 'playback:pause',
  TIME_UPDATE: 'playback:time',
  DURATION: 'playback:duration',
  SEEK_START: 'playback:seek-start',
  SEEK: 'playback:seek',
  SEEK_END: 'playback:seek-end',
  RATE_CHANGED: 'playback:rate',
  VOLUME_CHANGED: 'playback:volume',
  ENDED: 'playback:ended',

  // pufferelés
  BUFFERING_START: 'buffer:start',
  BUFFERING_END: 'buffer:end',
  BUFFERED: 'buffer:ranges',

  // források
  SOURCE_SELECTED: 'source:selected',
  SOURCE_FAILED: 'source:failed',
  SOURCE_SWITCHED: 'source:switched',
  SOURCES_EXHAUSTED: 'source:exhausted',

  // sávok
  QUALITY_CHANGED: 'quality:changed',
  SUBTITLE_CHANGED: 'subtitle:changed',
  AUDIO_CHANGED: 'audio:changed',

  // felület
  CONTROLS_SHOW: 'ui:controls-show',
  CONTROLS_HIDE: 'ui:controls-hide',
  FULLSCREEN_ENTER: 'ui:fullscreen-enter',
  FULLSCREEN_EXIT: 'ui:fullscreen-exit',
  PIP_ENTER: 'ui:pip-enter',
  PIP_EXIT: 'ui:pip-exit',
  CINEMA_TOGGLE: 'ui:cinema',
  LOADING_PHASE: 'ui:loading-phase',

  // epizód
  EPISODE_ENDED: 'episode:ended',
  NEXT_EPISODE: 'episode:next',
  SKIP_INTRO: 'episode:skip-intro',
  SKIP_OUTRO: 'episode:skip-outro',

  // haladás
  WATCH_PROGRESS: 'watch:progress',
  WATCH_COMPLETED: 'watch:completed',

  // állapot és hiba
  STATE_CHANGED: 'state:changed',
  ERROR: 'player:error',

  // hálózat
  NETWORK_ONLINE: 'net:online',
  NETWORK_OFFLINE: 'net:offline'
})

/**
 * Egy busz.
 *
 * Szándékosan pár sor: a `EventTarget` böngészőfüggő, a `CustomEvent`
 * csomagolás pedig minden kibocsátásnál egy objektumot allokál. Egy
 * lejátszóban a `TIME_UPDATE` másodpercenként négyszer megy el — ott ez
 * számít.
 */
export function createBus () {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  let destroyed = false

  const on = (event, handler) => {
    if (destroyed || typeof handler !== 'function') return () => {}
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(handler)
    // A leiratkozót VISSZAADJUK, nem csak az `off`-ot kínáljuk. A hívónak így
    // nem kell eltennie a függvényreferenciát ahhoz, hogy takarítani tudjon —
    // és a takarítás elmaradása a szivárgás első számú oka.
    return () => off(event, handler)
  }

  const off = (event, handler) => {
    const set = listeners.get(event)
    if (!set) return
    set.delete(handler)
    if (!set.size) listeners.delete(event)
  }

  const emit = (event, payload) => {
    if (destroyed) return
    const set = listeners.get(event)
    if (!set) return
    // Másolat: egy figyelő leiratkozhat kibocsátás közben (a `once` pont ezt
    // teszi), és a halmaz módosítása iteráció alatt figyelőket hagyna ki.
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch (error) {
        // EGY FIGYELŐ HIBÁJA NEM VIHETI MAGÁVAL A TÖBBIT. Egy elhasalt
        // felirat-frissítés nem állíthatja meg a haladásmérést.
        console.error(`[player] a(z) ${event} figyelője hibázott:`, error)
      }
    }
  }

  const once = (event, handler) => {
    const wrapped = payload => { off(event, wrapped); handler(payload) }
    return on(event, wrapped)
  }

  const destroy = () => {
    destroyed = true
    listeners.clear()
  }

  return {
    on,
    off,
    once,
    emit,
    destroy,
    /** Teszthez és hibakereséshez: hány figyelő van, eseményenként. */
    stats: () => Object.fromEntries([...listeners].map(([k, v]) => [k, v.size]))
  }
}
