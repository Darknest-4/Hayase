// A providerréteg belépési pontja.
//
// EGY HELY, AHOL AZ ADAPTEREK BEJELENTKEZNEK. Enélkül minden adapter valahol
// a kód szélén regisztrálná magát, és a „melyek vannak bekötve?" kérdésre a
// válasz egy `grep` lenne.
//
// Egy új adapter bekötése: importálni és felvenni a listába. Egy megszűnt
// eltávolítása: kivenni a listából — de a MINDENNAPI művelet nem ez, hanem a
// kikapcsolás az adminfelületen, ami nem igényel telepítést.

import { httpFeedProvider } from './adapters/http-feed.ts'
import { animeparadiseProvider } from './adapters/animeparadise.ts'
import { localProvider } from './adapters/local.ts'
import { register } from './registry.ts'

export * as health from './health.ts'
export * as registry from './registry.ts'
export { resolveEpisode } from './resolve.ts'
export type { Attempt, Resolution } from './resolve.ts'
export * from './types.ts'

/** A beépített adapterek. A sorrend itt nem számít — azt a prioritás adja. */
/*
 * A beépített adapterek. A sorrend itt nem számít — azt a prioritás adja.
 *
 * A `http-feed` BEÁLLÍTÁS NÉLKÜL nem csinál semmit (üres eredmény, egyetlen
 * kérés nélkül), tehát ártalmatlan bekapcsolva hagyni: az adminfelületen
 * látszik, és ott lehet ráállítani egy címre.
 */
const BUILT_IN = [localProvider, animeparadiseProvider, httpFeedProvider]

let done = false

/**
 * Az adapterek bejelentkeztetése. Többszöri hívás ártalmatlan.
 *
 * ÜTKÖZŐ AZONOSÍTÓ = INDULÁSI HIBA, nem csendes felülírás.
 *
 * A regiszter `Map`-ben tárol: két azonos azonosítójú adapterből a MÁSODIK
 * szó nélkül felülírja az elsőt, és a `known()` egyetlen bejegyzést ad
 * vissza. Megmérve: két adapter regisztrálása után a lista hossza 1, és a
 * megmaradt a második. Az első onnantól halott kód — létezik, sosem hívódik,
 * és semmi nem szól róla.
 *
 * A `register()` viselkedésén SZÁNDÉKOSAN nem változtatok: a felülírás ott
 * hasznos, mert így tud egy teszt hamis adaptert tenni egy valódi helyére. Az
 * ütközés csak a BEÉPÍTETT listában hiba — ott két adapter szerzője nem
 * tudott egymásról.
 *
 * Indulási hiba, nem naplóbejegyzés: egy figyelmeztetés elveszne az induláskor
 * kiírt sorok között, és a hiba tünete (egy adapter „nem csinál semmit")
 * sosem vezetne vissza ide.
 */
export function registerBuiltInProviders (): void {
  if (done) return

  const latott = new Set<string>()
  const utkozo: string[] = []
  for (const provider of BUILT_IN) {
    if (latott.has(provider.id)) utkozo.push(provider.id)
    latott.add(provider.id)
  }
  if (utkozo.length) {
    throw new Error(
      'két beépített szolgáltató ugyanazt az azonosítót viseli, és a második ' +
      `csendben felülírná az elsőt: ${[...new Set(utkozo)].join(', ')}`
    )
  }

  for (const provider of BUILT_IN) register(provider)
  done = true
}

/** Csak tesztekhez: a következő hívás újra regisztrál. */
export function forgetRegistration (): void { done = false }
