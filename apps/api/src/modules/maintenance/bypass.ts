// Mentességi jegyek — a 12. pont.
//
// KÉT RÉTEG, és mindkettő kell:
//
//   1. ALÁÍRÁS. A jegy magában hordoz egy HMAC-et. Egy találomra beírt vagy
//      elgépelt jegy így ELADATBÁZIS NÉLKÜL elbukik — ez teszi olcsóvá azt,
//      hogy minden kérésnél megnézhessük, van-e jegy;
//
//   2. ADATBÁZIS. A jegy lenyomata egy táblában ül. Ez adja a VISSZAVONHATÓSÁGOT,
//      amit egy pusztán aláírt jegy nem tud: azt a lejáratáig nem lehet
//      érvényteleníteni, és ha kiszivárog, végig érvényes marad.
//
// A JEGY MAGA SEHOL NINCS ELTÁROLVA, csak a SHA-256 lenyomata — ugyanaz az
// elv, mint a jelszavaknál: aki megszerzi az adatbázist, ne tudjon vele
// bemenni.
//
// AMI NEM KERÜL AZ URL-BE. A 12. pont kéri: a jegy fejlécben vagy sütiben
// utazik, nem lekérdezési paraméterben. Egy URL bekerül a proxynaplókba, a
// böngésző előzményeibe és a hivatkozó fejlécbe — egy rövid életű jegy is
// túl sok helyen hagyna nyomot.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  findBypass, insertBypass, liveBypasses, pruneBypasses, recordEvent, revokeBypass, touchBypass
} from './repository.ts'
import { parseScope, scopeMatches, type Scope } from './state.ts'

/** A fejléc, amiben a jegy érkezik. */
export const BYPASS_HEADER = 'x-yume-maintenance-bypass'
/** A süti, ha a látogató böngészővel jön (a fejlécet ott nem tudja feltenni). */
export const BYPASS_COOKIE = 'yume_maintenance_bypass'

/** Alapértelmezett élettartam. A 12. pont példája is ennyi. */
export const DEFAULT_TTL_MINUTES = 15
/** Ennél hosszabbat az adatbázis sem fogad el (lásd a 0059-es áttérést). */
export const MAX_TTL_MINUTES = 24 * 60

/** A jegy két része: azonosító és titok. A pont elválasztja őket. */
const SHAPE = /^([0-9a-f]{16})\.([A-Za-z0-9_-]{22,})\.([A-Za-z0-9_-]{22,})$/

function secret (): string {
  // Ugyanaz a titok, ami a tokeneket is aláírja. Külön kulcs csak akkor
  // lenne indokolt, ha a jegy más bizalmi körbe tartozna — nem tartozik.
  const value = process.env.JWT_SECRET
  if (!value) throw new Error('JWT_SECRET hiányzik — mentességi jegy nem adható ki')
  return value
}

function sign (id: string, nonce: string): string {
  return createHmac('sha256', secret()).update(`${id}.${nonce}`).digest('base64url')
}

