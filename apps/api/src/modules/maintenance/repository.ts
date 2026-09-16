// A karbantartás adatelérése. Itt van MINDEN SQL, és sehol máshol.

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { parseMode, parseScope } from './state.ts'
import { toDate } from './schedule.ts'

import type { MaintenanceConfig } from './policy.ts'

interface Row {
  version: string | number
  mode: string
  scope: string
  enabled: boolean
  starts_at: Date | null
  ends_at: Date | null
  estimated_end_at: Date | null
  timezone: string | null
  title: string | null
  public_message: string | null
  allow_existing_sessions: boolean
  drain_seconds: number
}

/** Sor → beállítás. Sosem dob: egy hibás sorból biztonságos érték lesz. */
export function fromRow (row: Row | null | undefined): MaintenanceConfig | null {
  if (!row) return null
  return {
    enabled: row.enabled === true,
    mode: parseMode(row.mode),
    scope: parseScope(row.scope),
    window: { startsAt: toDate(row.starts_at), endsAt: toDate(row.ends_at) },
    drainSeconds: Number.isFinite(Number(row.drain_seconds)) ? Number(row.drain_seconds) : 0,
    allowExistingSessions: row.allow_existing_sessions === true,
    title: String(row.title ?? ''),
    publicMessage: String(row.public_message ?? ''),
    timezone: row.timezone ?? null,
    version: Number(row.version) || 0
  }
}

/**
 * A jelenleg érvényes beállítás: a LEGFRISSEBB sor.
 *
 * Minden módosítás új sor, tehát a legnagyobb verziószám az érvényes. Ez a
 * lekérdezés indulásonként és értesítésenként fut — NEM kérésenként.
 */
export async function loadCurrent (): Promise<MaintenanceConfig | null> {
  const row = await queryOne<Row>(
    `SELECT version, mode, scope, enabled, starts_at, ends_at, estimated_end_at,
            timezone, title, public_message, allow_existing_sessions, drain_seconds
       FROM maintenance_configs
      ORDER BY version DESC
      LIMIT 1`
  )
  return fromRow(row)
}

export interface SaveInput {
  mode: string
  scope: string
  enabled: boolean
  startsAt: Date | null
  endsAt: Date | null
  estimatedEndAt: Date | null
  timezone: string
  title: string
  publicMessage: string
  allowExistingSessions: boolean
  drainSeconds: number
  actorId: string | null
}

/** Új verzió írása. A régi sorok maradnak — abból lesz a történet. */
export async function save (input: SaveInput): Promise<MaintenanceConfig | null> {
  const row = await queryOne<Row>(
    `INSERT INTO maintenance_configs
       (mode, scope, enabled, starts_at, ends_at, estimated_end_at, timezone,
        title, public_message, allow_existing_sessions, drain_seconds, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING version, mode, scope, enabled, starts_at, ends_at, estimated_end_at,
               timezone, title, public_message, allow_existing_sessions, drain_seconds`,
    [
      input.mode, input.scope, input.enabled,
      input.startsAt, input.endsAt, input.estimatedEndAt, input.timezone,
      input.title, input.publicMessage, input.allowExistingSessions,
      Math.max(0, Math.min(3600, Math.floor(input.drainSeconds))), input.actorId
    ]
  )
  return fromRow(row)
}

/** A verziótörténet, az admin felülethez. */
export async function history (limit = 20): Promise<Array<Record<string, unknown>>> {
  return query<Record<string, unknown>>(
    `SELECT c.version, c.mode, c.scope, c.enabled, c.starts_at, c.ends_at,
            c.title, c.created_at, u.username AS created_by
       FROM maintenance_configs c
       LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.version DESC
      LIMIT $1`,
    [Math.max(1, Math.min(100, Math.floor(limit)))]
  )
}

/**
 * Egy karbantartási esemény az auditnaplóba.
 *
 * Nem külön tábla: az `audit_logs` particionált, indexelt, és pontosan ezt a
 * mezőkészletet kínálja. Lásd a 0059-es áttérés fejlécét.
 */
export async function recordEvent (input: {
  action: string
  actorId: string | null
  before: unknown
  after: unknown
  ip: string | null
  subjectId?: string
}): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, actor_type, action, subject_type, subject_id, before, after, ip)
       VALUES ($1, $2, $3, 'maintenance', $4, $5::jsonb, $6::jsonb, $7::inet)`,
      [
        input.actorId,
        input.actorId ? 'user' : 'system',
        input.action,
        input.subjectId ?? 'global',
        JSON.stringify(input.before ?? null),
        JSON.stringify(input.after ?? null),
        input.ip
      ]
    )
  } catch (error) {
    // Az audit fontos, de nem akadályozhatja meg a karbantartás
    // bekapcsolását: ha valaki vészhelyzetet hirdet, az menjen végbe akkor is,
    // ha a naplózás épp elhasal.
    console.error('a karbantartási esemény naplózása nem sikerült:', (error as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Mentességi jegyek
// ---------------------------------------------------------------------------
//
// A KRIPTOGRÁFIA a `bypass.ts`-ben van, az SQL itt. A kettő szétválasztása
// nem forma kérdése: a modul architektúra-tesztje megköveteli, hogy minden
// lekérdezés a tárban legyen — és a szabály jó, mert így egy helyen látszik,
// mihez nyúl hozzá ez a modul az adatbázisban.

export interface BypassRow {
  scope: string
  expires_at: Date
  revoked_at: Date | null
}

export async function insertBypass (input: {
  tokenHash: string
  label: string
  scope: string
  actorId: string | null
  expiresAt: Date
}): Promise<void> {
  await query(
    `INSERT INTO maintenance_bypass_tokens (token_hash, label, scope, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.tokenHash, input.label, input.scope, input.actorId, input.expiresAt]
  )
}

export async function findBypass (tokenHash: string): Promise<BypassRow | null> {
  return (await queryOne<BypassRow>(
    `SELECT scope, expires_at, revoked_at FROM maintenance_bypass_tokens WHERE token_hash = $1`,
    [tokenHash]
  )) ?? null
}

/** Használat rögzítése. Legjobb szándék szerint — nem érvényesség kérdése. */
export async function touchBypass (tokenHash: string): Promise<void> {
  await query(
    `UPDATE maintenance_bypass_tokens
        SET last_used_at = now(), use_count = use_count + 1
      WHERE token_hash = $1`,
    [tokenHash]
  )
}

export async function revokeBypass (id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE maintenance_bypass_tokens
        SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [id]
  )
  return Boolean(row)
}

export async function liveBypasses (): Promise<Array<Record<string, unknown>>> {
  return query<Record<string, unknown>>(
    `SELECT t.id, t.label, t.scope, t.created_at, t.expires_at, t.last_used_at, t.use_count,
            u.username AS created_by
       FROM maintenance_bypass_tokens t
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.revoked_at IS NULL AND t.expires_at > now()
      ORDER BY t.created_at DESC
      LIMIT 50`
  )
}

/** Lejárt és visszavont jegyek takarítása. A worker hívja. */
export async function pruneBypasses (): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM maintenance_bypass_tokens
      WHERE expires_at < now() - interval '7 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
      RETURNING id`
  )
  return rows.length
}
