// A forráskezelő: melyik jelölttel próbálkozunk, és mi legyen, ha elhasal.
//
// A mai motor ezt jól csinálja — a néző csak akkor lát hibát, ha minden
// jelölt elfogyott —, de szövegekkel dolgozik, és nem tartja nyilván, MI
// történt melyik forrással. Ebből három dolog nem következik:
//
//   * a visszaesési döntés (egy időtúllépést érdemes újrapróbálni, egy nem
//     támogatott formátumot nem),
//   * a telemetria („hányszor hasalt el időtúllépés miatt"),
//   * és az, hogy a felhasználó egy EMBERI mondatot lásson, ne egy angol
//     fejlesztői üzenetet a képernyő közepén.
//
// Itt minden jelölt állapotgépben ül, és minden bukás strukturált okot kap.

import { EV } from '../core/player-events.js'
import { PlayerError } from '../core/player-errors.js'
import { engineFor } from './engines.js'
import { normalise, rank } from './source-ranking.js'

/** A jelölt állapotai. Lásd az architektúra-dokumentum állapotgépét. */
export const SOURCE_STATE = Object.freeze({
  UNKNOWN: 'unknown',
  CHECKING: 'checking',
  READY: 'ready',
  PLAYING: 'playing',
  FAILED: 'failed',
  DISABLED: 'disabled'
})

/** Jelöltenként ennyiszer próbálkozunk, mielőtt letiltjuk. */
export const MAX_ATTEMPTS = 2

/**
 * @param {object} player a `createPlayer` példánya
 * @param {object} options `prefs`, `timeoutMs`, `maxAttempts`
 */
