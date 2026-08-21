// On-demand diagnostics: controlled benchmarks an administrator can trigger.
//
// SAFETY IS THE POINT HERE. These run on the same VPS that is serving traffic,
// so every test is bounded:
//   * a fixed, short time budget (never "until it finishes")
//   * a fixed, small memory budget, released immediately
//   * a fixed, small disk budget, written to a temp file and always deleted
//   * a refusal to run the disk test at all when free space is tight
//   * one run at a time, enforced by a lock
// Nothing here spawns processes, forks workers or scales with machine size.

import { randomBytes } from 'node:crypto'
import { open, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { config } from '../config.ts'
import { query } from '../db.ts'
import { DISK_PATH } from './metrics.ts'
import { probeAll } from './probes.ts'

export type TestStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface TestResult {
  name: string
  group: string
  status: TestStatus
  value: string          // human-readable measurement
  detail?: string
}

// ---- budgets (deliberately small; see the module header) ----
const CPU_BUDGET_MS = Number(process.env.DIAG_CPU_MS ?? 700)
const RAM_BUDGET_BYTES = Number(process.env.DIAG_RAM_BYTES ?? 128 * 1024 * 1024)   // 128 MB
const DISK_BUDGET_BYTES = Number(process.env.DIAG_DISK_BYTES ?? 32 * 1024 * 1024)  // 32 MB
/** Refuse the disk test unless this much free space remains after it. */
const DISK_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024                                 // 2 GB
const LATENCY_SAMPLES = 20

/** Only one diagnostic run at a time, process-wide. */
let running = false
export const isRunning = (): boolean => running

const ms = (nanos: bigint): number => Number(nanos) / 1e6

/** Run a test, converting a throw or a timeout into a failed result. */
async function guard (name: string, group: string, fn: () => Promise<TestResult>, timeoutMs = 15_000): Promise<TestResult> {
  const timeout = new Promise<TestResult>(resolve =>
    setTimeout(() => resolve({ name, group, status: 'fail', value: 'timeout', detail: `exceeded ${timeoutMs}ms` }), timeoutMs).unref()
  )
  try {
    return await Promise.race([fn(), timeout])
  } catch (error) {
    return { name, group, status: 'fail', value: 'error', detail: (error as Error).message.slice(0, 140) }
  }
}

// ---------------------------------------------------------------- hardware

/** Integer throughput over a fixed time budget — single-threaded, bounded. */
async function cpuBenchmark (): Promise<TestResult> {
  const deadline = Date.now() + CPU_BUDGET_MS
  let iterations = 0
  let accumulator = 0
  while (Date.now() < deadline) {
    // a small fixed chunk between clock checks keeps the loop responsive
    for (let i = 0; i < 100_000; i++) accumulator = (accumulator + i * 31) % 2_147_483_647
    iterations += 100_000
  }
  const millionsPerSec = iterations / CPU_BUDGET_MS / 1000
  return {
    name: 'CPU', group: 'Hardware',
    // ~50M ops/s is a slow shared core; ~150M+ is a healthy dedicated one
    status: millionsPerSec >= 50 ? 'pass' : millionsPerSec >= 25 ? 'warn' : 'fail',
    value: `${millionsPerSec.toFixed(0)}M ops/s`,
    detail: `${CPU_BUDGET_MS}ms single-core integer loop (checksum ${accumulator % 1000})`
  }
}

/**
 * Memory bandwidth over a bounded buffer, released immediately after.
 *
 * The first pass over a fresh allocation is dominated by kernel page faults,
 * not by RAM speed, so the buffer is warmed first and only the subsequent
 * passes are timed — otherwise this measures allocation and reports a healthy
 * machine as broken.
 */
async function ramBenchmark (): Promise<TestResult> {
  let buffer: Buffer | null = Buffer.allocUnsafe(RAM_BUDGET_BYTES)
  try {
    buffer.fill(0x5a) // warm-up: take the page faults outside the measurement

    const passes = 3
    const writeStart = process.hrtime.bigint()
    for (let i = 0; i < passes; i++) buffer.fill(0xa5 + i)
    const writeMs = ms(process.hrtime.bigint() - writeStart)

    // read bandwidth over a typed view, one touch per cache line
    const view = new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.length >>> 2)
    const readStart = process.hrtime.bigint()
    let sum = 0
    for (let i = 0; i < view.length; i += 4) sum += view[i]!
    const readMs = ms(process.hrtime.bigint() - readStart)

    const writeGbs = (RAM_BUDGET_BYTES * passes) / (writeMs / 1000) / 1e9
    const readGbs = RAM_BUDGET_BYTES / (readMs / 1000) / 1e9
    return {
      name: 'RAM', group: 'Hardware',
      // even a modest VPS clears several GB/s once pages are resident
      status: writeGbs >= 2 ? 'pass' : writeGbs >= 1 ? 'warn' : 'fail',
      value: `${writeGbs.toFixed(1)} GB/s write · ${readGbs.toFixed(1)} GB/s read`,
      detail: `${(RAM_BUDGET_BYTES / 1048576).toFixed(0)} MB buffer, pages pre-faulted (checksum ${sum % 997})`
    }
  } finally {
    buffer = null // hand it straight back to the GC
  }
}