export function hashToken (token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Az aláírás ellenőrzése — adatbázis NÉLKÜL.
 *
 * Ez a szűrő fut minden kérésen, amin van jegy. Egy találomra beírt érték itt
 * elbukik, és nem terheli az adatbázist.
 *
 * `timingSafeEqual`, mert az összehasonlítás ideje is információ: egy naiv
 * `===` elárulná, hány karakter egyezett.
 */
export function verifySignature (token: string): { id: string, ok: boolean } {
  const match = SHAPE.exec(String(token ?? ''))
  if (!match) return { id: '', ok: false }
  const [, id, nonce, mac] = match as unknown as [string, string, string, string]
  let expected: string
  try { expected = sign(id, nonce) } catch { return { id, ok: false } }
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return { id, ok: false }
  return { id, ok: timingSafeEqual(a, b) }
}

export interface IssuedToken {
  /** A jegy — EZT EGYSZER látja a kiállító, utána sehol nem érhető el. */
  token: string
  id: string
  scope: Scope
  expiresAt: Date
  label: string
}

/**
 * Új jegy kiállítása.
 *
 * Az élettartam felülről korlátos, és ezt az adatbázis is betartatja: egy
 * elrontott felület sem tud örök jegyet létrehozni.
 */
export async function issue (input: {
  actorId: string | null
  label?: string | undefined
  scope?: string | undefined
  minutes?: number | undefined
}): Promise<IssuedToken> {
  const minutes = Math.max(1, Math.min(MAX_TTL_MINUTES, Math.floor(input.minutes ?? DEFAULT_TTL_MINUTES)))
  const id = randomBytes(8).toString('hex')
  const nonce = randomBytes(24).toString('base64url')
  const token = `${id}.${nonce}.${sign(id, nonce)}`
  const scope = parseScope(input.scope)
  const expiresAt = new Date(Date.now() + minutes * 60_000)

  await insertBypass({
    tokenHash: hashToken(token),
    label: String(input.label ?? '').slice(0, 120),
    scope,
    actorId: input.actorId,
    expiresAt
  })

  return { token, id, scope, expiresAt, label: String(input.label ?? '') }
}

export interface BypassCheck {
  valid: boolean
  scope: Scope | null
  /** Miért nem érvényes — NAPLÓBA való, nem a hívónak. */
  reason: string
}

/**
 * Érvényes-e a jegy, és mire szól.
 *
 * A sorrend szándékos: előbb az olcsó aláírás-ellenőrzés, csak utána az
 * adatbázis. A használat rögzítése LEGJOBB SZÁNDÉK SZERINT megy — egy
 * elhasalt számláló nem érvénytelenítheti a jegyet.
 */
export async function check (token: string | undefined, url: string): Promise<BypassCheck> {
  if (!token) return { valid: false, scope: null, reason: 'nincs jegy' }

  const signature = verifySignature(token)
  if (!signature.ok) return { valid: false, scope: null, reason: 'hibás aláírás' }

  let row: { scope: string, expires_at: Date, revoked_at: Date | null } | null = null
  try {
    row = await findBypass(hashToken(token))
  } catch (error) {
    /*
     * ADATBÁZIS-HIBA ESETÉN A JEGY NEM ÉRVÉNYES.
     *
     * Ez az egyetlen hely a rendszerben, ahol a hiba ZÁRÁS felé dönt, és
     * szándékosan: a visszavonhatóság csak akkor jelent bármit, ha a
     * visszavonás állapotát meg tudjuk nézni. Egy „az adatbázis nem elérhető,
     * tehát elfogadom" szabály mellett egy kiszivárgott jegyet nem lehetne
     * kizárni azzal, hogy visszavonjuk.
     *
     * Az adminok így sem esnek kívül: a helyreállítási útvonalak jegy nélkül
     * is nyitva vannak (lásd `policy.ts`).
     */
    return { valid: false, scope: null, reason: `a jegy nem ellenőrizhető: ${(error as Error).message}` }
  }

  if (!row) return { valid: false, scope: null, reason: 'ismeretlen jegy' }
  if (row.revoked_at) return { valid: false, scope: null, reason: 'visszavont jegy' }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { valid: false, scope: null, reason: 'lejárt jegy' }

  const scope = parseScope(row.scope)
  // A hatókör SZŰKÍT: egy `player` hatókörű jegy nem nyitja ki az egész
  // oldalt. A `global` jegy mindenre jó.
  if (scope !== 'global' && !scopeMatches(scope, url)) {
    return { valid: false, scope, reason: `a jegy hatóköre (${scope}) nem erre az útvonalra szól` }
  }

  void touchBypass(hashToken(token)).catch(() => { /* a számláló nem érvényesség */ })

  return { valid: true, scope, reason: 'érvényes' }
}

/** Visszavonás. Azonnal hat: a következő ellenőrzés már elutasítja. */
export async function revoke (id: string, actorId: string | null): Promise<boolean> {
  const done = await revokeBypass(id)
  if (done) {
    void recordEvent({
      action: 'maintenance.bypass_revoked', actorId, before: null, after: { id }, ip: null, subjectId: id
    })
  }
  return done
}

/** Az élő jegyek — az admin felület listájához. A jegy maga sosem jön vissza. */
export async function live (): Promise<Array<Record<string, unknown>>> {
  return liveBypasses()
}

/** Lejárt és visszavont jegyek takarítása. A worker hívja. */
export async function prune (): Promise<number> {
  return pruneBypasses()
}
