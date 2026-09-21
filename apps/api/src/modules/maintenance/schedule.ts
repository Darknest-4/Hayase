// Ütemezés — időbélyegből állapot.
//
// A 9. pont kifejezetten kéri, hogy a futásidejű döntés NE FÜGGJÖN A
// WORKERTŐL. Ennek az oka egyszerű: ha egy háttérfeladat kapcsolja be a
// karbantartást, akkor egy leállt worker azt jelenti, hogy a beütemezett
// karbantartás nem indul el — és az üzemeltető egy elindított migráció
// közepén veszi észre, hogy az oldal még fogad írásokat.
//
// Itt ezért az IDŐBÉLYEG DÖNT, minden egyes kérésnél, a gyorsítótárból
// olvasott konfigurációból. A worker csak értesít és takarít.
//
// ---------------------------------------------------------------------------
// A NYÁRI IDŐSZÁMÍTÁS KÉRDÉSE, ELŐRE ELDÖNTVE
//
// A 9. pont kéri a helyes időzóna- és DST-kezelést. A megoldás nem az, hogy
// okosabb átváltást írunk, hanem hogy NINCS MIT ÁTVÁLTANI:
//
//   * a `starts_at` és az `ends_at` ABSZOLÚT IDŐPILLANAT (`timestamptz`),
//     nem „helyi idő plusz zóna". Két pillanat összehasonlítása egyértelmű,
//     és nem érdekli a nyári időszámítás;
//   * az `timezone` mező KIZÁRÓLAG MEGJELENÍTÉSRE való: abban a zónában írjuk
//     ki az adminnak és a látogatónak, mikor lesz vége.
//
// Az a hiba, amit ez kizár: „hajnali kettőkor" beütemezett karbantartás egy
// olyan éjszakán, amikor a hajnali kettő vagy nem létezik, vagy kétszer van
// meg. Pillanatként tárolva a kérdés fel sem merül.

import { MODE, type Mode } from './state.ts'

export interface Window {
  /** Mikor kezdődik. `null` = azonnal érvényes. */
  startsAt: Date | null
  /** Mikor ér véget magától. `null` = amíg valaki ki nem kapcsolja. */
  endsAt: Date | null
}

export const PHASE = Object.freeze({
  /** Még nem kezdődött el. */
  BEFORE: 'BEFORE',
  /** Éppen tart. */
  DURING: 'DURING',
  /** Vége. */
  AFTER: 'AFTER'
} as const)

export type Phase = typeof PHASE[keyof typeof PHASE]

/** Dátummá alakítás, ami sosem dob. Érvénytelen bemenet → `null`. */
export function toDate (value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null
  if (typeof value !== 'string' || !value.trim()) return null
  const at = new Date(value)
  return Number.isFinite(at.getTime()) ? at : null
}

/**
 * Hol tartunk az ablakban.
 *
 * A HATÁROK: a kezdés pillanata már BENNE van (`>=`), a befejezésé már NINCS
 * (`<`). Egy fél-nyitott intervallum az egyetlen alak, amiben két egymás után
 * következő ablak nem fedi át magát egy pillanatra, és nem is hagy ki egyet.
 */
export function phaseAt (window: Window, now: Date): Phase {
  const at = now.getTime()
  if (window.startsAt && at < window.startsAt.getTime()) return PHASE.BEFORE
  if (window.endsAt && at >= window.endsAt.getTime()) return PHASE.AFTER
  return PHASE.DURING
}

/**
 * A ténylegesen érvényes állapot, az ütemezést is beleszámítva.
 *
 * A beállított mód egy SZÁNDÉK; ez a függvény mondja meg, hogy az a szándék
 * most érvényes-e:
 *
 *   * az ablak előtt `SCHEDULED` — a látogató visszaszámlálót lát, de minden
 *     működik;
 *   * az ablakban a beállított mód;
 *   * az ablak után `OFF` — MAGÁTÓL, worker nélkül. Ez a legfontosabb sor az
 *     egész fájlban: egy lejárt karbantartás akkor is véget ér, ha közben
 *     minden háttérfeladat áll.
 *
 * A VÉSZHELYZET KIVÉTEL: az nem ütemezhető és nem jár le magától. Aki
 * vészhelyzetet hirdetett, az kézzel oldja fel — egy lejáró vészlezárás
 * pontosan az a meglepetés, amit nem akarunk.
 */
export function effectiveMode (intent: Mode, window: Window, now: Date): Mode {
  if (intent === MODE.OFF) return MODE.OFF
  if (intent === MODE.EMERGENCY) return MODE.EMERGENCY

  const phase = phaseAt(window, now)
  if (phase === PHASE.BEFORE) return MODE.SCHEDULED
  if (phase === PHASE.AFTER) return MODE.OFF
  return intent
}

/**
 * Hány másodperc múlva változik legközelebb az állapot.
 *
 * Ebből lesz a `Retry-After` és a visszaszámláló. `null`, ha nem tudjuk — és
 * olyankor a hívó egy általános értéket használ, nem talál ki egyet.
 */
export function secondsUntilChange (intent: Mode, window: Window, now: Date): number | null {
  if (intent === MODE.EMERGENCY) return null
  const at = now.getTime()
  const phase = phaseAt(window, now)
  if (phase === PHASE.BEFORE && window.startsAt) {
    return Math.max(1, Math.ceil((window.startsAt.getTime() - at) / 1000))
  }
  if (phase === PHASE.DURING && window.endsAt) {
    return Math.max(1, Math.ceil((window.endsAt.getTime() - at) / 1000))
  }
  return null
}

/**
 * Egy időpont kiírása egy adott időzónában.
 *
 * Ez az EGYETLEN hely, ahol az időzóna számít, és itt is csak szövegként. Egy
 * ismeretlen zónanév nem hiba: a rendszer sajátjára esünk vissza, mert egy
 * elrontott beállítás miatt nem maradhat el a tájékoztatás.
 */
export function formatInZone (at: Date | null, timeZone: string | null | undefined): string | null {
  if (!at) return null
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  }
  try {
    return new Intl.DateTimeFormat('hu-HU', { ...options, timeZone: timeZone ?? undefined }).format(at)
  } catch {
    return new Intl.DateTimeFormat('hu-HU', options).format(at)
  }
}
