// What this platform is made of, what each part depends on, and whether each
// part is actually working.
//
// The brief asked for a component registry, an error-code namespace per
// component, a health status per component and a dependency graph — with one
// instruction repeated throughout: no fake health status.
//
// That instruction is the whole design here. It is trivially easy to write a
// registry that reports "Operational" for everything because nothing is
// measuring anything, and such a page is worse than no page: it answers the
// question an operator came to ask, wrongly, and they stop looking.
//
// So every component carries a `measure` that inspects something real, and the
// three possible outcomes are honest ones:
//
//   operational   measured, and healthy
//   degraded      measured, and working worse than it should
//   down          measured, and not working
//   unknown       could not be measured, or has never run
//
// `unknown` is not a failure of this file. A metadata sync that has never been
// started has no health to report, and saying so is the correct answer —
// rounding it to "Operational" would be inventing one.
//
// The dependency edges are declared, and the reverse edges (what breaks if
// this breaks) are derived from them so the two cannot disagree.

import { query, queryOne } from '../db.ts'
import { probePostgres, probeWorker, safeDetail } from './probes.ts'

export type ComponentStatus = 'operational' | 'degraded' | 'down' | 'unknown'

export interface Measurement {
  status: ComponentStatus
  /** What the measurement found, in a sentence. */
  detail: string
}

export interface Component {
  id: string
  name: string
  /** What it cannot work without. Ids of other components. */
  dependsOn: string[]
  /** What the code says when this component is the one that failed. */
  errorPrefix: string
  /** Where the status came from, so a reader can go and check it. */
  measuredBy: string
  measure: () => Promise<Measurement>
}

/**
 * Milliseconds after which a component that reports its own liveness is stale.
 * Three minutes matches probeWorker's default: long enough to survive a slow
 * cycle, short enough that a dead worker is noticed within one.
 */
const STALE_MS = 180_000

