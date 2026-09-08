// Service probes — capability-aware liveness checks for Yume's dependencies.
//
// Only Postgres is a hard dependency today. Redis, RabbitMQ, OpenSearch and
// MinIO are probed ONLY when their URL is configured; otherwise they report
// 'not_configured' rather than a false 'red'. That way the dashboard is honest
// now and lights up automatically the day one of them is adopted.
//
// Every probe is dependency-free (raw TCP or fetch), bounded by a short
// timeout, and never throws. `detail` carries a short human reason and must
// never contain credentials or connection strings.

import net from 'node:net'

import { config } from '../config.ts'
import { query } from '../db.ts'

export type ServiceStatus = 'green' | 'yellow' | 'red' | 'not_configured'

export interface ProbeResult {
  service: string
  status: ServiceStatus
  latencyMs: number | null
  detail: string | null
}

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 2000)
/** Reachable but slower than this → yellow. */
const SLOW_MS = Number(process.env.PROBE_SLOW_MS ?? 500)

const notConfigured = (service: string): ProbeResult =>
  ({ service, status: 'not_configured', latencyMs: null, detail: 'not configured' })

/** Strip anything that could carry a credential out of an error message. */
export function safeDetail (error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/[a-z]+:\/\/[^\s]*/gi, '<url>')   // scheme://user:pass@host
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
    .slice(0, 120)
}

const rate = (latencyMs: number, detail: string | null = null): Omit<ProbeResult, 'service'> =>
  ({ status: latencyMs > SLOW_MS ? 'yellow' : 'green', latencyMs, detail })

/** Time an async probe, converting any failure into a red result. */
async function timed (service: string, fn: () => Promise<Omit<ProbeResult, 'service' | 'latencyMs'> | void>): Promise<ProbeResult> {
  const started = process.hrtime.bigint()
  try {
    const outcome = await fn()
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6
    if (outcome?.status) return { service, latencyMs, ...outcome }
    return { service, ...rate(latencyMs) }
  } catch (error) {
    return { service, status: 'red', latencyMs: null, detail: safeDetail(error) }
  }
}

/** Open a TCP connection, optionally write a payload and read one reply. */
function tcpProbe (host: string, port: number, payload?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let buffer = ''
    const finish = (err?: Error): void => {
      socket.destroy()
      if (err) reject(err); else resolve(buffer)
    }
    socket.setTimeout(TIMEOUT_MS)
    socket.once('connect', () => {
      if (!payload) return finish()
      socket.write(payload)
    })
    socket.on('data', chunk => {
      buffer += chunk.toString()
      finish()
    })
    socket.once('timeout', () => finish(new Error('timed out')))
    socket.once('error', err => finish(err))
  })
}

/** fetch with a hard timeout — used for the HTTP-speaking services. */
async function httpProbe (url: string, path: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(new URL(path, url), { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const hostPort = (url: string, fallbackPort: number): { host: string, port: number } => {
  const parsed = new URL(url.includes('://') ? url : `tcp://${url}`)
  return { host: parsed.hostname, port: Number(parsed.port) || fallbackPort }
}

// ---------------------------------------------------------------- probes

/** Postgres — the one hard dependency. A trivial round-trip, not a query cost. */
export const probePostgres = (): Promise<ProbeResult> =>
  timed('postgres', async () => { await query('SELECT 1') })

/** Redis — inline PING command over raw TCP (no client library needed). */
export const probeRedis = (): Promise<ProbeResult> => {
  if (!config.redisUrl) return Promise.resolve(notConfigured('redis'))
  return timed('redis', async () => {
    const { host, port } = hostPort(config.redisUrl!, 6379)
    const reply = await tcpProbe(host, port, 'PING\r\n')
    if (!reply.startsWith('+PONG')) return { status: 'yellow' as const, detail: 'unexpected PING reply' }
  })
}

/** RabbitMQ — TCP reachability (the AMQP handshake needs a full client). */
export const probeRabbit = (): Promise<ProbeResult> => {
  if (!config.rabbitUrl) return Promise.resolve(notConfigured('rabbitmq'))
  return timed('rabbitmq', async () => {
    const { host, port } = hostPort(config.rabbitUrl!, 5672)
    await tcpProbe(host, port)
  })
}

/** OpenSearch — cluster health; a yellow cluster maps to yellow, red to red. */
export const probeOpenSearch = (): Promise<ProbeResult> => {
  if (!config.openSearchUrl) return Promise.resolve(notConfigured('opensearch'))
  return timed('opensearch', async () => {
    const res = await httpProbe(config.openSearchUrl!, '/_cluster/health')
    if (!res.ok) return { status: 'red' as const, detail: `HTTP ${res.status}` }
    const body = await res.json() as { status?: string }
    if (body.status === 'red') return { status: 'red' as const, detail: 'cluster red' }
    if (body.status === 'yellow') return { status: 'yellow' as const, detail: 'cluster yellow' }
  })
}

/** MinIO — the documented unauthenticated liveness endpoint. */
export const probeMinio = (): Promise<ProbeResult> => {
  if (!config.minioUrl) return Promise.resolve(notConfigured('minio'))
  return timed('minio', async () => {
    const res = await httpProbe(config.minioUrl!, '/minio/health/live')
    if (!res.ok) return { status: 'red' as const, detail: `HTTP ${res.status}` }
  })
}

/** The API's own response time, measured from wherever the collector runs. */
export const probeApi = (): Promise<ProbeResult> =>
  timed('api', async () => {
    const res = await httpProbe(config.selfUrl, '/v1/health')
    if (!res.ok) return { status: 'red' as const, detail: `HTTP ${res.status}` }
  })

/**
 * Worker liveness, inferred from the freshness of its own collected metrics —
 * the collector runs inside the worker, so a stale newest sample means the
 * worker is not running. No heartbeat table needed.
 */
export async function probeWorker (staleAfterMs = 180_000): Promise<ProbeResult> {
  try {
    const rows = await query<{ age_ms: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - max(created_at))) * 1000 AS age_ms FROM system_metrics`
    )
    const ageMs = rows[0]?.age_ms
    if (ageMs === null || ageMs === undefined) {
      return { service: 'worker', status: 'yellow', latencyMs: null, detail: 'no metrics collected yet' }
    }
    if (ageMs > staleAfterMs) {
      return { service: 'worker', status: 'red', latencyMs: null, detail: `last sample ${Math.round(ageMs / 1000)}s ago` }
    }
    return { service: 'worker', status: 'green', latencyMs: null, detail: null }
  } catch (error) {
    return { service: 'worker', status: 'red', latencyMs: null, detail: safeDetail(error) }
  }
}

/** Every probe, in parallel. Order is stable for the dashboard. */
export async function probeAll (): Promise<ProbeResult[]> {
  return Promise.all([
    probePostgres(), probeRedis(), probeRabbit(),
    probeOpenSearch(), probeMinio(), probeApi(), probeWorker()
  ])
}

/** Roll individual probes up into the overall service health verdict. */
export function overall (results: ProbeResult[]): 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' {
  const relevant = results.filter(r => r.status !== 'not_configured')
  // Postgres is the hard dependency: without it Yume cannot serve anything.
  if (relevant.some(r => r.service === 'postgres' && r.status === 'red')) return 'UNHEALTHY'
  if (relevant.some(r => r.status === 'red')) return 'DEGRADED'
  if (relevant.some(r => r.status === 'yellow')) return 'DEGRADED'
  return 'HEALTHY'
}
