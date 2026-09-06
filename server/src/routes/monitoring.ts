// Monitoring endpoints.
//
//   publicReadiness → GET /v1/health/ready
//       Cached aggregate of the dependency probes. Deliberately minimal: a
//       service name and a colour, nothing about the host, versions, paths or
//       configuration. Safe for a load balancer to poll.
//
//   adminMonitoring → GET /v1/admin/monitoring/*   (system.metrics.view)
//       Full VPS detail for administrators only.
//
// Neither endpoint collects anything: the monitor worker owns collection and
// these read the last stored snapshot, so polling them is cheap.

import { query, queryOne } from '../db.ts'
import { activeAlerts, alertHistory } from '../lib/alerts.ts'
import { isRunning } from '../lib/diagnostics.ts'
import { overall, probeAll } from '../lib/probes.ts'
import { enqueue } from '../lib/queue.ts'
import { compare, thresholds, worst } from '../lib/thresholds.ts'

import type { Level, MetricKey, Threshold } from '../lib/thresholds.ts'
import type { FastifyPluginAsync } from 'fastify'

/** Readiness is cached so health polling can never stampede the dependencies. */
const READY_CACHE_MS = Number(process.env.READY_CACHE_MS ?? 5000)
let readyCache: { at: number, body: ReadyBody } | undefined

/**
 * How old the newest sample may be before the dashboard treats the snapshot as
 * stale. Three collection cycles at the default 60s cadence — long enough to
 * ride out one slow cycle, short enough to notice a dead worker quickly.
 */
const STALE_AFTER_MS = Number(process.env.MONITOR_STALE_AFTER_MS ?? 180_000)

interface ReadyBody {
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  services: Array<{ name: string, status: string }>
  checkedAt: string
}

export const publicReadiness: FastifyPluginAsync = async fastify => {
  fastify.get('/ready', async (_request, reply) => {
    if (!readyCache || Date.now() - readyCache.at > READY_CACHE_MS) {
      const probes = await probeAll()
      readyCache = {
        at: Date.now(),
        body: {
          status: overall(probes),
          // Name + colour only — no latency, detail, host or config data.
          // Services that are not configured are omitted entirely rather than
          // listed as "not_configured": that list is an inventory of what the
          // deployment could be running, which an unauthenticated caller has
          // no reason to receive. Administrators still see them in full at
          // /v1/admin/monitoring/current.
          services: probes
            .filter(p => p.status !== 'not_configured')
            .map(p => ({ name: p.service, status: p.status })),
          checkedAt: new Date().toISOString()
        }
      }
    }
    // 503 when the platform genuinely cannot serve, so orchestrators react;
    // DEGRADED still returns 200 because Yume is usable.
    if (readyCache.body.status === 'UNHEALTHY') return reply.code(503).send(readyCache.body)
    return readyCache.body
  })
}

interface MetricRow { metric: string, value: string, unit: string, created_at: string }
interface ServiceRow { service: string, status: string, latency_ms: string | null, detail: string | null, checked_at: string, since: string }

/**
 * What each dependency carries. Rendered as the dashboard's dependency map so
 * an operator can see what a red service actually breaks.
 */
const DEPENDENCIES: Array<{ service: string, required: boolean, provides: string[] }> = [
  { service: 'postgres', required: true, provides: ['Accounts & sessions', 'Catalogue', 'Library & progress', 'Community', 'Jobs & monitoring'] },
  { service: 'api', required: true, provides: ['REST + GraphQL', 'WebSocket', 'Static web client'] },
  { service: 'worker', required: false, provides: ['Metrics collection', 'Partition maintenance & retention', 'Stats rollups', 'Webhook delivery'] },
  { service: 'redis', required: false, provides: ['Cache & session lookups (not adopted yet)'] },
  { service: 'rabbitmq', required: false, provides: ['Higher fan-out queue driver (not adopted yet)'] },
  { service: 'opensearch', required: false, provides: ['Advanced search (Postgres full-text is used today)'] },
  { service: 'minio', required: false, provides: ['Object storage for artwork (external CDN URLs used today)'] }
]

