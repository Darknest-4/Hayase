// Maintenance worker: creates upcoming partitions for the time-partitioned
// event tables and prunes expired data per the retention policy
// (docs/database.md).

import { query } from '../db.ts'
import { pruneDoneJobs } from '../lib/queue.ts'

import type { Job } from '../lib/queue.ts'

const PARTITIONED = [
  { table: 'watch_history', column: 'started_at', retentionMonths: null },
  { table: 'messages', column: 'created_at', retentionMonths: null },
  { table: 'extension_events', column: 'created_at', retentionMonths: 3 },
  { table: 'page_views', column: 'created_at', retentionMonths: 3 },
  { table: 'search_stats', column: 'created_at', retentionMonths: 3 },
  { table: 'performance_metrics', column: 'created_at', retentionMonths: 3 },
  { table: 'audit_logs', column: 'created_at', retentionMonths: null },
  { table: 'error_logs', column: 'created_at', retentionMonths: 1 },
  // raw VPS samples: the monitor worker prunes rows at day granularity;
  // dropping month-old partitions is the backstop if it stops running
  { table: 'system_metrics', column: 'created_at', retentionMonths: 1 }
] as const

/**
 * Tables that are not partitioned but still must not grow forever.
 *
 * `security_logs` is the one that matters: it records an IP address and a
 * user-agent for every sign-in, failed password and ban, and nothing ever
 * deleted a row. Keeping years of them is a liability, not an asset — the
 * questions they answer ("was this account attacked last week") are all
 * recent ones.
 *
 * A DELETE rather than a partition drop, because this table is small enough
 * that the simpler thing is the right thing, and partitioning it now would
 * mean a migration that moves live security data.
 */
const PRUNED = [
  { table: 'security_logs', column: 'created_at', retentionDays: Number(process.env.SECURITY_LOG_RETENTION_DAYS ?? 90) }
] as const

function monthStart (offsetMonths: number): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1))
}

const partitionName = (table: string, date: Date): string =>
  `${table}_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`

const iso = (date: Date): string => date.toISOString().slice(0, 10)

export async function ensurePartitions (): Promise<string[]> {
  const created: string[] = []
  for (const { table } of PARTITIONED) {
    // current month + two ahead, so a stalled worker never blocks inserts
    for (const offset of [0, 1, 2]) {
      const from = monthStart(offset)
      const to = monthStart(offset + 1)
      const name = partitionName(table, from)
      const exists = await query(`SELECT 1 FROM pg_class WHERE relname = $1`, [name])
      if (exists.length) continue
      await query(`CREATE TABLE ${name} PARTITION OF ${table} FOR VALUES FROM ('${iso(from)}') TO ('${iso(to)}')`)
      created.push(name)
    }
  }
  return created
}

export async function pruneExpired (): Promise<string[]> {
  const dropped: string[] = []
  for (const { table, retentionMonths } of PARTITIONED) {
    if (!retentionMonths) continue
    // drop partitions strictly older than the retention window
    const cutoff = monthStart(-retentionMonths)
    const partitions = await query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = $1`,
      [table]
    )
    for (const { relname } of partitions) {
      const match = relname.match(/_(\d{4})_(\d{2})$/)
      if (!match) continue
      const partDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
      // keep the partition if any part of its month is inside retention
      if (partDate < cutoff && Date.UTC(partDate.getUTCFullYear(), partDate.getUTCMonth() + 1, 1) <= +cutoff) {
        await query(`DROP TABLE ${relname}`)
        dropped.push(relname)
      }
    }
  }
  return dropped
}

/** Delete expired rows from the tables that are pruned rather than partitioned. */
export async function pruneRows (): Promise<Array<{ table: string, deleted: number }>> {
  const results: Array<{ table: string, deleted: number }> = []
  for (const { table, column, retentionDays } of PRUNED) {
    // 0 disables pruning, for an operator who must keep everything for their
    // own compliance reasons. A deliberate choice, not the default.
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) continue
    const rows = await query<{ id: number }>(
      `DELETE FROM ${table} WHERE ${column} < now() - ($1 || ' days')::interval RETURNING 1 AS id`,
      [String(Math.floor(retentionDays))]
    )
    if (rows.length) results.push({ table, deleted: rows.length })
  }
  return results
}

export async function handleMaintenanceJob (_job: Job): Promise<void> {
  // Spent and expired handshake tickets. Short-lived by design, so this only
  // stops the table growing without bound.
  await query('DELETE FROM ws_tickets WHERE expires_at < now() - interval \'1 hour\'')

  await ensurePartitions()
  await pruneExpired()
  await pruneRows()
  await pruneDoneJobs()
}