export function createSourceManager (player, options = {}) {
  const { bus, state } = player
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  /** @type {Array<{candidate: object, state: string, attempts: number, failure: object|null}>} */
  let entries = []
  let active = null
  let detach = null
  let aborted = false

  /** A fa `source` szeletének frissítése. Az UI ebből olvas. */
  const publish = () => {
    state.patch({
      source: {
        current: active?.candidate ?? null,
        type: active?.candidate?.kind ?? null,
        candidates: entries.map(e => ({
          id: e.candidate.id,
          title: e.candidate.title,
          quality: e.candidate.quality,
          state: e.state,
          failure: e.failure
        }))
      }
    })
  }

  /** Nyers rekordok betöltése, normalizálva és rangsorolva. */
  const load = (rawCandidates = [], prefs = options.prefs ?? {}) => {
    entries = rawCandidates
      .map(raw => normalise(raw, raw.source ?? {}))
      .filter(Boolean)
      .map(candidate => ({ candidate, state: SOURCE_STATE.UNKNOWN, attempts: 0, failure: null }))

    // A rangsor a JELÖLTEKEN dolgozik, de a bejegyzéseket rendezzük vele —
    // így az állapot és a sorrend egy helyen marad.
    const ordered = rank(entries.map(e => e.candidate), prefs)
    entries = ordered.map(candidate => entries.find(e => e.candidate === candidate))
    publish()
    return entries.length
  }

  /**
   * A soron következő jelölt.
   *
   * ELŐBB MINDENKI KAP EGY ESÉLYT, és csak utána jön az ismétlés. Ez nem
   * részletkérdés: ha egy újrapróbálható hiba (hálózati zavar) után azonnal
   * ugyanazt próbálnánk újra, a néző kétszer várná ki ugyanazt az
   * időtúllépést, mielőtt egy MÁSIK, esetleg tökéletesen működő forráshoz
   * eljutna. Mérve egy tizenkét másodperces határidővel ez huszonnégy
   * másodperc fekete képernyő egy helyett.
   *
   * A második kör azoké, akik átmeneti hibán buktak el — azóta változhatott a
   * hálózat. Amit a `tryEntry` letiltott (nem támogatott formátum, sérült
   * média), az nem kerül vissza: ott az ismétlésnek nincs értelme.
   */
  const nextEntry = () => {
    const eligible = e => e.state !== SOURCE_STATE.DISABLED && e.state !== SOURCE_STATE.PLAYING
    return entries.find(e => eligible(e) && e.attempts === 0) ??
      entries.find(e => eligible(e) && e.attempts < maxAttempts)
  }

  /** Egy jelölt kipróbálása. Hibát nem dob: a bukás adat, nem kivétel. */
  const tryEntry = async (entry) => {
    const engine = engineFor(entry.candidate)
    if (!engine) {
      entry.state = SOURCE_STATE.DISABLED
      entry.failure = { code: 'SOURCE_UNSUPPORTED', attempts: entry.attempts, at: Date.now() }
      return false
    }

    entry.state = SOURCE_STATE.CHECKING
    entry.attempts++
    active = entry
    publish()
    bus.emit(EV.SOURCE_SELECTED, entry.candidate)

    try {
      detach = await engine.attach(player.video, entry.candidate, { timeoutMs: options.timeoutMs })
      if (aborted) { try { detach?.() } catch { /* lebontás */ } return false }
      entry.state = SOURCE_STATE.PLAYING
      entry.failure = null
      publish()
      return true
    } catch (error) {
      const err = error instanceof PlayerError ? error : new PlayerError('UNKNOWN', String(error?.message ?? error))
      // STRUKTURÁLT OK, nem szöveg: ebből lesz a döntés, a telemetria és az
      // üzenet — három dolog egy adatból.
      entry.failure = { code: err.code, attempts: entry.attempts, at: err.at }
      // Ha a hiba nem újrapróbálható (nem támogatott formátum, sérült média),
      // ezt a jelöltet végleg elengedjük. Enélkül `maxAttempts`-szer futnánk
      // bele ugyanabba a falba.
      entry.state = (!err.retryable || entry.attempts >= maxAttempts)
        ? SOURCE_STATE.DISABLED
        : SOURCE_STATE.FAILED
      publish()
      bus.emit(EV.SOURCE_FAILED, { candidate: entry.candidate, error: err })
      return false
    }
  }

  /**
   * Végigmegy a jelölteken, amíg egyik el nem indul.
   *
   * NINCS VÉGTELEN HUROK: minden kör vagy elindít valamit, vagy csökkenti a
   * megpróbálható jelöltek számát, mert a `tryEntry` mindig növeli az
   * `attempts`-et, és a `nextEntry` a `maxAttempts` alatt válogat.
   */
  const start = async () => {
    aborted = false
    if (!entries.length) {
      const err = new PlayerError('NO_SOURCE')
      bus.emit(EV.SOURCES_EXHAUSTED, err)
      return { ok: false, error: err }
    }

    let entry
    while ((entry = nextEntry())) {
      if (aborted) return { ok: false, error: new PlayerError('ABORTED') }
      const previous = active
      if (await tryEntry(entry)) {
        if (previous && previous !== entry) bus.emit(EV.SOURCE_SWITCHED, entry.candidate)
        return { ok: true, candidate: entry.candidate }
      }
    }

    // Minden jelölt elfogyott. A felhasználónak az UTOLSÓ kísérlet oka jár,
    // nem egy általános „nem sikerült" — abból nem derül ki, mit tegyen.
    const last = [...entries].reverse().find(e => e.failure)
    const err = new PlayerError(last?.failure?.code ?? 'NO_SOURCE')
    bus.emit(EV.SOURCES_EXHAUSTED, err)
    return { ok: false, error: err }
  }

  /** Váltás egy megnevezett jelöltre (a forrásmenüből). */
  const switchTo = async (candidateId) => {
    const entry = entries.find(e => e.candidate.id === candidateId)
    if (!entry) return { ok: false, error: new PlayerError('NO_SOURCE', 'ismeretlen jelölt') }
    try { detach?.() } catch { /* lebontás */ }
    detach = null
    // A kézi választás ÚJ ESÉLYT ad: a néző szándéka fölülírja a korábbi
    // bukást, mert azóta változhatott a hálózat.
    entry.attempts = 0
    entry.state = SOURCE_STATE.UNKNOWN
    if (active && active !== entry) active.state = SOURCE_STATE.READY
    const ok = await tryEntry(entry)
    if (ok) bus.emit(EV.SOURCE_SWITCHED, entry.candidate)
    return ok ? { ok: true, candidate: entry.candidate } : { ok: false, error: new PlayerError(entry.failure?.code ?? 'UNKNOWN') }
  }

  const stop = () => {
    aborted = true
    try { detach?.() } catch { /* lebontás */ }
    detach = null
    active = null
  }

  player.own(stop)

  return {
    load,
    start,
    switchTo,
    stop,
    get active () { return active?.candidate ?? null },
    get entries () { return entries.map(e => ({ ...e })) },
    SOURCE_STATE
  }
}
