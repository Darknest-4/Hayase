/**
 * Szolgáltatói mérőszámok — a kérési úton kívül, kötegelve.
 *
 * MIÉRT NEM ÍRUNK KÖZVETLENÜL. Egy feloldás három kísérletet is jelenthet, és
 * minden kísérlet egy adatbázis-írás lenne a néző kérésének a közepén. A
 * látogatottsági gyűjtő ugyanezt a leckét már megtanulta (`analytics/
 * collector.ts`): a mérés nem lehet a lassulás oka. Itt is memóriában gyűlik,
 * és kötegben megy ki.
 *
 * AMIT EGY ÖSSZEOMLÁS ELVISZ: néhány másodpercnyi statisztika. Ez a helyes
 * csere — egy kimutatás pontatlansága nem baj, egy lassú lejátszás az.
 *
 * A SZÁMLÁLÓK ÖSSZEADÓDNAK az adatbázisban, mert a memóriában DELTA gyűlik,
 * nem állapot. Ezért a puffer a kiírás ELŐTT ürül ki: ha az írás elhasal, a
 * köteg elveszik — de nem íródik ki kétszer. A duplázás rosszabb hiba, mint a
 * hiányzás: egy hiányzó köteg csak pontatlan, egy duplázott hazudik.
 */

import { query } from '../../infrastructure/database/index.ts'

import type { Attempt } from './resolve.ts'

/** Meddig gyűlhet, mielőtt kimegy. Amelyik előbb betelik. */
const MAX_KEYS = Number(process.env.PROVIDER_METRICS_BUFFER ?? 200)
const FLUSH_MS = Number(process.env.PROVIDER_METRICS_FLUSH_MS ?? 15_000)

interface Cell {
  attempts: number
  sources: number
  latencySum: number
  latencyMax: number
}

/** Kulcs: `nap|szolgáltató|kimenet`. */
const buffer = new Map<string, Cell>()
let timer: NodeJS.Timeout | undefined

/** A nap UTC-ben. A tárolás UTC, a megjelenítés a kliens dolga. */
function dayOf (at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * Egy feloldás kísérleteinek felvétele.
 *
 * Nem ír adatbázisba és nem vár semmire. A hívó (`resolve.ts`) számára ez egy
 * `void` hívás a válasz visszaadása előtt — nem lassítja meg.
 */
export function recordAttempts (attempts: readonly Attempt[], at: Date = new Date()): void {
  if (!attempts.length) return
  const day = dayOf(at)

  for (const attempt of attempts) {
    const key = `${day}|${attempt.provider}|${attempt.outcome}`
    const cell = buffer.get(key)
    const ms = Number.isFinite(attempt.ms) ? Math.max(0, Math.round(attempt.ms)) : 0
    const sources = Number.isFinite(attempt.sources) ? Math.max(0, attempt.sources) : 0
    if (cell) {
      cell.attempts++
      cell.sources += sources
      cell.latencySum += ms
      if (ms > cell.latencyMax) cell.latencyMax = ms
    } else {
      buffer.set(key, { attempts: 1, sources, latencySum: ms, latencyMax: ms })
    }
  }

  if (buffer.size >= MAX_KEYS) void flush()
  else if (!timer) timer = setTimeout(() => { void flush() }, FLUSH_MS).unref()
}

/**
 * A köteg kiírása — EGYETLEN többsoros utasításban.
 *
 * Soronkénti `INSERT` helyett `unnest`: száz kulcs száz körbefordulás lenne az
 * adatbázishoz, így egy. A `latency_ms_max` `GREATEST`-tel frissül, mert a
 * maximum nem összeadódik.
 */
export async function flush (): Promise<number> {
  if (timer) { clearTimeout(timer); timer = undefined }
  if (!buffer.size) return 0

  // A PUFFER ELŐBB ÜRÜL. Lásd a fájl fejlécét: a duplázás rosszabb, mint a
  // hiányzás, és egy párhuzamos `recordAttempts` így új kötegbe gyűlik.
  const batch = [...buffer.entries()]
  buffer.clear()

  const days: string[] = []
  const slugs: string[] = []
  const outcomes: string[] = []
  const attempts: number[] = []
  const sources: number[] = []
  const sums: number[] = []
  const maxes: number[] = []

  for (const [key, cell] of batch) {
    const [day, slug, outcome] = key.split('|')
    if (!day || !slug || !outcome) continue
    days.push(day); slugs.push(slug); outcomes.push(outcome)
    attempts.push(cell.attempts); sources.push(cell.sources)
    sums.push(cell.latencySum); maxes.push(cell.latencyMax)
  }
  if (!days.length) return 0

  await query(
    `INSERT INTO provider_metrics_daily
            (day, slug, outcome, attempts, sources, latency_ms_sum, latency_ms_max)
     SELECT * FROM unnest(
              $1::date[], $2::text[], $3::text[],
              $4::int[], $5::int[], $6::bigint[], $7::int[])
     ON CONFLICT (day, slug, outcome) DO UPDATE
            SET attempts       = provider_metrics_daily.attempts + excluded.attempts,
                sources        = provider_metrics_daily.sources + excluded.sources,
                latency_ms_sum = provider_metrics_daily.latency_ms_sum + excluded.latency_ms_sum,
                latency_ms_max = GREATEST(provider_metrics_daily.latency_ms_max, excluded.latency_ms_max),
                updated_at     = now()`,
    [days, slugs, outcomes, attempts, sources, sums, maxes]
  )
  return days.length
}

/** Teszthez: a puffer állapota kiírás nélkül. */
export function pending (): number {
  return buffer.size
}

/** Teszthez és leálláshoz: eldobás kiírás nélkül. */
export function reset (): void {
  if (timer) { clearTimeout(timer); timer = undefined }
  buffer.clear()
}