const DEFINITIONS: Component[] = [
  {
    id: 'YUME-DB-001',
    name: 'Database',
    dependsOn: [],
    errorPrefix: 'YUME-API',
    measuredBy: 'SELECT 1, timed',
    measure: async () => {
      const probe = await probePostgres()
      if (probe.status === 'green') return { status: 'operational', detail: `responded in ${probe.latencyMs ?? 0}ms` }
      if (probe.status === 'yellow') return { status: 'degraded', detail: probe.detail ?? `slow: ${probe.latencyMs ?? 0}ms` }
      return { status: 'down', detail: probe.detail ?? 'unreachable' }
    }
  },
  {
    id: 'YUME-AUTH-001',
    name: 'Authentication',
    dependsOn: ['YUME-DB-001'],
    errorPrefix: 'YUME-AUTH',
    measuredBy: "security_logs: login vs login_failed, last hour",
    measure: async () => {
      const row = await queryOne<{ ok: number, bad: number }>(
        `SELECT count(*) FILTER (WHERE event = 'login')::int AS ok,
                count(*) FILTER (WHERE event = 'login_failed')::int AS bad
           FROM security_logs
          WHERE created_at > now() - interval '1 hour'`)
      const ok = Number(row?.ok ?? 0)
      const bad = Number(row?.bad ?? 0)
      // No traffic is not health. An instance nobody signed into in the last
      // hour tells us nothing about whether signing in works.
      if (ok + bad === 0) return { status: 'unknown', detail: 'no sign-in attempts in the last hour' }
      if (ok === 0 && bad > 5) {
        return { status: 'down', detail: `${bad} attempts in the last hour, none succeeded` }
      }
      return { status: 'operational', detail: `${ok} succeeded, ${bad} failed in the last hour` }
    }
  },
  {
    id: 'YUME-JOBS-001',
    name: 'Background jobs',
    dependsOn: ['YUME-DB-001'],
    errorPrefix: 'YUME-JOBS',
    measuredBy: 'system_metrics heartbeat, and jobs past their retry limit',
    measure: async () => {
      const probe = await probeWorker(STALE_MS)
      if (probe.status === 'red') return { status: 'down', detail: probe.detail ?? 'no heartbeat' }
      if (probe.status === 'yellow') return { status: 'unknown', detail: probe.detail ?? 'never run' }
      const dead = await queryOne<{ n: number }>(
        'SELECT count(*)::int AS n FROM jobs WHERE attempts >= max_attempts AND done_at IS NULL')
      const n = Number(dead?.n ?? 0)
      if (n > 10) return { status: 'degraded', detail: `beating, but ${n} jobs have exhausted their retries` }
      return { status: 'operational', detail: `beating; ${n} exhausted job${n === 1 ? '' : 's'}` }
    }
  },
  {
    id: 'YUME-CATALOGUE-001',
    name: 'Catalogue',
    dependsOn: ['YUME-DB-001'],
    errorPrefix: 'YUME-CATALOGUE',
    measuredBy: 'row counts in anime and episodes',
    measure: async () => {
      const row = await queryOne<{ anime: number, episodes: number }>(
        `SELECT (SELECT count(*)::int FROM anime) AS anime,
                (SELECT count(*)::int FROM episodes) AS episodes`)
      const anime = Number(row?.anime ?? 0)
      if (anime === 0) return { status: 'unknown', detail: 'the catalogue is empty — nothing imported yet' }
      return { status: 'operational', detail: `${anime} anime, ${Number(row?.episodes ?? 0)} episodes` }
    }
  },
  {
    id: 'YUME-SEARCH-001',
    name: 'Search',
    dependsOn: ['YUME-DB-001', 'YUME-CATALOGUE-001'],
    errorPrefix: 'YUME-ANIME',
    measuredBy: 'the pg_trgm extension and the trigram index on anime',
    measure: async () => {
      const row = await queryOne<{ ext: number, idx: number }>(
        `SELECT (SELECT count(*)::int FROM pg_extension WHERE extname = 'pg_trgm') AS ext,
                (SELECT count(*)::int FROM pg_indexes
                  WHERE tablename = 'anime' AND indexdef ILIKE '%gin%') AS idx`)
      if (Number(row?.ext ?? 0) === 0) {
        return { status: 'down', detail: 'pg_trgm is not installed — fuzzy search cannot work' }
      }
      if (Number(row?.idx ?? 0) === 0) {
        return { status: 'degraded', detail: 'pg_trgm is installed but anime has no trigram index — every search is a sequential scan' }
      }
      return { status: 'operational', detail: 'pg_trgm installed, trigram index present' }
    }
  },
  {
    id: 'YUME-SYNC-001',
    name: 'Metadata sync',
    dependsOn: ['YUME-DB-001', 'YUME-JOBS-001', 'YUME-SRC-ANILIST-001'],
    errorPrefix: 'YUME-CATALOGUE',
    measuredBy: 'the most recent row in metadata_runs',
    measure: async () => {
      const row = await queryOne<{ status: string, error: string | null, finished_at: Date | null }>(
        'SELECT status, error, finished_at FROM metadata_runs ORDER BY created_at DESC LIMIT 1')
      if (!row) return { status: 'unknown', detail: 'no run has ever been started' }
      if (row.status === 'failed') return { status: 'down', detail: `last run failed: ${String(row.error ?? '').slice(0, 120)}` }
      if (row.status === 'cancelled') return { status: 'degraded', detail: `last run was cancelled: ${String(row.error ?? 'by an operator').slice(0, 120)}` }
      if (row.status === 'running' || row.status === 'queued') return { status: 'operational', detail: `a run is ${row.status}` }
      return { status: 'operational', detail: 'last run finished' }
    }
  },
  {
    id: 'YUME-SRC-ANILIST-001',
    name: 'AniList',
    dependsOn: [],
    errorPrefix: 'YUME-CATALOGUE',
    measuredBy: 'anime_mappings.anilist_id coverage',
    measure: async () => {
      // Deliberately not a live request. Probing a third party on every page
      // load is traffic they did not ask for, and a rate-limit answer would be
      // read as "AniList is down". What is measurable without asking them is
      // whether their ids ever reached us.
      const row = await queryOne<{ mapped: number, total: number }>(
        `SELECT (SELECT count(*)::int FROM anime_mappings WHERE anilist_id IS NOT NULL) AS mapped,
                (SELECT count(*)::int FROM anime) AS total`)
      const mapped = Number(row?.mapped ?? 0)
      const total = Number(row?.total ?? 0)
      if (total === 0) return { status: 'unknown', detail: 'nothing imported, so nothing to map' }
      if (mapped === 0) return { status: 'unknown', detail: 'no AniList ids recorded — sync has not run against it' }
      return { status: 'operational', detail: `${mapped} of ${total} entries carry an AniList id` }
    }
  },
  {
    id: 'YUME-SRC-MAL-001',
    name: 'MyAnimeList',
    dependsOn: [],
    errorPrefix: 'YUME-CATALOGUE',
    measuredBy: 'anime_mappings.mal_id coverage',
    measure: async () => {
      const row = await queryOne<{ mapped: number, total: number }>(
        `SELECT (SELECT count(*)::int FROM anime_mappings WHERE mal_id IS NOT NULL) AS mapped,
                (SELECT count(*)::int FROM anime) AS total`)
      const mapped = Number(row?.mapped ?? 0)
      const total = Number(row?.total ?? 0)
      if (total === 0) return { status: 'unknown', detail: 'nothing imported, so nothing to map' }
      if (mapped === 0) return { status: 'unknown', detail: 'no MyAnimeList ids recorded' }
      return { status: 'operational', detail: `${mapped} of ${total} entries carry a MyAnimeList id` }
    }
  },
  {
    id: 'YUME-WEBHOOK-001',
    name: 'Outbound webhooks',
    dependsOn: ['YUME-DB-001', 'YUME-JOBS-001'],
    errorPrefix: 'YUME-WEBHOOK',
    measuredBy: 'webhook_deliveries, last 24 hours',
    measure: async () => {
      const enabled = await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM webhooks WHERE enabled')
      if (Number(enabled?.n ?? 0) === 0) return { status: 'unknown', detail: 'no webhook is enabled' }

      const row = await queryOne<{ ok: number, bad: number }>(
        `SELECT count(*) FILTER (WHERE error IS NULL)::int AS ok,
                count(*) FILTER (WHERE error IS NOT NULL)::int AS bad
           FROM webhook_deliveries
          WHERE created_at > now() - interval '24 hours'`)
      const ok = Number(row?.ok ?? 0)
      const bad = Number(row?.bad ?? 0)
      if (ok + bad === 0) return { status: 'unknown', detail: 'nothing delivered in the last 24 hours' }
      if (ok === 0) return { status: 'down', detail: `${bad} deliveries in 24 hours, none succeeded` }
      if (bad > ok) return { status: 'degraded', detail: `${bad} failed against ${ok} succeeded` }
      return { status: 'operational', detail: `${ok} succeeded, ${bad} failed in 24 hours` }
    }
  },
  {
    id: 'YUME-THEME-001',
    name: 'Theme engine',
    dependsOn: ['YUME-DB-001'],
    errorPrefix: 'YUME-THEME',
    measuredBy: 'the themes table and its default',
    measure: async () => {
      const row = await queryOne<{ total: number, def: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE is_default AND enabled)::int AS def
           FROM themes`)
      if (Number(row?.total ?? 0) === 0) return { status: 'down', detail: 'no themes exist — viewers have nothing to render' }
      if (Number(row?.def ?? 0) === 0) return { status: 'degraded', detail: 'no enabled default theme' }
      return { status: 'operational', detail: `${row?.total} themes, one enabled default` }
    }
  },
  {
    id: 'YUME-API-001',
    name: 'API',
    dependsOn: ['YUME-DB-001', 'YUME-AUTH-001'],
    errorPrefix: 'YUME-API',
    measuredBy: 'error_logs from the api source, last hour',
    measure: async () => {
      const row = await queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM error_logs
          WHERE source = 'api' AND created_at > now() - interval '1 hour'`)
      const n = Number(row?.n ?? 0)
      if (n > 50) return { status: 'down', detail: `${n} server faults in the last hour` }
      if (n > 5) return { status: 'degraded', detail: `${n} server faults in the last hour` }
      return { status: 'operational', detail: `${n} server fault${n === 1 ? '' : 's'} in the last hour` }
    }
  }
]

