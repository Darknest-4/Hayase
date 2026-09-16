// A kockázati motor: jelekből pontszám.
//
// EGY DOLGOT CSINÁL, ÉS CSAK AZT: megmondja, mennyire gyanús ez a kérés. NEM
// dönt róla. A döntés a `policy.ts`-ben van, és ez a szétválasztás nem
// formalitás:
//
//   * a pontozás mérés, a döntés szabály. A kettő külön változik — a súlyokat
//     az hangolja, aki a forgalmat nézi, a küszöböket az, aki a kockázatot
//     vállalja;
//   * száraz üzemmódban ugyanaz a pontszám születik, csak a döntés nem hat.
//     Ha a kettő egy helyen lenne, a száraz üzem egy `if` lenne a pontozás
//     közepén, és az első hibája az lenne, hogy élesben mást számol, mint
//     szárazon;
//   * a pontszám naplózható és visszafejthető. Egy tiltás mellé oda lehet
//     írni, MELYIK jel mennyit adott — egy puszta „87 pont" nem válasz arra,
//     hogy miért.
//
// A SÚLYOK KONFIGURÁCIÓBÓL JÖNNEK, nem innen. Ebben a fájlban nincs egyetlen
// beégetett pontszám sem.

import type { EdgeConfig } from './config.ts'
import type { IpIntel } from './ip-intel.ts'
import type { Hit } from './waf.ts'

/** Amit a kérésről tudni lehet, mire ide eljut. */
export interface Evidence {
  intel: IpIntel | null
  waf: Hit[]
  /** Hány kérés jött erről a címről az elmúlt percben. */
  perMinute: number
  /** Hány kérés jött erről a címről az elmúlt órában. */
  perHour: number
  /** Az ütem egyenletessége, 0–1. Lásd counters.cadence. */
  cadence: number
  /** A böngészőazonosító robotnak vallja magát. */
  declaredBot: boolean
  /** Hiányzik a böngészőazonosító, vagy ellentmondó a fejléckészlet. */
  headerAnomaly: boolean
  /** Hány 404-et kapott ez a cím az elmúlt tíz percben. */
  notFound: number
  /** Hány sikertelen belépés jött erről a címről az elmúlt órában. */
  authFailures: number
  /** Hány korábbi biztonsági esemény van erről a címről (24 óra). */
  history: number
  /** A végpont érzékenysége, 0–1: a hitelesítés és az admin a magas. */
  sensitivity: number
}

export interface Signal {
  key: string
  /** Hány pontot adott. */
  points: number
  /** Egy mondat, ami megmagyarázza — ez kerül a naplóba és a panelre. */
  why: string
}

export interface Assessment {
  score: number
  signals: Signal[]
}

/** Üres bizonyíték: minden nulla. A tesztek és a hívók alapja. */
export function noEvidence (): Evidence {
  return {
    intel: null,
    waf: [],
    perMinute: 0,
    perHour: 0,
    cadence: 0,
    declaredBot: false,
    headerAnomaly: false,
    notFound: 0,
    authFailures: 0,
    history: 0,
    sensitivity: 0
  }
}

/**
 * A pontszám.
 *
 * Minden jel külön sorban, a saját magyarázatával. A végén összeadás, majd az
 * érzékenységgel szorzás — egy gyanús kérés a belépésre többet ér, mint
 * ugyanaz a katalóguson.
 */
