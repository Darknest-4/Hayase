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

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { evaluate, pruneResolvedAlerts } from './alerts.ts'
import { formatReport, runDiagnostics } from './diagnostics.ts'
import { collectHost } from '../../infrastructure/observability/host-metrics.ts'
import { probeEdge, type EdgeProbeResult } from './edge-probe.ts'
import { probeAll } from '../../infrastructure/observability/probes.ts'
import { compare, thresholds } from './thresholds.ts'

import type { Reading } from './alerts.ts'
import type { Job } from '../../infrastructure/queue/index.ts'
import type { ProbeResult } from '../../infrastructure/observability/probes.ts'
import type { MetricKey } from './thresholds.ts'

/**
 * Raw-sample retention. Monthly partitions are dropped after a month by the
 * maintenance worker as a backstop; this row-level prune is the fine-grained
 * policy. Hourly rollups keep the long-range history.
 */
const RETENTION_DAYS = Number(process.env.METRICS_RETENTION_DAYS ?? 7)
const HOURLY_RETENTION_DAYS = Number(process.env.METRICS_HOURLY_RETENTION_DAYS ?? 365)

export interface Sample { metric: string, value: number, unit: string }

/** Flatten a host reading plus probe results into storable samples. */
export function toSamples (
  host: Awaited<ReturnType<typeof collectHost>>,
  probes: ProbeResult[],
  queue: { pending: number, dead: number },
  backupAge: number | null = null,
  /*
   * A KÜLSŐ szonda eredménye. Leolvasásként érkezik, nem itt készül: a
   * `toSamples` tiszta függvény, és egy hálózati hívás abban azt jelentené,
   * hogy a mérőszám-összeállítás tesztelhetetlen és lassú lesz.
   */
  edge: EdgeProbeResult | null = null
): Sample[] {
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
  add('backup.age_hours', backupAge, 'hours')

  /*
   * AZ OLDAL KÍVÜLRŐL. Külön az `api.latency_ms`-től, és ez a különbség a
   * lényeg: az belülről kérdezi meg az alkalmazást, ez a fordított proxyn
   * keresztül az egész utat méri.
   *
   * Egy valódi kiesésből nőtt ki: az `app` minden jelzője zöld volt, az
   * `api.latency_ms` rendben, és közben a látogatók harminc másodpercig 503-at
   * kaptak, mert a Caddy leírta az upstreamet. A monitorozás ezt nem látta.
   */
  if (edge) {
    add('edge.status', edge.status, 'bool')
    add('edge.down_streak', edge.downStreak, 'count')
    if (edge.latencyMs !== null) add('edge.latency_ms', edge.latencyMs, 'ms')
    if (edge.outcome !== 'healthy') {
      // A FAJTÁJA is kell, nem csak az, hogy nem megy: a névfeloldás, a
      // kapcsolat, a TLS és a HTTP-válasz más-más beavatkozást kíván.
      console.error(`az oldal kívülről nem elérhető (${edge.outcome}): ${edge.detail ?? ''}`)
    }
  }

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

/**
 * Hány órája készült a legutóbbi ELLENŐRZÖTT mentés.
 *
 * A mentés volt az egyetlen rendszer, aminek a leállását semmi nem vette
 * észre: éjszakánként futott, ellenőrizte magát, és ha egy éjjel kimaradt,
 * arról pontosan addig nem szerzett tudomást senki, amíg vissza nem kellett
 * állítani valamit.
 *
 * `null`, ha egyetlen ellenőrzött mentés sincs — az nem nulla óra, hanem
 * hiányzó mérés, és a `toSamples` a hiányzó mérést kihagyja ahelyett, hogy
 * nullát mondana. Egy friss telepítés ne riasszon azért, mert még nem futott
 * le az első éjszakája.
 */
async function backupAgeHours (): Promise<number | null> {
  try {
    const row = await queryOne<{ hours: number | null }>(
      `SELECT extract(epoch FROM now() - max(taken_at)) / 3600 AS hours
         FROM backups WHERE verified`
    )
    const hours = row?.hours
    return hours === null || hours === undefined ? null : Number(hours)
  } catch {
    // A tábla hiányozhat egy régebbi telepítésen. Az nem riasztás.
    return null
  }
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

/**
 * Turn this cycle's readings into alert inputs. A metric only becomes a reading
 * when it has a documented threshold; services map their colour directly.
 */
export async function toReadings (samples: Sample[], probes: ProbeResult[]): Promise<Reading[]> {
  const active = await thresholds()
  const readings: Reading[] = []

  for (const sample of samples) {
    const threshold = active[sample.metric as MetricKey]
    if (!threshold) continue
    const level = compare(sample.value, threshold)
    readings.push({
      subject: sample.metric,
      kind: 'metric',
      severity: level === 'red' ? 'critical' : level === 'yellow' ? 'warning' : null,
      value: sample.value,
      threshold: level === 'red' ? threshold.crit : threshold.warn
    })
  }

  for (const probe of probes) {
    // An unconfigured service counts as healthy rather than being skipped: it
    // is not a problem, and reporting it lets any alert left over from when it
    // WAS configured resolve instead of hanging open forever.
    readings.push({
      subject: `service:${probe.service}`,
      kind: 'service',
      severity: probe.status === 'red' ? 'critical' : probe.status === 'yellow' ? 'warning' : null,
      value: probe.latencyMs ?? null,
      detail: probe.detail ?? null
    })
  }

  return readings
}

/** One collection cycle. Returns the samples written (useful in tests). */
export async function collectOnce (): Promise<Sample[]> {
  /*
   * A külső szonda a többi leolvasással PÁRHUZAMOSAN fut. Egy tíz másodperces
   * időtúllépés sorosan azt jelentené, hogy a lassú válasz feltartja a teljes
   * mérési ciklust — és pont akkor maradnánk mérőszám nélkül, amikor baj van.
   */
  const [host, probes, queue, backupAge, edge] = await Promise.all([
    collectHost(), probeAll(), queueDepth(), backupAgeHours(), probeEdge()
  ])
  const samples = toSamples(host, probes, queue, backupAge, edge)

  await storeSamples(samples)
  await storeServiceStatus(probes)
  await rollupCurrentHour()

  // alerting runs on the same readings that were just stored, so what fires
  // always matches what the dashboard shows
  await evaluate(await toReadings(samples, probes))
  return samples
}

/** Execute a requested diagnostic run and store its report. */
export async function runDiagnosticJob (runId: string): Promise<void> {
  try {
    const report = await runDiagnostics()
    await query(
      `UPDATE diagnostic_runs
       SET status = 'completed', finished_at = now(), passed = $2, warned = $3, failed = $4, results = $5::jsonb
       WHERE id = $1`,
      [runId, report.passed, report.warned, report.failed, JSON.stringify(report.results)]
    )
    console.log(formatReport(report))
  } catch (error) {
    await query(
      `UPDATE diagnostic_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
      [runId, (error as Error).message.slice(0, 500)]
    )
    throw error
  }
}

export async function handleMonitorJob (job: Job): Promise<void> {
  // the same queue carries the periodic collection and one-off diagnostics
  const diagnosticId = job.payload.diagnosticId
  if (typeof diagnosticId === 'string') {
    await runDiagnosticJob(diagnosticId)
    return
  }

  await collectOnce()
  // pruning is cheap and idempotent; doing it here keeps retention working
  // even if the hourly maintenance job is behind
  await pruneOldSamples()
  await pruneResolvedAlerts()
}
