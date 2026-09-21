// A központi döntés: mi történjen EZZEL a kéréssel.
//
// A 4. pont kéri, hogy legyen egy központi réteg, és hogy a FRONTEND SOHA NE
// LEGYEN BIZTONSÁGI HATÁR. Ez a fájl az a réteg: a kliens ugyanezt a
// döntést kérdezheti meg a megjelenítéshez, de a betartatás itt történik,
// szerveroldalon, minden kérésnél.
//
// TISZTA FÜGGVÉNY. Nem olvas adatbázist, nem néz órát magától, nem ír naplót.
// Kap egy konfigurációt, egy időpontot és egy kérés-leírást, és visszaad egy
// döntést. Ettől az egész állapottér végigjárható teszttel — és ez az a
// rendszer, ahol egy elrontott feltétel azt jelenti, hogy vagy mindenki
// kizárva, vagy senki.

import { MODE, SCOPE, blocksEverything, blocksWrites, isEmergency, scopeMatches, type Mode, type Scope } from './state.ts'
import { effectiveMode, secondsUntilChange, type Window } from './schedule.ts'

/** A kérésről annyi, amennyi a döntéshez kell. */
export interface RequestFacts {
  /** Az útvonal, lekérdezés nélkül is jó. */
  url: string
  /** HTTP-metódus. */
  method: string
  /** A hívó szerepei — a mentességhez. */
  roles?: readonly string[]
  /** Érvényes mentességi jegyet mutatott-e fel. */
  hasBypassToken?: boolean
  /** A saját hálózatunkról jött-e (worker, bot, egészségjelző). */
  internal?: boolean
  /** Van-e már munkamenete — a „meglévő munkamenetek maradhatnak" szabályhoz. */
  hasSession?: boolean
  /** Mikor kezdődött a munkamenet — a kiürítési idő ebből számol. */
  sessionStartedAt?: Date | null
}

/** A karbantartás beállítása, ahogy a gyorsítótárból jön. */
export interface MaintenanceConfig {
  enabled: boolean
  mode: Mode
  scope: Scope
  window: Window
  /** Hány másodpercig maradhatnak bent a már bent lévők. */
  drainSeconds: number
  allowExistingSessions: boolean
  title: string
  publicMessage: string
  timezone: string | null
  version: number
}

export const DECISION = Object.freeze({
  /** Mehet tovább. */
  ALLOW: 'ALLOW',
  /** Teljes lezárás — 503. */
  BLOCK: 'BLOCK',
  /** Olvasni lehet, írni nem — 503 csak az írásokra. */
  READ_ONLY: 'READ_ONLY'
} as const)

export type DecisionKind = typeof DECISION[keyof typeof DECISION]

export interface Decision {
  kind: DecisionKind
  /** A ténylegesen érvényes mód — ez megy a válaszba és a felületre. */
  mode: Mode
  scope: Scope
  /** Egy mondat, ami megmagyarázza. Naplóba való, nem a látogatónak. */
  reason: string
  /** Hány másodperc múlva érdemes visszajönni. */
  retryAfter: number | null
  /** Ha mentesség engedte át, ez mondja meg, melyik. */
  bypass: string | null
}

/** Ennyi másodpercre küldjük vissza a látogatót, ha nincs ismert befejezés. */
export const DEFAULT_RETRY_SECONDS = 120

/**
 * A mindig nyitva maradó útvonalak.
 *
 * A 26. pont kéri az egészségjelzőket. A többi ugyanaz a gondolat: ha ezek
 * lezárnának, a karbantartásból nem lehetne KIJÖNNI — az irányítórendszer
 * halottnak hinné a szolgáltatást, az admin nem tudna belépni, és a
 * karbantartási oldal maga sem tudná megkérdezni, hogy vége van-e már.
 */
