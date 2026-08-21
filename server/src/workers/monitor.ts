// Monitor worker — the only place that collects VPS metrics.
//
// Runs in the worker process (never on the request path) once a minute:
//   collect host gauges + service probes
//     → append raw samples to system_metrics
//     → upsert the current hour into system_metrics_hourly
//     → upsert one row per dependency into service_status
//     → prune raw samples past the retention window
//
// Everything is best-effort: a failing collector degrades to a missing metric,
// it never fails the job or blocks the others.

import { query, queryOne } from '../db.ts'
import { collectHost } from '../lib/metrics.ts'
import { probeAll } from '../lib/probes.ts'

import type { Job } from '../lib/queue.ts'
import type { ProbeResult } from '../lib/probes.ts'

/**
 * Raw-sample retention. Monthly partitions are dropped after a month by the
 * maintenance worker as a backstop; this row-level prune is the fine-grained
 * policy. Hourly rollups keep the long-range history.
 */
const RETENTION_DAYS = Number(process.env.METRICS_RETENTION_DAYS ?? 7)
const HOURLY_RETENTION_DAYS = Number(process.env.METRICS_HOURLY_RETENTION_DAYS ?? 365)

export interface Sample { metric: string, value: number, unit: string }

/** Flatten a host reading plus probe results into storable samples. */
export function toSamples (host: Awaited<ReturnType<typeof collectHost>>, probes: ProbeResult[], queue: { pending: number, dead: number }): Sample[] {
  const samples: Sample[] = []
  const add = (metric: string, value: number | null | undefined, unit: string): void => {
    if (value === null || value === undefined || !Number.isFinite(value)) return
    samples.push({ metric, value, unit })
  }

  add('cpu.usage_pct', host.cpuUsagePct, 'pct')
  add('cpu.load1', host.load1, 'ratio')
  add('cpu.load_per_core', host.loadPerCore, 'ratio')
  add('host.uptime_sec', host.uptimeSec, 'sec')

  add('mem.used_pct', host.memory.usedPct, 'pct')
  add('mem.used_bytes', host.memory.usedBytes, 'bytes')
  add('mem.total_bytes', host.memory.totalBytes, 'bytes')
  add('swap.used_pct', host.memory.swapUsedPct, 'pct')

  if (host.disk) {
    add('disk.used_pct', host.disk.usedPct, 'pct')
    add('disk.used_bytes', host.disk.usedBytes, 'bytes')
    add('disk.total_bytes', host.disk.usedBytes + host.disk.freeBytes, 'bytes')
  }
  if (host.diskIo) {
    add('disk.read_bps', host.diskIo.readBps, 'bps')
    add('disk.write_bps', host.diskIo.writeBps, 'bps')
    add('disk.iops', host.diskIo.iops, 'count')
    add('disk.await_ms', host.diskIo.awaitMs, 'ms')
  }
  if (host.network) {
    add('net.rx_bps', host.network.rxBps, 'bps')
    add('net.tx_bps', host.network.txBps, 'bps')
    add('net.drop_pct', host.network.dropPct, 'pct')
  }
  add('net.latency_ms', host.netLatencyMs, 'ms')

  // service latencies worth charting over time
  for (const probe of probes) {
    if (probe.latencyMs === null) continue
    if (probe.service === 'api') add('api.latency_ms', probe.latencyMs, 'ms')
    else if (probe.service === 'postgres') add('db.latency_ms', probe.latencyMs, 'ms')
  }

  add('queue.pending', queue.pending, 'count')
  add('queue.dead', queue.dead, 'count')
  return samples
}

async function queueDepth (): Promise<{ pending: number, dead: number }> {
  const row = await queryOne<{ pending: string, dead: string }>(
    `SELECT count(*) FILTER (WHERE done_at IS NULL AND run_at <= now() AND attempts < max_attempts) AS pending,
            count(*) FILTER (WHERE done_at IS NULL AND attempts >= max_attempts) AS dead
     FROM jobs`
  )
  return { pending: Number(row?.pending ?? 0), dead: Number(row?.dead ?? 0) }
}

async function storeSamples (samples: Sample[]): Promise<void> {
  if (!samples.length) return
  // one multi-row insert; arrays keep the statement small and plan-cacheable
  await query(
    `INSERT INTO system_metrics (metric, value, unit)
     SELECT * FROM unnest($1::text[], $2::numeric[], $3::text[])`,
    [samples.map(s => s.metric), samples.map(s => s.value), samples.map(s => s.unit)]
  )
}

/** Upsert the current hour's aggregate. Idempotent — safe to run every cycle. */
async function rollupCurrentHour (): Promise<void> {
  await query(
    `INSERT INTO system_metrics_hourly (hour, metric, avg_value, min_value, max_value, samples)
     SELECT date_trunc('hour', created_at) AS hour, metric,
            avg(value), min(value), max(value), count(*)
     FROM system_metrics
     WHERE created_at >= date_trunc('hour', now())
     GROUP BY 1, 2
     ON CONFLICT (hour, metric) DO UPDATE SET
       avg_value = excluded.avg_value, min_value = excluded.min_value,
       max_value = excluded.max_value, samples = excluded.samples`
  )
}

async function storeServiceStatus (probes: ProbeResult[]): Promise<void> {
  for (const probe of probes) {
    // `since` only moves when the status actually changes, so alerting can ask
    // "how long has this been red?" without a separate state table.
    await query(
      `INSERT INTO service_status (service, status, latency_ms, detail, checked_at, since)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (service) DO UPDATE SET
         status = excluded.status,
         latency_ms = excluded.latency_ms,
         detail = excluded.detail,
         checked_at = now(),
         since = CASE WHEN service_status.status = excluded.status THEN service_status.since ELSE now() END`,
      [probe.service, probe.status, probe.latencyMs, probe.detail]
    )
  }
}

async function pruneOldSamples (): Promise<void> {
  await query(`DELETE FROM system_metrics WHERE created_at < now() - make_interval(days => $1)`, [RETENTION_DAYS])
  await query(`DELETE FROM system_metrics_hourly WHERE hour < now() - make_interval(days => $1)`, [HOURLY_RETENTION_DAYS])
}

/** One collection cycle. Returns the samples written (useful in tests). */
export async function collectOnce (): Promise<Sample[]> {
  const [host, probes, queue] = await Promise.all([collectHost(), probeAll(), queueDepth()])
  const samples = toSamples(host, probes, queue)

  await storeSamples(samples)
  await storeServiceStatus(probes)
  await rollupCurrentHour()
  return samples
}

export async function handleMonitorJob (_job: Job): Promise<void> {
  await collectOnce()
  // pruning is cheap and idempotent; doing it here keeps retention working
  // even if the hourly maintenance job is behind
  await pruneOldSamples()
}
