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

export async function handleMaintenanceJob (_job: Job): Promise<void> {
  // Spent and expired handshake tickets. Short-lived by design, so this only
  // stops the table growing without bound.
  await query('DELETE FROM ws_tickets WHERE expires_at < now() - interval \'1 hour\'')

  await ensurePartitions()
  await pruneExpired()
  await pruneDoneJobs()
}
