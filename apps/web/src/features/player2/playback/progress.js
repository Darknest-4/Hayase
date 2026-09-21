// Haladás és MÉRT nézési idő.
//
// A különbség a kettő közt nem szóhasználat. A YUME-ban öt képernyő számolta
// ugyanígy a nézett időt:
//
//     entries.reduce((s, e) => s + (e.progress ?? 0) * (e.media?.duration || 24), 0)
//
// — megjelölt epizódok száma szorozva egy névleges hosszal, 24 perces
// tartalékkal. Ez BECSLÉS, mérésnek álcázva: abban a pillanatban, amikor egy
// epizód megjelölődik, a profil kap egy lapos 24 percet, akkor is, ha a néző
// két percet látott belőle.
//
// Itt a ténylegesen LEJÁTSZOTT másodperceket adjuk össze. A különbség
// nemcsak pontosabb — más is: tekeréssel nem lehet megnövelni.

import { EV } from '../core/player-events.js'

/** Ennyi nézett hányad fölött számít az epizód végignézettnek. */
export const COMPLETION_RATIO = 0.9
/** Ennyi másodpercenként mentünk pozíciót. */
export const SAVE_INTERVAL_MS = 5_000
/** Ennyi másodpercnél rövidebb nézés nem érdemel mentést. */
export const MIN_MEANINGFUL_SEC = 3

/**
 * @param {object} player
 * @param {object} options `store` ({get,set}), `onProgress`, `onCompleted`
 */
export function createProgressTracker (player, options = {}) {
  const { video, bus, state } = player
  const onProgress = options.onProgress ?? (() => {})
  const onCompleted = options.onCompleted ?? (() => {})

  /** A TÉNYLEGESEN lejátszott másodpercek. Nem a pozíció. */
  let watchedSec = 0
  let lastTick = null
  let completed = false
  let lastSavedAt = 0

  /**
   * Az óra csak akkor jár, ha a videó TÉNYLEGESEN megy.
   *
   * Ez a lényeg. A `timeupdate` tekerésnél is tüzel, és a `currentTime`
   * ugrása ilyenkor nem nézett idő. Ezért nem a pozíció különbségét adjuk
   * hozzá, hanem a VALÓS ELTELT IDŐT két tick között — az nem ugrik attól,
   * hogy valaki a csúszkát a végére húzza.
   */
  const tick = () => {
    const now = Date.now()
    if (lastTick !== null && !video.paused && !video.seeking) {
      const elapsed = (now - lastTick) / 1000
      // A gyanúsan hosszú szünet (fül a háttérben, alvó gép) nem nézés: a
      // `timeupdate` ilyenkor perceket ugorhat. Egy tick legfeljebb két
      // másodpercet érhet — négyszeres ráhagyás a szokásos 250 ms-hoz.
      if (elapsed > 0 && elapsed < 2) watchedSec += elapsed * (video.playbackRate || 1)
    }
    lastTick = now
  }

  const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0)

  /** A nézett hányad — a MÉRT időből, nem a pozícióból. */
  const ratio = () => {
    const total = duration()
    return total ? Math.min(1, watchedSec / total) : 0
  }

  const save = (force = false) => {
    const now = Date.now()
    if (!force && now - lastSavedAt < SAVE_INTERVAL_MS) return
    if (watchedSec < MIN_MEANINGFUL_SEC && !force) return
    lastSavedAt = now
    const payload = {
      positionSec: video.currentTime || 0,
      durationSec: duration(),
      watchedSec,
      ratio: ratio()
    }
    state.patch({ playback: { currentTime: payload.positionSec } })
    bus.emit(EV.WATCH_PROGRESS, payload)
    try { onProgress(payload) } catch (error) { console.error('[player] haladásmentés hibázott:', error) }
  }

  const checkCompletion = () => {
    if (completed || ratio() < COMPLETION_RATIO) return
    completed = true
    bus.emit(EV.WATCH_COMPLETED, { watchedSec, ratio: ratio() })
    try { onCompleted({ watchedSec, ratio: ratio() }) } catch (error) { console.error('[player] megtekintettség hibázott:', error) }
  }

  player.listen(video, 'timeupdate', () => { tick(); save(); checkCompletion() })
  player.listen(video, 'pause', () => { tick(); save(true) })
  player.listen(video, 'play', () => { lastTick = Date.now() })
  player.listen(video, 'seeking', () => { lastTick = null })
  // A lap bezárása: az utolsó pozíció még menjen ki. A `pagehide` megbízhatóbb
  // a `beforeunload`-nál, és mobilon az az egyetlen, ami tényleg lefut.
  if (globalThis.addEventListener) {
    player.listen(globalThis, 'pagehide', () => save(true))
  }

  return {
    save,
    get watchedSec () { return watchedSec },
    get ratio () { return ratio() },
    get completed () { return completed },
    /** Visszatöltés: egy korábbi menet mért ideje folytatódik, nem nullázódik. */
    restore (seconds = 0) { watchedSec = Math.max(0, Number(seconds) || 0) }
  }
}