/** Bounded write + fsync + read on a temp file, always cleaned up. */
async function diskBenchmark (): Promise<TestResult> {
  const stats = await statfs(DISK_PATH).catch(() => null)
  if (stats) {
    const freeBytes = Number(stats.bavail) * Number(stats.bsize)
    if (freeBytes < DISK_BUDGET_BYTES + DISK_HEADROOM_BYTES) {
      return {
        name: 'Disk', group: 'Hardware', status: 'warn',
        value: 'skipped',
        detail: 'not enough free space to run safely'
      }
    }
  }

  const path = join(tmpdir(), `yume-diag-${randomBytes(6).toString('hex')}.tmp`)
  const chunk = Buffer.alloc(1024 * 1024, 0x5a) // 1 MB
  const chunks = Math.floor(DISK_BUDGET_BYTES / chunk.length)
  let handle
  try {
    handle = await open(path, 'w+')
    const writeStart = process.hrtime.bigint()
    for (let i = 0; i < chunks; i++) await handle.write(chunk)
    await handle.sync()  // measure real durability, not just page cache
    const writeMs = ms(process.hrtime.bigint() - writeStart)

    const readStart = process.hrtime.bigint()
    const readBuffer = Buffer.allocUnsafe(chunk.length)
    for (let i = 0; i < chunks; i++) await handle.read(readBuffer, 0, chunk.length, i * chunk.length)
    const readMs = ms(process.hrtime.bigint() - readStart)

    const writeMbs = DISK_BUDGET_BYTES / 1048576 / (writeMs / 1000)
    const readMbs = DISK_BUDGET_BYTES / 1048576 / (readMs / 1000)
    return {
      name: 'Disk', group: 'Hardware',
      // an NVMe VPS should comfortably exceed 100 MB/s even with fsync
      status: writeMbs >= 100 ? 'pass' : writeMbs >= 30 ? 'warn' : 'fail',
      value: `${writeMbs.toFixed(0)} MB/s write · ${readMbs.toFixed(0)} MB/s read`,
      detail: `${(DISK_BUDGET_BYTES / 1048576).toFixed(0)} MB, write includes fsync; read is served from page cache`
    }
  } finally {
    await handle?.close().catch(() => {})
    await rm(path, { force: true }).catch(() => {}) // never leave the file behind
  }
}

// ---------------------------------------------------------------- services

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

/** Repeated `SELECT 1` — pool and I/O health, not query cost. */
async function dbLatency (): Promise<TestResult> {
  const samples: number[] = []
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const started = process.hrtime.bigint()
    await query('SELECT 1')
    samples.push(ms(process.hrtime.bigint() - started))
  }
  const p50 = percentile(samples, 0.5)
  const p95 = percentile(samples, 0.95)
  return {
    name: 'DB queries', group: 'Platform',
    status: p95 <= 50 ? 'pass' : p95 <= 200 ? 'warn' : 'fail',
    value: `p50 ${p50.toFixed(1)}ms · p95 ${p95.toFixed(1)}ms`,
    detail: `${LATENCY_SAMPLES}× SELECT 1`
  }
}

/** A real indexed catalogue read, so the plan and indexes are exercised too. */
async function dbQueryPlan (): Promise<TestResult> {
  const started = process.hrtime.bigint()
  const rows = await query(
    `SELECT id, canonical_title FROM anime WHERE visibility = 'public' ORDER BY popularity DESC LIMIT 20`
  )
  const elapsed = ms(process.hrtime.bigint() - started)
  return {
    name: 'Catalogue query', group: 'Platform',
    status: elapsed <= 100 ? 'pass' : elapsed <= 500 ? 'warn' : 'fail',
    value: `${elapsed.toFixed(1)}ms`,
    detail: `${rows.length} rows from the popularity index`
  }
}

/** The API's own HTTP path, measured end to end. */
async function apiLatency (): Promise<TestResult> {
  const samples: number[] = []
  let failures = 0
  for (let i = 0; i < 10; i++) {
    const started = process.hrtime.bigint()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(new URL('/v1/health', config.selfUrl), { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) failures++
      samples.push(ms(process.hrtime.bigint() - started))
    } catch {
      failures++
    }
  }
  if (!samples.length) {
    return { name: 'API latency', group: 'Platform', status: 'fail', value: 'unreachable', detail: 'no successful requests' }
  }
  const p95 = percentile(samples, 0.95)
  return {
    name: 'API latency', group: 'Platform',
    status: failures === 0 && p95 <= 200 ? 'pass' : failures === 0 && p95 <= 800 ? 'warn' : 'fail',
    value: `p95 ${p95.toFixed(0)}ms`,
    detail: failures ? `${failures}/10 requests failed` : '10 requests to /v1/health'
  }
}

