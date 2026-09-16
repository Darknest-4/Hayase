// Az él eseménynaplója.
//
// A MEGLÉVŐ `security_logs` táblába ír, nem egy újba. Ott már benne van a
// hitelesítés tíz eseménytípusa és hatezer sor; egy második napló azt
// jelentené, hogy a „mi történt ezzel az IP-vel" kérdésre két helyen kell
// keresni, és egyikben sincs meg az egész.
//
// KÉT SZINT, mert két különböző kérdést szolgálnak ki:
//
//   security_logs    ami egy operátort érdekel: tiltás, WAF-találat, sorozatos
//                    sikertelen belépés. Ritka, hosszan él, IP-vel (harminc
//                    napig — lásd a megőrzést).
//   edge_decisions   minden nem-ALLOW döntés, a jelek pontszámaival. Sűrű,
//                    particionált, rövid életű. Ebből derül ki UTÓLAG, hogy
//                    egy küszöb jó helyen van-e.
//
// EGYIK SEM A KÉRÉSI ÚTON ÍR. A puffer memóriában gyűlik és kötegben megy ki,
// ugyanúgy, mint a látogatottságnál: kétszáz kérés/mp mellett kétszáz plusz
// tranzakció másodpercenként azt jelentené, hogy a biztonsági réteg maga lesz
// a lassulás oka.

import { query } from '../../infrastructure/database/index.ts'

import type { Action } from './config.ts'
import type { Signal } from './risk.ts'

export interface DecisionRecord {
  at: Date
  ip: string | null
  userId: string | null
  route: string | null
  method: string
  action: Action
  score: number
  signals: Signal[]
  rule: string | null
}

export interface SecurityRecord {
  userId: string | null
  event: string
  ip: string | null
  userAgent: string | null
  route: string | null
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  metadata?: Record<string, unknown>
}

const decisions: DecisionRecord[] = []
const security: SecurityRecord[] = []

const MAX_BUFFER = Number(process.env.EDGE_EVENT_BUFFER ?? 500)
const FLUSH_MS = Number(process.env.EDGE_EVENT_FLUSH_MS ?? 5_000)
let timer: NodeJS.Timeout | undefined

function schedule (): void {
  if (timer) return
  timer = setTimeout(() => { void flush() }, FLUSH_MS)
  timer.unref()
}

/** Egy döntés feljegyzése. Nem vár semmire. */
export function recordDecision (record: DecisionRecord): void {
  // Az `allow` nem érdekes: az a forgalom kilencvenkilenc százaléka, és
  // eltárolva percenként több tízezer sor lenne semmiért.
  if (record.action === 'allow') return
  decisions.push(record)
  if (decisions.length >= MAX_BUFFER) void flush(); else schedule()
}

/** Egy biztonsági esemény feljegyzése. */
export function recordSecurity (record: SecurityRecord): void {
  security.push(record)
  if (security.length >= MAX_BUFFER) void flush(); else schedule()
}

/**
 * A pufferek kiírása.
 *
 * Egy elhasalt kiírás nem dob: a naplózás hibája nem ronthatja el azt, amit a
 * réteg egyébként helyesen csinált. A köteg elveszik, és ezt naplózzuk — de a
 * kérés, ami közben ment, nem tud róla.
 */
export async function flush (): Promise<{ decisions: number, security: number }> {
  if (timer) { clearTimeout(timer); timer = undefined }

  const batchDecisions = decisions.splice(0)
  const batchSecurity = security.splice(0)
  if (!batchDecisions.length && !batchSecurity.length) return { decisions: 0, security: 0 }

  try {
    if (batchDecisions.length) {
      await query(
        `INSERT INTO edge_decisions (at, ip, user_id, route, method, action, score, signals, rule)
         SELECT * FROM unnest(
           $1::timestamptz[], $2::inet[], $3::uuid[], $4::text[], $5::text[],
           $6::text[], $7::smallint[], $8::jsonb[], $9::text[])`,
        [
          batchDecisions.map(d => d.at),
          batchDecisions.map(d => d.ip),
          batchDecisions.map(d => d.userId),
          batchDecisions.map(d => d.route),
          batchDecisions.map(d => d.method),
          batchDecisions.map(d => d.action),
          batchDecisions.map(d => d.score),
          // A jelek a pontszámaikkal: ebből lehet utólag megmondani, MIÉRT
          // lett valaki blokkolva. Egy puszta pontszám erre nem válasz.
          batchDecisions.map(d => JSON.stringify(
            Object.fromEntries(d.signals.map(s => [s.key, s.points])))),
          batchDecisions.map(d => d.rule)
        ]
      )
    }

    if (batchSecurity.length) {
      await query(
        `INSERT INTO security_logs (user_id, event, ip, user_agent, route, severity, metadata)
         SELECT * FROM unnest(
           $1::uuid[], $2::text[], $3::inet[], $4::text[], $5::text[], $6::text[], $7::jsonb[])`,
        [
          batchSecurity.map(s => s.userId),
          batchSecurity.map(s => s.event),
          batchSecurity.map(s => s.ip),
          // A böngészőazonosítót megvágjuk: egy több kilobájtos fejléc
          // hatezer soron át nem napló, hanem tárhely.
          batchSecurity.map(s => s.userAgent?.slice(0, 500) ?? null),
          batchSecurity.map(s => s.route),
          batchSecurity.map(s => s.severity),
          batchSecurity.map(s => JSON.stringify(s.metadata ?? {}))
        ]
      )
    }

    return { decisions: batchDecisions.length, security: batchSecurity.length }
  } catch (error) {
    console.error('edge event flush failed:', (error as Error).message)
    return { decisions: 0, security: 0 }
  }
}

/** Leállításkor: ami a pufferben van, még menjen ki. */
export async function drain (): Promise<void> { await flush() }

/** Teszthez: hány esemény vár kiírásra. */
export function pending (): { decisions: number, security: number } {
  return { decisions: decisions.length, security: security.length }
}