export interface ComponentHealth {
  id: string
  name: string
  dependsOn: string[]
  /** Derived from the edges above, never declared — the two cannot disagree. */
  usedBy: string[]
  errorPrefix: string
  measuredBy: string
  status: ComponentStatus
  detail: string
  /**
   * Dependencies that are themselves not healthy.
   *
   * The distinction that makes the graph worth drawing: a component can be
   * measurably fine while everything it stands on is broken, and an operator
   * looking at ten red rows needs to know which one to fix first.
   */
  failingDependencies: string[]
  /** Everything that would be affected if this one stayed broken. */
  affects: string[]
}

/** Everything reachable by following `usedBy` from `id`. */
function downstream (id: string, usedBy: Map<string, string[]>, seen = new Set<string>()): string[] {
  for (const dependent of usedBy.get(id) ?? []) {
    if (seen.has(dependent)) continue
    seen.add(dependent)
    downstream(dependent, usedBy, seen)
  }
  return [...seen]
}

/**
 * Measure everything and assemble the graph.
 *
 * `defs` exists for the tests. The behaviour worth pinning is the wrapper's —
 * that a measurement which throws becomes `unknown` rather than green, and
 * that nothing a probe error carries reaches the report — and there is no way
 * to make a real component throw on demand: a module namespace binding cannot
 * be reassigned, so mocking `probePostgres` from outside is not possible. A
 * definition passed in is the seam, and it is the honest one: the test drives
 * the same wrapper production does.
 */
