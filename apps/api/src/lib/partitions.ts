// The month partitions for the time-partitioned event tables.
//
// This lives in lib/ rather than in the maintenance worker because two callers
// need it and only one of them is a worker. The migration runner calls it as
// its last step; the hourly maintenance job calls it to stay ahead.
//
// Why the migration runner has to: every partitioned table is created by a
// migration that also creates its first partitions, and those are written as
// literal months — `audit_logs_2026_07`, `audit_logs_2026_08`. A migration is
// a fixed text, so it cannot know what month it is being applied in. Once the
// wall clock passed the last hardcoded month, a freshly migrated database had
// no partition covering `now()` and the first INSERT into audit_logs failed:
//
//   no partition of relation "audit_logs" found for row
//
// Registration writes an audit row inside its transaction, so the visible
// symptom was that nobody could create an account on a new deployment — 500,
// from a schema that had just been applied without an error. CI showed the
// same failure against its own clean database.
//
// Creating the partitions here makes `npm run migrate` leave behind a database
// that can actually be written to, which is what applying a schema is for.

import { query } from '../infrastructure/database/index.ts'

/**
 * The partitioned tables and how long their data is kept.
 *
 * `retentionMonths: null` means keep forever — those are the tables holding
 * user-visible history or an audit trail, which are not ours to expire.
 */
export const PARTITIONED = [
  { table: 'watch_history', column: 'started_at', retentionMonths: null },
  { table: 'messages', column: 'created_at', retentionMonths: null },
  { table: 'page_views', column: 'created_at', retentionMonths: 3 },
  { table: 'search_stats', column: 'created_at', retentionMonths: 3 },
  { table: 'performance_metrics', column: 'created_at', retentionMonths: 3 },
  { table: 'audit_logs', column: 'created_at', retentionMonths: null },
  { table: 'error_logs', column: 'created_at', retentionMonths: 1 },
  // raw VPS samples: the monitor worker prunes rows at day granularity;
  // dropping month-old partitions is the backstop if it stops running
  { table: 'system_metrics', column: 'created_at', retentionMonths: 1 }
] as const

export function monthStart (offsetMonths: number): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1))
}

export const partitionName = (table: string, date: Date): string =>
  `${table}_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`

const iso = (date: Date): string => date.toISOString().slice(0, 10)

/**
 * Make sure this month and the next two have somewhere to put a row.
 *
 * Two ahead rather than one so a worker that stops running does not take the
 * site down at the turn of a month — it takes three to do that, which is long
 * enough to notice.
 *
 * Safe to call concurrently with itself: two app replicas starting together
 * both migrate, and the loser of the race would otherwise fail on a duplicate
 * relation. The existence check narrows the window and `IF NOT EXISTS` closes
 * it.
 *
 * A table that does not exist yet is skipped rather than failing. The
 * partitioned tables arrive across several migrations, and a caller should not
 * have to know which ones have run.
 */
export async function ensurePartitions (): Promise<string[]> {
  const created: string[] = []
  for (const { table } of PARTITIONED) {
    const parent = await query('SELECT 1 FROM pg_class WHERE relname = $1', [table])
    if (!parent.length) continue
    for (const offset of [0, 1, 2]) {
      const from = monthStart(offset)
      const to = monthStart(offset + 1)
      const name = partitionName(table, from)
      const exists = await query('SELECT 1 FROM pg_class WHERE relname = $1', [name])
      if (exists.length) continue
      await query(`CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${table} FOR VALUES FROM ('${iso(from)}') TO ('${iso(to)}')`)
      created.push(name)
    }
  }
  return created
}
