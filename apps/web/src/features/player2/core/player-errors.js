// A lejátszó hibái — kóddal, és KÉTFÉLE szöveggel.
//
// A mai lejátszó szöveget dobál: `new Error('the stream did not start in time')`.
// Ebből három dolog nem következik, pedig mindháromra szükség van:
//
//   * a VISSZAESÉSI DÖNTÉS — egy időtúllépés után érdemes újrapróbálni, egy
//     nem támogatott formátum után értelmetlen;
//   * a TELEMETRIA — a „hányszor hasalt el forrás időtúllépés miatt" kérdésre
//     szövegek halmazából nem lehet válaszolni;
//   * a FELHASZNÁLÓI ÜZENET — az angol fejlesztői mondat a képernyőn hiba,
//     nem tájékoztatás. A képernyőképen, amiből ez a modul született, szó
//     szerint ez állt: „the stream did not start in time".
//
// Egy adatból három dolog, nem három külön nyilvántartás.

import { T } from '../../../shared/i18n/i18n.js'

/** A taxonómia. A `retryable` mező a visszaesési döntést vezeti. */
export const ERROR_CODES = Object.freeze({
  NO_SOURCE: { retryable: false, message: () => T('There is no source for this episode yet.') },
  SOURCE_TIMEOUT: { retryable: true, message: () => T('The source did not respond.') },
  SOURCE_UNSUPPORTED: { retryable: false, message: () => T('Your browser cannot play this format.') },
  NETWORK_ERROR: { retryable: true, message: () => T('The connection was lost.') },
  MEDIA_ERROR: { retryable: false, message: () => T('The video is damaged or unreadable.') },
  CORS_ERROR: { retryable: false, message: () => T('This source does not allow playback from here.') },
  DRM_ERROR: { retryable: false, message: () => T('This content is protected.') },
  SUBTITLE_ERROR: { retryable: true, message: () => T('The subtitles could not be loaded.') },
  QUALITY_ERROR: { retryable: true, message: () => T('That quality is not available.') },
  // Szándékos megszakítás — a felhasználó nem hibázott, tehát nem is lát semmit.
  ABORTED: { retryable: false, message: () => null },
  UNKNOWN: { retryable: true, message: () => T('Could not play this.') }
})

/**
 * Egy lejátszóhiba.
 *
 * A `detail` FEJLESZTŐKNEK szól és sosem jut a képernyőre. A 43. pont
 * követelménye: hívásverem, belső URL, token és adatbázis-információ nem
 * kerülhet a felhasználó elé — ezért a `toUser()` KIZÁRÓLAG a taxonómia
 * szövegét adja vissza, sosem a `detail`-t.
 */
export class PlayerError extends Error {
  constructor (code, detail = null, cause = null) {
    const known = ERROR_CODES[code] ? code : 'UNKNOWN'
    super(`${known}${detail ? `: ${detail}` : ''}`)
    this.name = 'PlayerError'
    this.code = known
    /** Fejlesztői részlet. SOHA nem megy a felületre. */
    this.detail = detail
    this.cause = cause
    this.at = Date.now()
  }

  /** Érdemes-e másik jelölttel vagy újrapróbálással folytatni. */
  get retryable () { return ERROR_CODES[this.code].retryable }

  /** Amit a néző lát. `null`, ha a hiba nem tartozik rá. */
  toUser () { return ERROR_CODES[this.code].message() }

  /** Amit a telemetria kap. Szabad szöveg nélkül — az azonosíthat. */
  toTelemetry () { return { code: this.code, at: this.at } }
}

/**
 * Egy `HTMLMediaElement.error` lefordítása.
 *
 * A böngésző négy számot ismer, és ezek nem egyformán végzetesek: a
 * `NETWORK` után érdemes másik jelölttel próbálkozni, a `SRC_NOT_SUPPORTED`
 * után ugyanazzal a forrással nem.
 */
export function fromMediaError (mediaError, url = '') {
  if (!mediaError) return new PlayerError('UNKNOWN', 'nincs hibaobjektum')
  switch (mediaError.code) {
    case 1: return new PlayerError('ABORTED', mediaError.message)
    case 2: return new PlayerError('NETWORK_ERROR', mediaError.message)
    case 3: return new PlayerError('MEDIA_ERROR', mediaError.message)
    case 4:
      // A negyedik kód kétértelmű: lehet ismeretlen formátum, de lehet
      // eredetközi tiltás is — a böngésző mindkettőt ide sorolja. A
      // megkülönböztetés a címből jön, mert máshonnan nem tudható.
      return new PlayerError(
        isCrossOrigin(url) ? 'CORS_ERROR' : 'SOURCE_UNSUPPORTED',
        mediaError.message)
    default: return new PlayerError('UNKNOWN', mediaError.message)
  }
}

/** Más eredetű-e a cím. Relatív út sosem az. */
export function isCrossOrigin (url) {
  const value = String(url ?? '')
  if (!value || value.startsWith('/')) return false
  try {
    return new URL(value, globalThis.location?.href ?? 'https://x.invalid').origin !==
      (globalThis.location?.origin ?? 'https://x.invalid')
  } catch {
    return false
  }
}