export async function components (defs: Component[] = DEFINITIONS): Promise<{
  components: ComponentHealth[]
  summary: Record<ComponentStatus, number>
  generatedAt: string
}> {
  const measured = await Promise.all(defs.map(async def => {
    try {
      return { def, result: await def.measure() }
    } catch (err) {
      // A component whose measurement throws is not a healthy component.
      return { def, result: { status: 'unknown' as ComponentStatus, detail: `could not be measured: ${safeDetail(err)}` } }
    }
  }))

  const status = new Map(measured.map(m => [m.def.id, m.result.status]))
  const usedBy = new Map<string, string[]>()
  for (const { def } of measured) {
    for (const dependency of def.dependsOn) {
      usedBy.set(dependency, [...(usedBy.get(dependency) ?? []), def.id])
    }
  }

  const unhealthy = (id: string): boolean => {
    const s = status.get(id)
    return s === 'down' || s === 'degraded'
  }

  const list: ComponentHealth[] = measured.map(({ def, result }) => ({
    id: def.id,
    name: def.name,
    dependsOn: [...def.dependsOn],
    usedBy: usedBy.get(def.id) ?? [],
    errorPrefix: def.errorPrefix,
    measuredBy: def.measuredBy,
    status: result.status,
    detail: result.detail,
    failingDependencies: def.dependsOn.filter(unhealthy),
    affects: unhealthy(def.id) ? downstream(def.id, usedBy) : []
  }))

  const summary: Record<ComponentStatus, number> = { operational: 0, degraded: 0, down: 0, unknown: 0 }
  for (const c of list) summary[c.status]++

  return { components: list, summary, generatedAt: new Date().toISOString() }
}
