// Az él beállításai — futásidőben, nem telepítéskor.
//
// Ugyanaz az elv, mint a sebességkorlátnál: egy védelem, amihez újraindítás
// kell, nem védelem, hanem terv. Az az egyetlen pillanat, amikor egy küszöböt
// állítani kell, az az, amikor épp folyik valami.
//
// A `site_settings` gyorsítótárazott olvasóján megy (30 másodperces
// élettartam, íráskor érvénytelenítve), tehát kérésenként egy map-keresés, nem
// egy lekérdezés. Ez az, ami miatt ez a forró úton is megengedhető.
//
// A beállítás HIÁNYA az alapértéket jelenti. Egy példány, amin senki nem járt
// a panelen, pontosan úgy viselkedik, mint az alapértékekkel — nincs olyan
// állapot, amiben az él „félig be van állítva".

import { settings } from '../settings/site-settings.ts'

/** Amit az él egy kérésre dönthet. Sorrendben, enyhétől a szigorúig. */
export type Action = 'allow' | 'monitor' | 'challenge' | 'throttle' | 'block'

export interface SignalWeights {
  /** Hosting/adatközponti cím. Nem bűn: a legtöbb bot innen jön, de a VPN is. */
  hosting: number
  vpn: number
  proxy: number
  tor: number
  /** A provider hírneve, 0–100; a súly ennek a századával szorzódik. */
  reputation: number
  /** Túl sok kérés rövid idő alatt (a sebességkorláton BELÜL is lehet gyanús). */
  burst: number
  /** Egyenletes, gépi ütem — ember nem kattint metronómra. */
  cadence: number
  /** Hiányzó vagy ellentmondó fejlécek. */
  headers: number
  /** A böngészőazonosító robotnak vallja magát. */
  declaredBot: number
  /** Sok 404 rövid idő alatt: valaki végigpróbálja az útvonalakat. */
  probing: number
  /** Sikertelen belépések. */
  authFailures: number
  /** Korábbi biztonsági események ugyanerről a címről. */
  history: number
  /** WAF-találat súlyossága szerint (a szabály maga adja a pontot). */
  waf: number
}

export interface EdgeConfig {
  /** Az él egyáltalán vizsgál-e. Kikapcsolva minden kérés átmegy. */
  enabled: boolean
  /**
   * Csak megfigyelés: mindent kiértékel és naplóz, de SEMMIT nem utasít
   * vissza. Ez az üzembe helyezés első lépése — egy hétig így fut, és a
   * naplóból derül ki, kit fojtana meg élesben.
   */
  dryRun: boolean
  weights: SignalWeights
  /** Pontszámküszöbök. A policy ezekből csinál döntést — lásd policy.ts. */
  thresholds: { monitor: number, challenge: number, throttle: number, block: number }
  /**
   * Egy `critical` WAF-találat önmagában is visszautasít, a pontszámtól
   * függetlenül. Egy `UNION SELECT` egy műfajszűrőben nem kétes jel, hanem
   * egyértelmű — és az összeadott pontszám az előbbire való.
   */
  criticalBlocks: boolean
  /** Az automatikus tiltás hossza másodpercben, ismétlődésenként növelve. */
  banSeconds: { first: number, repeat: number, max: number }
  /**
   * Végpontok, ahol az él HIBA ESETÉN IS visszautasít (fail-closed).
   * Mindenhol máshol egy elhasalt ellenőrzés átengedi a kérést: egy
   * biztonsági réteg hibája ne legyen kiesés.
   */
  failClosed: string[]
  /** Útvonalak, amiket az él soha nem vizsgál. */
  skip: string[]
}