export const adminMonitoring: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', fastify.requirePermission('system.metrics.view', { hide: true }))

  /** Latest reading of every metric, classified against the active thresholds. */
  fastify.get('/current', async () => {
    const [rows, services, active] = await Promise.all([
      // one row per metric: the newest sample inside the freshness window
      query<MetricRow>(
        `SELECT DISTINCT ON (metric) metric, value, unit, created_at
         FROM system_metrics
         WHERE created_at > now() - interval '10 minutes'
         ORDER BY metric, created_at DESC`
      ),
      query<ServiceRow>('SELECT service, status, latency_ms, detail, checked_at, since FROM service_status ORDER BY service'),
      thresholds()
    ])

    const metrics: Record<string, { value: number, unit: string, level?: Level, threshold?: Threshold }> = {}
    const levels: Level[] = []
    for (const row of rows) {
      const value = Number(row.value)
      const threshold = active[row.metric as MetricKey] as Threshold | undefined
      const entry: { value: number, unit: string, level?: Level, threshold?: Threshold } = { value, unit: row.unit }
      if (threshold) {
        entry.level = compare(value, threshold)
        entry.threshold = threshold
        levels.push(entry.level)
      }
      metrics[row.metric] = entry
    }

    // service colours fold into the same verdict as the numeric metrics
    for (const service of services) {
      if (service.status === 'red') levels.push('red')
      else if (service.status === 'yellow') levels.push('yellow')
    }

    // Staleness is about AGE, not existence: if the collector stopped, the
    // stored numbers still look fine but no longer describe reality, so the
    // dashboard must say so rather than showing confident stale values.
    const collectedAt = rows.reduce<string | null>(
      (newest, row) => (!newest || row.created_at > newest ? row.created_at : newest), null
    )
    const ageMs = collectedAt ? Date.now() - new Date(collectedAt).getTime() : null
    const stale = ageMs === null || ageMs > STALE_AFTER_MS

    return {
      collectedAt,
      stale,
      staleAfterMs: STALE_AFTER_MS,
      // stale data cannot be called healthy — surface it as critical so the
      // dashboard and any future alerting both react to a dead collector
      level: stale ? 'red' : worst(levels),
      metrics,
      services,
      dependencies: DEPENDENCIES
    }
  })

  /** Time series for one metric. Raw samples for short ranges, rollups beyond. */
  fastify.get('/history', {
    schema: {
      querystring: {
        type: 'object',
        required: ['metric'],
        properties: {
          metric: { type: 'string', maxLength: 60 },
          hours: { type: 'integer', minimum: 1, maximum: 8760, default: 24 }
        }
      }
    }
  }, async request => {
    const { metric, hours = 24 } = request.query as { metric: string, hours?: number }

    // Raw samples stay for ~7 days; anything longer is served from the hourly
    // rollup so a year-long chart is still a few hundred rows.
    if (hours <= 48) {
      const points = await query<{ t: string, value: string }>(
        `SELECT created_at AS t, value FROM system_metrics
         WHERE metric = $1 AND created_at > now() - make_interval(hours => $2)
         ORDER BY created_at`,
        [metric, hours]
      )
      return { metric, resolution: 'raw', points: points.map(p => ({ t: p.t, value: Number(p.value) })) }
    }

    const points = await query<{ t: string, value: string, min_value: string, max_value: string }>(
      `SELECT hour AS t, avg_value AS value, min_value, max_value FROM system_metrics_hourly
       WHERE metric = $1 AND hour > now() - make_interval(hours => $2)
       ORDER BY hour`,
      [metric, hours]
    )
    return {
      metric,
      resolution: 'hourly',
      points: points.map(p => ({ t: p.t, value: Number(p.value), min: Number(p.min_value), max: Number(p.max_value) }))
    }
  })

  /** The documented threshold table, so operators can see and justify them. */
  fastify.get('/thresholds', async () => ({ thresholds: await thresholds() }))

  /** Sustained problems: what is firing now, plus recent history. */
  fastify.get('/alerts', async () => {
    const [active, history] = await Promise.all([activeAlerts(), alertHistory(50)])
    return { active, history }
  })

  // ---------- diagnostics ----------

  /**
   * Queue a diagnostic run. Execution happens in the worker so the benchmarks
   * never run on the request path; this returns immediately with an id to poll.
   */
  fastify.post('/diagnostics', {
    preHandler: fastify.requirePermission('system.diagnostics.run', { hide: true })
  }, async (request, reply) => {
    // a run that never finished (worker killed mid-benchmark) must not block
    // new runs forever
    await query(
      `UPDATE diagnostic_runs SET status = 'failed', finished_at = now(),
              error = 'run did not finish — the worker may have restarted'
       WHERE status = 'running' AND started_at < now() - interval '10 minutes'`
    )

    const inFlight = await queryOne<{ id: string }>(
      `SELECT id FROM diagnostic_runs WHERE status = 'running' LIMIT 1`
    )
    if (inFlight) {
      return reply.code(409).send({
        type: 'about:blank', title: 'Conflict', status: 409,
        detail: 'A diagnostic run is already in progress'
      })
    }

    const run = await queryOne<{ id: string }>(
      `INSERT INTO diagnostic_runs (requested_by) VALUES ($1) RETURNING id`,
      [request.user.sub]
    )
    await enqueue('monitor', { diagnosticId: run!.id })
    return reply.code(202).send({ id: run!.id, status: 'running' })
  })

  /** Recent runs, newest first. */
  fastify.get('/diagnostics', async () => {
    const data = await query(
      `SELECT d.id, d.status, d.started_at, d.finished_at, d.passed, d.warned, d.failed, u.username AS requested_by
       FROM diagnostic_runs d LEFT JOIN users u ON u.id = d.requested_by
       ORDER BY d.started_at DESC LIMIT 20`
    )
    return { data, busy: isRunning() }
  })

  /** One run's full report. */
  fastify.get('/diagnostics/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const run = await queryOne(
      `SELECT d.id, d.status, d.started_at, d.finished_at, d.passed, d.warned, d.failed, d.results, d.error,
              u.username AS requested_by
       FROM diagnostic_runs d LEFT JOIN users u ON u.id = d.requested_by
       WHERE d.id = $1`,
      [id]
    )
    if (!run) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return run
  })

  /** Job queue health — depth, dead letters and recent failures. */
  fastify.get('/queues', async () => {
    const [totals, byQueue] = await Promise.all([
      queryOne(
        `SELECT count(*) FILTER (WHERE done_at IS NULL AND run_at <= now() AND attempts < max_attempts) AS pending,
                count(*) FILTER (WHERE done_at IS NULL AND attempts >= max_attempts) AS dead,
                count(*) FILTER (WHERE done_at > now() - interval '1 hour') AS completed_1h
         FROM jobs`
      ),
      query(
        `SELECT queue,
                count(*) FILTER (WHERE done_at IS NULL AND attempts < max_attempts) AS pending,
                count(*) FILTER (WHERE done_at IS NULL AND attempts >= max_attempts) AS dead,
                max(last_error) FILTER (WHERE done_at IS NULL AND last_error IS NOT NULL) AS last_error
         FROM jobs GROUP BY queue ORDER BY queue`
      )
    ])
    return { totals, queues: byQueue }
  })
}