export function assess (evidence: Evidence, config: EdgeConfig): Assessment {
  const w = config.weights
  const signals: Signal[] = []
  const add = (key: string, points: number, why: string): void => {
    if (points > 0) signals.push({ key, points: Math.round(points), why })
  }

  // ---- amit a címről tudunk ----
  //
  // A bizonyossággal SZOROZVA. Egy 0.3-as bizonyosságú „VPN" harmadannyit ér,
  // mint egy 0.95-ös — enélkül egy tétova heurisztika ugyanúgy tiltana, mint
  // egy megbízható adatforrás.
  const intel = evidence.intel
  if (intel) {
    const c = intel.confidence
    if (intel.isTor) add('tor', w.tor * c, 'Tor kilépőpont')
    if (intel.isProxy) add('proxy', w.proxy * c, 'nyílt proxy')
    if (intel.isVpn) add('vpn', w.vpn * c, 'VPN-szolgáltató címe')
    // A hosting NEM bűn: a legtöbb bot innen jön, de ugyanígy a fejlesztők,
    // a felügyeleti rendszerek és a VPN-t használó látogatók is. Kis súly.
    if (intel.isHosting) add('hosting', w.hosting * c, `adatközponti cím${intel.provider ? ` (${intel.provider})` : ''}`)
    if (intel.reputation > 0) {
      add('reputation', (w.reputation * intel.reputation / 100) * c,
        `rossz hírnév (${intel.reputation}/100)`)
    }
  }

  // ---- WAF ----
  // A szabály maga adja a pontot; a súly szorzó rajta. Így egy szabály
  // pontszáma a szabályhoz tartozik, a WAF egészének fontossága pedig a
  // beállításhoz.
  for (const hit of evidence.waf) {
    add(`waf:${hit.rule}`, hit.score * (w.waf / 50), hit.title)
  }

  // ---- ütem ----
  // Nem a kérések száma önmagában: azt a sebességkorlát kezeli. Az arány
  // számít — aki percenként hatvanat küld, az nem olvas.
  if (evidence.perMinute > 60) {
    add('burst', w.burst * Math.min(1, evidence.perMinute / 300),
      `${evidence.perMinute} kérés az elmúlt percben`)
  }
  if (evidence.cadence > 0.85) {
    add('cadence', w.cadence * evidence.cadence,
      'gépies, egyenletes kérési ütem')
  }

  // ---- amit a kérés magáról mond ----
  if (evidence.declaredBot) {
    // Kis súly, és szándékosan: aki robotnak vallja magát, az általában
    // őszinte. A keresőmotorok is ilyenek. Amit büntetünk, az nem az
    // őszinteség, hanem a viselkedés.
    add('declaredBot', w.declaredBot, 'robotnak vallja magát')
  }
  if (evidence.headerAnomaly) {
    add('headers', w.headers, 'hiányzó vagy ellentmondó fejlécek')
  }

  // ---- felderítés és visszaélés ----
  if (evidence.notFound >= 10) {
    add('probing', w.probing * Math.min(1, evidence.notFound / 50),
      `${evidence.notFound} nem létező cím tíz perc alatt`)
  }
  if (evidence.authFailures >= 5) {
    add('authFailures', w.authFailures * Math.min(1, evidence.authFailures / 20),
      `${evidence.authFailures} sikertelen belépés egy óra alatt`)
  }
  if (evidence.history > 0) {
    add('history', w.history * Math.min(1, evidence.history / 10),
      `${evidence.history} korábbi biztonsági esemény`)
  }

  const raw = signals.reduce((sum, signal) => sum + signal.points, 0)

  /*
   * A végpont érzékenysége SZORZÓ, nem összeadandó.
   *
   * Egy gyanús kérés a katalóguson kellemetlen; ugyanaz a belépésen vagy az
   * adminon más súlyú. Összeadva viszont az érzékenység önmagában pontot
   * adna, és akkor minden admin-kérés gyanús lenne — a legártalmatlanabb is.
   */
  const score = Math.round(raw * (1 + evidence.sensitivity))

  return { score: Math.max(0, Math.min(1000, score)), signals }
}

/**
 * Egy végpont érzékenysége, 0–1.
 *
 * Nem beállítás: ez a rendszer alakja, nem hangolási kérdés. A hitelesítés és
 * az adminfelület azért érzékeny, mert ott egy sikeres visszaélés mindent
 * visz; a katalógus azért nem, mert nyilvános.
 */
export function sensitivityOf (url: string): number {
  if (url.startsWith('/v1/auth')) return 1
  if (url.startsWith('/v1/admin')) return 1
  if (url.startsWith('/graphql')) return 0.5
  if (url.startsWith('/v1/me')) return 0.4
  return 0
}