export const DEFAULTS: EdgeConfig = {
  // Alapból BE van kapcsolva, de SZÁRAZON fut: kiértékel, naplóz, nem tilt.
  // Így a bekapcsolás nem kockázat, és egy hét múlva a naplóból lehet
  // eldönteni, hol állnak a küszöbök.
  enabled: true,
  dryRun: true,

  weights: {
    hosting: 15,
    vpn: 10,
    proxy: 20,
    tor: 25,
    reputation: 40,
    burst: 20,
    cadence: 15,
    headers: 10,
    declaredBot: 10,
    probing: 25,
    authFailures: 30,
    history: 20,
    waf: 50
  },

  thresholds: { monitor: 25, challenge: 50, throttle: 70, block: 90 },
  criticalBlocks: true,

  banSeconds: { first: 15 * 60, repeat: 60 * 60, max: 24 * 60 * 60 },

  // A hitelesítés és az admin: itt egy bizonytalan ellenőrzés inkább
  // utasítson vissza, mint engedjen át. Máshol fordítva.
  failClosed: ['/v1/auth', '/v1/admin'],

  // Az egészségjelzés soha: egy orchestrátor 503-at olvasna belőle, és
  // újraindítaná a konténert. A statikus kliens sem: az nem API.
  skip: ['/v1/health', '/assets', '/css', '/js', '/img', '/favicon']
}

/** Egy szám, ami tényleg szám és tényleg a tartományban van. */
function num (value: unknown, fallback: number, min = 0, max = 1000): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

/**
 * A hatályos beállítás.
 *
 * A tárolt jsonb ráolvasódik az alapértékekre, MEZŐNKÉNT: egy hibás vagy
 * hiányzó mező az alapértékét kapja, nem dobja el az egész beállítást. Egy
 * elgépelt súly ne kapcsolja ki az egész élt.
 */
export async function edgeConfig (): Promise<EdgeConfig> {
  const stored = (await settings.load()).edge
  const table = typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : {}

  const weights = { ...DEFAULTS.weights }
  const storedWeights = table.weights as Record<string, unknown> | undefined
  if (storedWeights) {
    for (const key of Object.keys(weights) as Array<keyof SignalWeights>) {
      weights[key] = num(storedWeights[key], DEFAULTS.weights[key], 0, 100)
    }
  }

  const t = table.thresholds as Record<string, unknown> | undefined
  const thresholds = {
    monitor: num(t?.monitor, DEFAULTS.thresholds.monitor, 0, 1000),
    challenge: num(t?.challenge, DEFAULTS.thresholds.challenge, 0, 1000),
    throttle: num(t?.throttle, DEFAULTS.thresholds.throttle, 0, 1000),
    block: num(t?.block, DEFAULTS.thresholds.block, 0, 1000)
  }

  const b = table.banSeconds as Record<string, unknown> | undefined
  const banSeconds = {
    first: num(b?.first, DEFAULTS.banSeconds.first, 60, 30 * 86_400),
    repeat: num(b?.repeat, DEFAULTS.banSeconds.repeat, 60, 30 * 86_400),
    max: num(b?.max, DEFAULTS.banSeconds.max, 60, 365 * 86_400)
  }

  const list = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value) && value.every(v => typeof v === 'string') ? value as string[] : fallback

  return {
    enabled: table.enabled !== false,
    // A száraz futás csak KIMONDOTTAN kapcsolható ki. Egy hiányzó mező nem
    // azt jelenti, hogy „tilthatsz".
    dryRun: table.dryRun !== false,
    weights,
    thresholds,
    criticalBlocks: table.criticalBlocks !== false,
    banSeconds,
    failClosed: list(table.failClosed, DEFAULTS.failClosed),
    skip: list(table.skip, DEFAULTS.skip)
  }
}

/** Vizsgálja-e az él ezt az útvonalat? */
export function inScope (url: string, config: EdgeConfig): boolean {
  return !config.skip.some(prefix => url.startsWith(prefix))
}

/** Erre az útvonalra hiba esetén visszautasítunk? */
export function isFailClosed (url: string, config: EdgeConfig): boolean {
  return config.failClosed.some(prefix => url.startsWith(prefix))
}
