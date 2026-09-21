// A providerréteg belépési pontja.
//
// EGY HELY, AHOL AZ ADAPTEREK BEJELENTKEZNEK. Enélkül minden adapter valahol
// a kód szélén regisztrálná magát, és a „melyek vannak bekötve?" kérdésre a
// válasz egy `grep` lenne.
//
// Egy új adapter bekötése: importálni és felvenni a listába. Egy megszűnt
// eltávolítása: kivenni a listából — de a MINDENNAPI művelet nem ez, hanem a
// kikapcsolás az adminfelületen, ami nem igényel telepítést.

import { localProvider } from './adapters/local.ts'
import { register } from './registry.ts'

export * as health from './health.ts'
export * as registry from './registry.ts'
export { resolveEpisode } from './resolve.ts'
export type { Attempt, Resolution } from './resolve.ts'
export * from './types.ts'

/** A beépített adapterek. A sorrend itt nem számít — azt a prioritás adja. */
const BUILT_IN = [localProvider]

let done = false

/** Az adapterek bejelentkeztetése. Többszöri hívás ártalmatlan. */
export function registerBuiltInProviders (): void {
  if (done) return
  for (const provider of BUILT_IN) register(provider)
  done = true
}

/** Csak tesztekhez: a következő hívás újra regisztrál. */
export function forgetRegistration (): void { done = false }
