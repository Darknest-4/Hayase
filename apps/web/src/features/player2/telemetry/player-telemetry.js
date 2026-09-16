// Telemetria.
//
// KÉT SZABÁLY, és mindkettő korlátozás:
//
//   * NE KÜLDJ ÉRZÉKENY ADATOT. Nem megy ki forráscím (az tartalmazhat
//     aláírt tokent a lekérdezésben), nem megy ki hibaszöveg (az
//     tartalmazhat belső utat), és nem megy ki semmi szabad szöveg — az
//     azonosíthat;
//   * NE LEGYEN ÖZÖN. Egy `timeupdate`-re kötött esemény egy részen
//     negyvenezer sor. Ami itt van, az vagy egyszer sül el részenként, vagy
//     ritka.
//
// A KÜLDÉS A HÍVÓ DOLGA. Ez a modul összegyűjt és alakot ad; hogy hova megy,
// azt a nézőoldal dönti el — így tesztelhető is anélkül, hogy bárhova
// kimenne bármi.

import { EV } from '../core/player-events.js'

/** Az események, amiket küldünk. Zárt lista: ami nincs benne, az nem megy ki. */
export const TELEMETRY_EVENTS = Object.freeze([
  'player_started', 'player_ready', 'first_frame',
  'buffer_start', 'buffer_end',
  'source_failed', 'source_switched',
  'quality_changed', 'subtitle_changed',
  'episode_completed'
])

/** Ennél sűrűbben ugyanaz az esemény nem megy ki. */
export const THROTTLE_MS = 1000

/**
 * Egy adatcsomag megtisztítása.
 *
 * Fehérlistás: csak a felsorolt mezők mennek ki, és azok is csak számként
 * vagy rövid, felsorolt szövegként. Egy feketelista előbb-utóbb kihagy
 * valamit — egy fehérlista nem tud.
 */
export function sanitise (payload = {}) {
  const out = {}
  const numbers = ['ms', 'position', 'duration', 'quality', 'attempt', 'count', 'ratio', 'watchedSec']
  for (const key of numbers) {
    const value = Number(payload[key])
    if (Number.isFinite(value)) out[key] = Math.round(value * 100) / 100
  }
  // Rövid, gépi azonosítók. A hossz korlátozása nem esztétika: egy
  // kódnak kiadott mező, amibe valaki szabad szöveget tesz, így sem lesz
  // hosszabb, mint egy kód.
  for (const key of ['code', 'kind', 'language', 'sourceType', 'reason']) {
    const value = payload[key]
    if (typeof value === 'string' && value && value.length <= 40) out[key] = value
  }
  if (typeof payload.auto === 'boolean') out.auto = payload.auto
  return out
}

/**
 * @param {object} player
 * @param {object} options `send(event, payload)`, `now`
 */
export function createTelemetry (player, options = {}) {
  const { video, bus, state } = player
  const send = typeof options.send === 'function' ? options.send : null
  const now = options.now ?? (() => Date.now())
  const lastSent = new Map()
  let startedAt = null
  let firstFrameSent = false

  const emit = (event, payload = {}) => {
    if (!send || !TELEMETRY_EVENTS.includes(event)) return false
    const previous = lastSent.get(event) ?? -Infinity
    const at = now()
    // A FOJTÁS eseményenként külön. A pufferelés lehet sűrű, a
    // minőségváltás nem — egy közös fojtás az egyiket elnyelné a másik miatt.
    if (at - previous < THROTTLE_MS) return false
    lastSent.set(event, at)
    try { send(event, sanitise(payload)) } catch { /* a telemetria nem áll meg semmit */ }
    return true
  }

  player.own(bus.on(EV.SOURCE_SELECTED, (candidate) => {
    startedAt ??= now()
    emit('player_started', { sourceType: candidate?.type, quality: candidate?.quality })
  }))

  player.own(bus.on(EV.SOURCE_FAILED, (entry) => {
    // A HIBAKÓD megy ki, a hibaszöveg NEM: az tartalmazhat belső címet.
    emit('source_failed', { code: entry?.failure?.code ?? entry?.code, attempt: entry?.attempts })
  }))
  player.own(bus.on(EV.SOURCE_SWITCHED, (candidate) => {
    emit('source_switched', { sourceType: candidate?.type, quality: candidate?.quality })
  }))

  player.listen(video, 'loadeddata', () => {
    if (firstFrameSent) return
    firstFrameSent = true
    emit('first_frame', { ms: startedAt ? now() - startedAt : null })
  })
  player.own(bus.on(EV.READY, () => emit('player_ready', { ms: startedAt ? now() - startedAt : null })))

  player.own(bus.on(EV.BUFFERING_START, () => emit('buffer_start', { position: video.currentTime })))
  player.own(bus.on(EV.BUFFERING_END, () => emit('buffer_end', { position: video.currentTime })))

  player.own(bus.on(EV.QUALITY_CHANGED, (quality) => emit('quality_changed', {
    quality: Number(quality), auto: state.get().quality.auto
  })))
  player.own(bus.on(EV.SUBTITLE_CHANGED, (track) => emit('subtitle_changed', {
    language: track?.language ?? track?.lang
  })))

  player.own(bus.on(EV.WATCH_COMPLETED, (info) => emit('episode_completed', {
    watchedSec: info?.watchedSec, ratio: info?.ratio, duration: video.duration
  })))

  return {
    emit,
    sanitise,
    get enabled () { return Boolean(send) },
    /** Teszthez és a fejlesztői réteghez: mikor ment ki utoljára mi. */
    get lastSent () { return new Map(lastSent) }
  }
}