const ALWAYS_OPEN = [
  '/v1/health',
  '/v1/status',
  '/v1/config',
  '/v1/maintenance',
  /*
   * A KARBANTARTÁSI OLDAL SAJÁT MÉDIÁJA.
   *
   * A fenti indoklás — „a karbantartási oldal maga sem tudná megkérdezni,
   * hogy vége van-e már" — pontosan ugyanígy áll a lap MÉDIÁJÁRA is, csak
   * eddig nem alkalmaztuk rá. A lap egy `<video>` lejátszót rajzol
   * `/assets/videos/...` forrással, a kapu viszont azt is 503-mal utasította
   * vissza: a látogató egy vezérlőkkel ellátott, de soha meg nem szólaló
   * fekete dobozt kapott.
   *
   * Böngészőben lemérve: a videó kérésének státusza 503 volt.
   *
   * Az `/assets` alatt nincs semmi érzékeny — a két arculati SVG és a videó —,
   * és ezek amúgy is nyilvános, hitelesítés nélkül kérhető állományok. Nem
   * tágít tehát semmit: azt engedi át, amit a saját hibaoldalunk kér.
   */
  '/assets'
]

function alwaysOpen (url: string): boolean {
  const path = String(url ?? '').split('?')[0] ?? ''
  return ALWAYS_OPEN.some(prefix => path === prefix || path.startsWith(prefix + '/'))
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * A helyreállítási útvonalak — a 13. pont „admin lockout elleni védelme".
 *
 * Ezek vészhelyzetben IS nyitva maradnak, de CSAK jogosult adminnak. A
 * jogosultság ellenőrzése nem itt történik (az a hitelesítési rétegé); itt
 * annyi a szabály, hogy a karbantartás maga ne zárja ki azt, aki fel tudná
 * oldani.
 *
 * E nélkül a vészhelyzet egyirányú ajtó lenne: bekapcsolni lehetne, kikapcsolni
 * nem, mert a kikapcsoló végpont is zárva volna.
 */
const RECOVERY_PREFIXES = ['/v1/admin/maintenance', '/v1/auth/login', '/v1/auth/refresh']

function isRecoveryPath (url: string): boolean {
  const path = String(url ?? '').split('?')[0] ?? ''
  return RECOVERY_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix + '/'))
}

const STAFF_ROLES = new Set(['admin', 'owner', 'moderator', 'staff'])

function hasStaffRole (roles: readonly string[] | undefined): boolean {
  return Array.isArray(roles) && roles.some(role => STAFF_ROLES.has(String(role).toLowerCase()))
}

/**
 * Bent maradhat-e egy már futó munkamenet.
 *
 * A 24. pont kiürítése: a karbantartás bekapcsolásakor ÚJ munkamenetek már
 * nem jöhetnek be, a bent lévők viszont kapnak még néhány percet. Ez akkor
 * hasznos, amikor a karbantartás oka egy telepítés, és nem akarjuk félbevágni
 * azt, aki épp néz egy részt.
 *
 * A `drainSeconds` a KARBANTARTÁS KEZDETÉTŐL számol, nem a munkamenetétől: a
 * kiürítés egy közös visszaszámlálás, nem személyre szabott türelmi idő.
 */
export function withinDrain (config: MaintenanceConfig, now: Date, facts: RequestFacts): boolean {
  if (!config.allowExistingSessions) return false
  if (!facts.hasSession) return false
  if (!Number.isFinite(config.drainSeconds) || config.drainSeconds <= 0) return false
  const started = config.window.startsAt
  // Ismeretlen kezdés mellett nincs mihez mérni a kiürítést: ilyenkor a
  // türelmi idő nem létezik, nem pedig végtelen.
  if (!started) return false
  // A munkamenetnek a karbantartás KEZDETE ELŐTT kellett indulnia. Enélkül
  // egy friss bejelentkezés is „meglévő munkamenetnek" számítana, és a
  // kiürítés sosem érne véget.
  if (facts.sessionStartedAt && facts.sessionStartedAt.getTime() > started.getTime()) return false
  return now.getTime() < started.getTime() + config.drainSeconds * 1000
}

