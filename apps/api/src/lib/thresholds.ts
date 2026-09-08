// Monitoring thresholds — the single place where "what counts as unhealthy"
// is defined. Every value is documented with the reasoning behind it; none is
// arbitrary.
//
// Precedence (highest wins):
//   1. site_settings['monitor_thresholds']  — runtime override, admin-editable
//      via PATCH /v1/admin/config/settings/monitor_thresholds
//   2. DEFAULTS below
//
// Direction matters: most metrics are "higher is worse" (cpu, latency), which
// is what compare() assumes.

import { queryOne } from '../db.ts'

export type Level = 'green' | 'yellow' | 'red'

export interface Threshold {
  warn: number
  crit: number
  unit: string
  /** why these numbers — surfaced in the admin UI so operators can judge them */
  rationale: string
}

export const DEFAULTS = {
  // Sustained CPU above ~80% leaves no headroom for traffic spikes; above 92%
  // request latency degrades sharply on a shared-core VPS.
  'cpu.usage_pct': { warn: 80, crit: 92, unit: 'pct', rationale: 'Above 80% there is no headroom for spikes; above 92% latency degrades sharply.' },

  // Load average per core. 1.0 means the run queue is saturated; 2.0 means
  // tasks wait as long as they run.
  'cpu.load_per_core': { warn: 1.0, crit: 2.0, unit: 'ratio', rationale: '1.0 = run queue saturated (one runnable task per core); 2.0 = tasks wait as long as they execute.' },

  // Memory. Linux reclaims cache, so MemAvailable is the honest figure; under
  // 15% free the kernel starts evicting page cache aggressively, under 6% the
  // OOM killer becomes likely.
  'mem.used_pct': { warn: 85, crit: 94, unit: 'pct', rationale: 'Based on MemAvailable. Below ~15% free the kernel evicts page cache; below ~6% OOM-kill risk.' },

  // Any sustained swapping on an NVMe VPS hurts tail latency; heavy swap means
  // the working set no longer fits in RAM.
  'swap.used_pct': { warn: 25, crit: 60, unit: 'pct', rationale: 'Sustained swapping hurts tail latency; >60% means the working set no longer fits in RAM.' },

  // Disk. Postgres needs free space for WAL, temp files and VACUUM; ext4/xfs
  // also fragment badly past ~90%.
  'disk.used_pct': { warn: 80, crit: 92, unit: 'pct', rationale: 'Postgres needs headroom for WAL, temp files and VACUUM; filesystems fragment badly past ~90%.' },

  // Average service time per I/O. NVMe should answer in single-digit ms;
  // >100ms means the device (or a noisy neighbour) is saturated.
  'disk.await_ms': { warn: 20, crit: 100, unit: 'ms', rationale: 'NVMe normally answers in single-digit ms. >20ms indicates queueing, >100ms a saturated device or noisy neighbour.' },

  // TCP connect latency to a public endpoint. >150ms suggests a congested
  // uplink or far-away routing; >400ms is unusable for interactive traffic.
  'net.latency_ms': { warn: 150, crit: 400, unit: 'ms', rationale: 'TCP connect RTT. >150ms suggests congestion or distant routing; >400ms is unusable interactively.' },

  // Interface-level drops. Any sustained drop rate points at a saturated link
  // or a misconfigured NIC/queue.
  'net.drop_pct': { warn: 0.1, crit: 1.0, unit: 'pct', rationale: 'Interface rx/tx drop ratio. Any sustained loss points at a saturated link or NIC queue.' },

  // API response time measured against the app's own health endpoint.
  'api.latency_ms': { warn: 300, crit: 1000, unit: 'ms', rationale: 'Self-probe of /v1/health. >300ms means the event loop is congested; >1s is user-visible.' },

  // A trivial `SELECT 1`. Anything slow here is connection-pool or I/O trouble.
  'db.latency_ms': { warn: 100, crit: 500, unit: 'ms', rationale: 'Round-trip for `SELECT 1`. Slow here means pool exhaustion or disk trouble, not query cost.' },

  // Backlog of runnable jobs. A steadily growing queue means the worker is
  // down or under-provisioned.
  'queue.pending': { warn: 100, crit: 1000, unit: 'count', rationale: 'Runnable job backlog. Sustained growth means the worker is down or under-provisioned.' },

  // Jobs that exhausted their retries — each one is lost work.
  'queue.dead': { warn: 1, crit: 25, unit: 'count', rationale: 'Jobs past max_attempts. Each represents lost work and needs operator attention.' }
} as const satisfies Record<string, Threshold>

export type MetricKey = keyof typeof DEFAULTS

/** Classify a value against a threshold. Higher is worse. */
export function compare (value: number, threshold: Threshold): Level {
  if (value >= threshold.crit) return 'red'
  if (value >= threshold.warn) return 'yellow'
  return 'green'
}

/** Worst of a set of levels — how a whole panel or the overall status rolls up. */
export function worst (levels: Level[]): Level {
  if (levels.includes('red')) return 'red'
  if (levels.includes('yellow')) return 'yellow'
  return 'green'
}

type Overrides = Partial<Record<MetricKey, Partial<Pick<Threshold, 'warn' | 'crit'>>>>

// Thresholds change rarely and are read on every collection cycle + dashboard
// load, so they are cached briefly rather than re-queried each time.
let cache: { at: number, value: Record<MetricKey, Threshold> } | undefined
const CACHE_MS = 30_000

/** Effective thresholds: documented defaults with any admin overrides applied. */
export async function thresholds (): Promise<Record<MetricKey, Threshold>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value

  const merged = { ...DEFAULTS } as Record<MetricKey, Threshold>
  try {
    const row = await queryOne<{ value: Overrides }>(
      `SELECT value FROM site_settings WHERE key = 'monitor_thresholds'`
    )
    for (const [key, override] of Object.entries(row?.value ?? {})) {
      const base = merged[key as MetricKey]
      if (!base || !override) continue
      merged[key as MetricKey] = {
        ...base,
        warn: typeof override.warn === 'number' ? override.warn : base.warn,
        crit: typeof override.crit === 'number' ? override.crit : base.crit
      }
    }
  } catch {
    // settings unreachable → documented defaults still apply
  }

  cache = { at: Date.now(), value: merged }
  return merged
}

/** Drop the cache so an admin's threshold change takes effect immediately. */
export function invalidateThresholds (): void {
  cache = undefined
}
