// A terheléses mérés kapuja.
//
// Az IP-alapú sebességkorlát pontosan azt csinálja, amire való: egyetlen
// címről érkező sok kérést megfojt. Egy terheléses mérés viszont definíció
// szerint egyetlen címről érkező sok kérés — tehát korlát mellett nem a
// terméket méri, hanem a korlátot. Ez a mérés leggyakoribb hamis eredménye:
// „500 VU-nál összeesik", pedig 300 kérés/perc után minden válasz 429 volt.
//
// A rossz megoldás az, hogy a mérés idejére feljebb tolják a korlátot
// mindenkinek. Az egy éles biztonsági beállítás átírása egy mérés kedvéért, és
// utána ott marad.
//
// Ehelyett: egy kimondottan erre engedélyezett forrás. Három feltétel, és
// mindhárom kell:
//
//   1. `LOAD_TEST_KEY` be van állítva (legalább 32 karakter). Enélkül a
//      mentesség NEM LÉTEZIK — ez az alapállapot, és éles telepítésen ez marad.
//   2. A kérés hozza a kulcsot az `x-yume-load-test` fejlécben. Az
//      összehasonlítás időfüggetlen.
//   3. A kérés forrása szerepel a `LOAD_TEST_IPS` listán (alapból csak a
//      hurokcím). Pontos címek, nem tartomány: egy biztonsági kivételnél a
//      szűkebb a helyes alapértelmezés, és egy mérés forrása mindig ismert.
//
// A kulcs önmagában tehát nem elég, és a cím önmagában sem. Aki a kulcsot
// megszerzi, azzal sem tud a korlát mögé kerülni máshonnan; aki a listán
// szereplő gépet megszerzi, annak a kulcs is kell.
//
// A mentesség CSAK a sebességkorlátot érinti. A hitelesítés, a jogosultságok,
// a csak olvasható mód és minden más ugyanúgy érvényes rá.

import { timingSafeEqual } from 'node:crypto'

import { config } from '../config.ts'

import type { FastifyRequest } from 'fastify'

const HEADER = 'x-yume-load-test'

/** Időfüggetlen összehasonlítás. Eltérő hossznál is dolgozik egy kicsit. */
function sameKey (given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // A hossz kiszivárgása itt nem érdekes (a kulcs hossza konfiguráció), de a
    // korai visszatérés ágat is fizetni kell, hogy a ciklus egyforma legyen.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** Be van-e egyáltalán kapcsolva a mentesség ezen a példányon? */
export function loadTestConfigured (): boolean {
  return Boolean(config.loadTestKey)
}

/**
 * A döntés maga, a kérésből kiemelve.
 *
 * Külön függvény, mert a `config` a modul betöltésekor olvassa a környezetet:
 * egy teszt, ami csak a bekötött úton tudja megfogni, egyetlen beállítást tud
 * végigpróbálni futásonként — és a fontos esetek itt épp a hiányzó kulcs és a
 * rossz cím, tehát a többi beállítás.
 */
export function allowsLoadTest (
  given: unknown,
  ip: string,
  expected: string | undefined,
  allowedIps: readonly string[]
): boolean {
  // Kulcs nélkül a mentesség nem létezik. Ez az alapállapot.
  if (!expected) return false
  if (typeof given !== 'string' || !given) return false
  // A cím a kulcstól függetlenül is feltétel: a kulcs megszerzése önmagában
  // ne legyen elég ahhoz, hogy bárhonnan a korlát mögé lehessen kerülni.
  if (!allowedIps.includes(ip)) return false
  return sameKey(given, expected)
}

/**
 * Ez a kérés a mérésé?
 *
 * Nem dob és nem naplóz kérésenként: minden kérésre lefut, és egy mérés alatt
 * ez percenként több tízezer hívás.
 */
export function isLoadTestRequest (request: FastifyRequest): boolean {
  return allowsLoadTest(request.headers[HEADER], request.ip, config.loadTestKey, config.loadTestIps)
}