/**
 * A döntés.
 *
 * A SORREND fontos, és ez a sorrend maga a szabályzat:
 *
 *   1. ki van kapcsolva → mehet;
 *   2. mindig nyitott útvonal → mehet (egészség, státusz, konfiguráció);
 *   3. a saját rendszerünk → mehet (a worker nem látogató);
 *   4. helyreállítási útvonal → mehet (különben nem lehetne kijönni);
 *   5. érvényes mentességi jegy → mehet;
 *   6. személyzet → mehet, KIVÉVE vészhelyzetben, ahol csak a jeggyel
 *      rendelkező vagy a helyreállítási útvonal jöhet;
 *   7. nem erre a hatókörre szól → mehet;
 *   8. kiürítési idő alatt, meglévő munkamenettel → mehet;
 *   9. különben a mód dönt.
 */
export function decide (config: MaintenanceConfig, now: Date, facts: RequestFacts): Decision {
  const mode = config.enabled
    ? effectiveMode(config.mode, config.window, now)
    : MODE.OFF
  const retryAfter = secondsUntilChange(config.mode, config.window, now) ?? DEFAULT_RETRY_SECONDS

  const allow = (reason: string, bypass: string | null = null): Decision =>
    ({ kind: DECISION.ALLOW, mode, scope: config.scope, reason, retryAfter: null, bypass })

  if (mode === MODE.OFF || mode === MODE.SCHEDULED) {
    return allow(mode === MODE.SCHEDULED ? 'a karbantartás még nem kezdődött el' : 'nincs karbantartás')
  }

  if (alwaysOpen(facts.url)) return allow('mindig nyitott útvonal')
  if (facts.internal) return allow('a saját rendszerünkből érkezett', 'internal')
  if (isRecoveryPath(facts.url)) return allow('helyreállítási útvonal', 'recovery')
  if (facts.hasBypassToken) return allow('érvényes mentességi jegy', 'token')

  if (hasStaffRole(facts.roles)) {
    // VÉSZHELYZETBEN A SZEREP ÖNMAGÁBAN KEVÉS. Ott a helyreállítási útvonal és
    // a jegy a két út — egy általános „admin vagyok" nem nyitja ki az egész
    // oldalt, mert a vészhelyzet oka lehet épp egy feltört admin fiók.
    if (!isEmergency(mode)) return allow('személyzeti szerep', 'staff')
  }

  if (!scopeMatches(config.scope, facts.url)) {
    return allow(`a(z) ${config.scope} hatókör nem érinti ezt az útvonalat`)
  }

  if (withinDrain(config, now, facts)) return allow('kiürítési idő — meglévő munkamenet', 'drain')

  if (blocksEverything(mode)) {
    return {
      kind: DECISION.BLOCK,
      mode,
      scope: config.scope,
      reason: `${mode} karbantartás a(z) ${config.scope} hatókörön`,
      retryAfter,
      bypass: null
    }
  }

  if (blocksWrites(mode)) {
    if (!WRITE_METHODS.has(String(facts.method ?? '').toUpperCase())) {
      return allow('csak olvasható üzem — ez olvasás')
    }
    return {
      kind: DECISION.READ_ONLY,
      mode,
      scope: config.scope,
      reason: 'csak olvasható üzem — az írásokat nem fogadjuk',
      retryAfter,
      bypass: null
    }
  }

  // DEGRADED: a hatókör maga a korlátozás. Ha idáig eljutottunk, az útvonal
  // beleesik a lezárt területbe.
  return {
    kind: DECISION.BLOCK,
    mode,
    scope: config.scope,
    reason: `a(z) ${config.scope} terület átmenetileg kikapcsolva`,
    retryAfter,
    bypass: null
  }
}

/** Alapértelmezett, „minden rendben" beállítás — a gyorsítótár hidegindításához. */
export function offConfig (): MaintenanceConfig {
  return {
    enabled: false,
    mode: MODE.OFF,
    scope: SCOPE.GLOBAL,
    window: { startsAt: null, endsAt: null },
    drainSeconds: 0,
    allowExistingSessions: false,
    title: '',
    publicMessage: '',
    timezone: null,
    version: 0
  }
}
