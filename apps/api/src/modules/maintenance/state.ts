// A karbantartás állapotai és hatókörei.
//
// TISZTA FÜGGVÉNYEK, adatbázis és HTTP nélkül. Ez szándékos: a karbantartás
// legkényesebb kérdései — mikor kezdődik, mire vonatkozik, ki mehet be —
// mind eldönthetők pusztán adatból, és ami így eldönthető, azt egy teszt
// ezredmásodpercek alatt végigjárja. Egy adatbázis mögé rejtett
// állapotgépet csak élesben lehet kipróbálni, és az késő.

/** A hat állapot, a 2. pont szerint. */
export const MODE = Object.freeze({
  /** Normál működés. */
  OFF: 'OFF',
  /** Be van ütemezve, de még nem kezdődött el. */
  SCHEDULED: 'SCHEDULED',
  /** Teljes karbantartás. */
  ACTIVE: 'ACTIVE',
  /** Az oldal él, de bizonyos funkciók kikapcsolva. */
  DEGRADED: 'DEGRADED',
  /** Böngészni lehet, módosítani nem. */
  READ_ONLY: 'READ_ONLY',
  /** Azonnali teljes lezárás. */
  EMERGENCY: 'EMERGENCY'
} as const)

export type Mode = typeof MODE[keyof typeof MODE]

export const MODES: readonly Mode[] = Object.freeze(Object.values(MODE))

/**
 * A hatókörök, a 3. pont szerint.
 *
 * A `global` nem egy a többi közül: az MINDET jelenti. A többi egy-egy
 * funkcióterület, és a kettő között az a különbség, hogy a `global` alatt az
 * `admin` is lezárul (a mentesség külön kérdés), a funkció-hatókörök alatt
 * viszont az oldal többi része él.
 */
export const SCOPE = Object.freeze({
  GLOBAL: 'global',
  WEB: 'web',
  API: 'api',
  AUTH: 'authentication',
  REGISTRATION: 'registration',
  PLAYER: 'player',
  CATALOG: 'catalog',
  SEARCH: 'search',
  WATCH_HISTORY: 'watch-history',
  WATCH_PARTY: 'watch-party',
  COMMENTS: 'comments',
  PROFILES: 'profiles',
  ADMIN: 'admin'
} as const)

export type Scope = typeof SCOPE[keyof typeof SCOPE]

export const SCOPES: readonly Scope[] = Object.freeze(Object.values(SCOPE))

/**
 * Melyik hatókörhöz milyen útvonalak tartoznak.
 *
 * ELŐTAG-ILLESZTÉS, nem reguláris kifejezés. Egy mintakészlet, amit
 * karbantartani kell, előbb-utóbb félreillik — egy előtaglista viszont
 * elolvasható, és az illeszkedés kiszámítható.
 *
 * Ami itt nincs felsorolva, arra csak a `global` hat. Ez szándékos: egy
 * ismeretlen új végpont maradjon elérhető, amíg valaki ki nem mondja, hogy
 * melyik területhez tartozik.
 */
const SCOPE_PREFIXES: Partial<Record<Scope, readonly string[]>> = {
  [SCOPE.AUTH]: ['/v1/auth'],
  [SCOPE.REGISTRATION]: ['/v1/auth/register'],
  [SCOPE.PLAYER]: ['/v1/anime/episodes', '/v1/sources', '/v1/media'],
  [SCOPE.CATALOG]: ['/v1/anime'],
  [SCOPE.SEARCH]: ['/v1/search', '/v1/anime/search'],
  [SCOPE.WATCH_HISTORY]: ['/v1/history', '/v1/watch', '/v1/library'],
  [SCOPE.WATCH_PARTY]: ['/v1/watch-together', '/v1/w2g'],
  [SCOPE.COMMENTS]: ['/v1/comments', '/v1/forum', '/v1/chat'],
  [SCOPE.PROFILES]: ['/v1/profile', '/v1/users'],
  [SCOPE.ADMIN]: ['/v1/admin'],
  [SCOPE.API]: ['/v1', '/graphql']
}

/**
 * Vonatkozik-e egy hatókör erre az útvonalra.
 *
 * A `global` mindenre; a `web` semmire a szerveroldalon (az a kliens
 * felületéről szól, és a szerver nem a felületet zárja le, hanem a
 * végpontokat).
 */
export function scopeMatches (scope: Scope, url: string): boolean {
  if (scope === SCOPE.GLOBAL) return true
  if (scope === SCOPE.WEB) return false
  const path = String(url ?? '').split('?')[0] ?? ''
  const prefixes = SCOPE_PREFIXES[scope]
  if (!prefixes) return false
  return prefixes.some(prefix => path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?'))
}

/** Az útvonalhoz tartozó hatókörök, a legszűkebbtől a legtágabbig. */
export function scopesFor (url: string): Scope[] {
  return SCOPES.filter(scope => scope !== SCOPE.GLOBAL && scopeMatches(scope, url))
}

/**
 * Az az állapot, ami az ÍRÁSOKAT tiltja, de az olvasást engedi.
 *
 * Külön függvény, mert két helyről kell: a köztesréteg ebből dönt, és az
 * admin felület ebből mutatja, mi fog történni.
 */
export function blocksWrites (mode: Mode): boolean {
  return mode === MODE.READ_ONLY || blocksEverything(mode)
}

/** Az az állapot, ami minden kérést lezár (a mentességek külön kérdés). */
export function blocksEverything (mode: Mode): boolean {
  return mode === MODE.ACTIVE || mode === MODE.EMERGENCY
}

/** Fut-e egyáltalán bármilyen korlátozás. */
export function isRestricting (mode: Mode): boolean {
  return mode !== MODE.OFF && mode !== MODE.SCHEDULED
}

/**
 * Az az állapot, amiben CSAK a feltétlenül szükséges maradhat nyitva.
 *
 * A vészhelyzet nem „erősebb ACTIVE": ott az admin felület nagy része is
 * zárva van, és csak az egészségjelzés, a megfigyelés és a helyreállításhoz
 * kellő végpontok élnek.
 */
export function isEmergency (mode: Mode): boolean {
  return mode === MODE.EMERGENCY
}

/** Ismeretlen szöveg → biztonságos érték. Sosem dob. */
export function parseMode (value: unknown): Mode {
  const text = String(value ?? '').toUpperCase()
  return (MODES as readonly string[]).includes(text) ? text as Mode : MODE.OFF
}

/** Ismeretlen hatókör → `global`. A tágabb a biztonságosabb feltételezés. */
export function parseScope (value: unknown): Scope {
  const text = String(value ?? '').toLowerCase()
  return (SCOPES as readonly string[]).includes(text) ? text as Scope : SCOPE.GLOBAL
}