/** Reuses the live probes so diagnostics and monitoring cannot disagree. */
async function serviceConnectivity (): Promise<TestResult[]> {
  const probes = await probeAll()
  return probes.map(probe => ({
    name: probe.service.charAt(0).toUpperCase() + probe.service.slice(1),
    group: 'Services',
    // an optional service that is not configured is skipped, not failed —
    // counting it against the score would punish a correct setup
    status: probe.status === 'green' ? 'pass'
      : probe.status === 'yellow' ? 'warn'
        : probe.status === 'not_configured' ? 'skip' : 'fail',
    value: probe.status === 'not_configured' ? 'not configured'
      : probe.latencyMs !== null ? `${probe.latencyMs.toFixed(0)}ms`
        : probe.detail ?? probe.status,
    ...(probe.detail ? { detail: probe.detail } : {})
  } satisfies TestResult))
}

/** Queue and worker health, from data the monitor worker already maintains. */
async function workerHealth (): Promise<TestResult> {
  const rows = await query<{ pending: string, dead: string, age_s: string | null }>(
    `SELECT (SELECT count(*) FROM jobs WHERE done_at IS NULL AND attempts < max_attempts) AS pending,
            (SELECT count(*) FROM jobs WHERE done_at IS NULL AND attempts >= max_attempts) AS dead,
            (SELECT EXTRACT(EPOCH FROM (now() - max(created_at))) FROM system_metrics) AS age_s`
  )
  const { pending = '0', dead = '0', age_s: age } = rows[0] ?? {}
  const ageSec = age === null || age === undefined ? null : Number(age)
  const stale = ageSec === null || ageSec > 180
  return {
    name: 'Worker & queues', group: 'Platform',
    status: stale ? 'fail' : Number(dead) > 0 ? 'warn' : 'pass',
    value: stale ? 'no recent collection' : `${pending} pending · ${dead} dead`,
    detail: ageSec === null ? 'the monitor worker has never run' : `last sample ${Math.round(ageSec)}s ago`
  }
}

// ---------------------------------------------------------------- runner

export interface DiagnosticReport {
  results: TestResult[]
  passed: number
  warned: number
  failed: number
  skipped: number
}

/**
 * Run the full suite. Bounded overall; individual tests degrade to 'fail'
 * rather than throwing, so one broken subsystem still produces a report.
 */
export async function runDiagnostics (): Promise<DiagnosticReport> {
  if (running) throw new Error('A diagnostic run is already in progress')
  running = true
  try {
    const results: TestResult[] = [
      await guard('CPU', 'Hardware', cpuBenchmark, 10_000),
      await guard('RAM', 'Hardware', ramBenchmark, 10_000),
      await guard('Disk', 'Hardware', diskBenchmark, 30_000),
      ...(await serviceConnectivity()),
      await guard('API latency', 'Platform', apiLatency, 20_000),
      await guard('DB queries', 'Platform', dbLatency, 20_000),
      await guard('Catalogue query', 'Platform', dbQueryPlan, 15_000),
      await guard('Worker & queues', 'Platform', workerHealth, 10_000)
    ]
    return {
      results,
      passed: results.filter(r => r.status === 'pass').length,
      warned: results.filter(r => r.status === 'warn').length,
      failed: results.filter(r => r.status === 'fail').length,
      skipped: results.filter(r => r.status === 'skip').length
    }
  } finally {
    running = false
  }
}

/** Render the report as the fixed-width text summary operators expect. */
export function formatReport (report: DiagnosticReport): string {
  const lines = ['YUME VPS DIAGNOSTIC', '─'.repeat(40)]
  let group = ''
  for (const result of report.results) {
    if (result.group !== group) { if (group) lines.push(''); group = result.group }
    const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' }[result.status]
    lines.push(`${result.name.padEnd(20)}${label.padEnd(6)}${result.value}`)
  }
  // skipped tests are not part of the score
  const scored = report.results.length - report.skipped
  lines.push('', `${'TOTAL'.padEnd(20)}${report.passed}/${scored} PASS` +
    (report.warned ? ` · ${report.warned} WARN` : '') +
    (report.failed ? ` · ${report.failed} FAIL` : '') +
    (report.skipped ? ` · ${report.skipped} SKIPPED` : ''))
  return lines.join('\n')
}
