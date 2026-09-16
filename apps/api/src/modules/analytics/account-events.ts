// Fiókesemények: mi történt ezzel a fiókkal, sorszámozva.
//
//   REG_000001            SUCCESS
//   LOGIN_000182          SUCCESS
//   LOGIN_000183          FAILED
//   PASSWORD_CHANGE_000012 SUCCESS
//
// Miért nem elég a `security_logs`, ami már megvan: az biztonsági napló,
// nyers IP-vel, szűk hozzáféréssel és rövidebb megőrzéssel — azt a kérdést
// válaszolja meg, hogy „ki próbálkozott". Ez a fiók SAJÁT előzménye: „mi
// történt velem", és ezt a tulajdonosának is meg lehet mutatni. A kettő
// megőrzése és láthatósága is külön, ezért külön tábla.
//
// A hivatkozás (`REG_000001`) nem dísz. Az uuid-t senki nem mondja ki
// hangosan; egy bejelentésben, egy levélben vagy egy telefonban ez a rövid
// szám az, amit idézni lehet — és a sorozat az adatbázisé, tehát két
// egyidejű belépés nem kaphat azonos számot.
//
// AMIT SOHA NEM ÍRUNK IDE: jelszót, jelszókivonatot, hozzáférési vagy
// frissítő tokent, sütit, jegyet, API-kulcsot. A `metadata` azt mondja meg,
// MELYIK mező változott, nem azt, hogy mire.

import { query, queryOne } from '../../infrastructure/database/index.ts'

import type { FastifyRequest } from 'fastify'

export type AccountEvent =
  | 'REG' | 'LOGIN' | 'LOGIN_FAILED' | 'LOGOUT'
  | 'PASSWORD_CHANGE' | 'PASSWORD_RESET_REQUEST' | 'PASSWORD_RESET'
  | 'EMAIL_VERIFY' | 'EMAIL_CHANGE'
  | 'PROFILE_UPDATE' | 'SETTINGS_UPDATE'
  | 'SESSION_CREATED' | 'SESSION_REVOKED' | 'SESSIONS_REVOKED_ALL'
  | 'ACCOUNT_RESTRICTED' | 'ACCOUNT_BANNED' | 'ACCOUNT_UNBANNED' | 'ACCOUNT_DELETE'
  | 'ROLE_GRANTED' | 'ROLE_REVOKED'

export type EventResult = 'success' | 'failed' | 'blocked'

/**
 * Mezők, amiknek soha nincs helyük egy esemény kísérőadatában.
 *
 * Nem udvariassági lista: ez az utolsó védvonal a „gyorsan belerakom a teljes
 * kérés törzsét" ellen, ami minden ilyen naplóban egyszer megtörténik. Ami itt
 * szerepel, az kikerül, akárhogy is került bele.
 */
const FORBIDDEN = /^(password|passwordhash|password_hash|token|accesstoken|access_token|refreshtoken|refresh_token|cookie|secret|ticket|apikey|api_key|authorization|jwt|salt|otp|code)$/i

/** Kiveszi, aminek nincs helye, és megvágja, ami túl hosszú. */
export function sanitise (input: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (FORBIDDEN.test(key)) { out[key] = '[eltávolítva]'; continue }
    if (typeof value === 'string') out[key] = value.slice(0, 500)
    else if (value === null || ['number', 'boolean'].includes(typeof value)) out[key] = value
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map(v => typeof v === 'string' ? v.slice(0, 200) : v)
    else if (typeof value === 'object') out[key] = sanitise(value as Record<string, unknown>)
  }
  return out
}

export interface RecordOptions {
  userId?: string | null
  result?: EventResult
  sessionId?: string | null
  deviceId?: string | null
  requestId?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Egy fiókesemény rögzítése.
 *
 * Legjobb szándék szerint, mint minden telemetria ebben a kódban: egy
 * naplóírás hibája nem ronthatja el azt a műveletet, amit a felhasználó épp
 * elvégzett. Megvárjuk (a sor a válasz előtt landol), de a hibája csak
 * naplózódik.
 */
export async function recordAccountEvent (
  event: AccountEvent,
  options: RecordOptions = {}
): Promise<string | undefined> {
  try {
    const row = await queryOne<{ reference: string }>(
      `INSERT INTO account_events (reference, user_id, event, result, session_id, device_id, request_id, metadata)
       VALUES ($1 || '_' || lpad(nextval('account_event_seq')::text, 6, '0'),
               $2, $1, $3, $4, $5, $6, $7::jsonb)
       RETURNING reference`,
      [
        event,
        options.userId ?? null,
        options.result ?? 'success',
        options.sessionId ?? null,
        options.deviceId ?? null,
        options.requestId?.slice(0, 64) ?? null,
        JSON.stringify(sanitise(options.metadata))
      ]
    )
    return row?.reference
  } catch (error) {
    console.error('account event write failed:', (error as Error).message)
    return undefined
  }
}

/** A kérésből kiolvasható rész, hogy a hívóhelyeknek ne kelljen ismételniük. */
export function fromRequest (request: FastifyRequest): Pick<RecordOptions, 'requestId'> {
  return { requestId: request.id ? String(request.id) : null }
}

export interface AccountEventRow {
  reference: string
  event: string
  result: string
  created_at: string
  request_id: string | null
  metadata: Record<string, unknown>
}

/**
 * Egy fiók előzménye.
 *
 * Kulcsos lapozás, nem OFFSET: egy régi fiók előzménye hosszú, és a
 * századik oldal ugyanannyiba kerüljön, mint az első.
 */
export async function accountHistory (
  userId: string,
  options: { limit?: number, before?: string, event?: string } = {}
): Promise<AccountEventRow[]> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50))
  const params: unknown[] = [userId]
  const where = ['user_id = $1']
  if (options.before) { params.push(options.before); where.push(`created_at < $${params.length}`) }
  if (options.event) { params.push(options.event); where.push(`event = $${params.length}`) }
  params.push(limit)
  return await query<AccountEventRow>(
    `SELECT reference, event, result, created_at, request_id, metadata
       FROM account_events
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  )
}
