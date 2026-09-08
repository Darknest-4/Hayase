// Maintenance worker: creates upcoming partitions for the time-partitioned
// event tables and prunes expired data per the retention policy
// (docs/database.md).

import { query } from './database/index.ts'
// Partition creation is shared with the migration runner, which has to leave a
// freshly applied schema in a writable state rather than waiting for the first
// run of this job. See lib/partitions.ts.
import { PARTITIONED, ensurePartitions, monthStart } from './migrations/partitions.ts'
import { pruneDoneJobs } from './queue/index.ts'

import type { Job } from './queue/index.ts'

export { ensurePartitions }

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
