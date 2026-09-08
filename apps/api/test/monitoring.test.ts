// Unit tests for the VPS monitoring layer. Pure logic only — no database and
// no network, so they run anywhere:  npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { collectHost, diskUsage, memory } from '../src/lib/metrics.ts'
import { overall, safeDetail } from '../src/lib/probes.ts'
import { DEFAULTS, compare, worst } from '../src/lib/thresholds.ts'
import { toSamples } from '../src/workers/monitor.ts'

import type { ProbeResult } from '../src/lib/probes.ts'

describe('thresholds', () => {
  it('classifies below warn as green, at/above warn as yellow, at/above crit as red', () => {
    const t = { warn: 80, crit: 92, unit: 'pct', rationale: 'test' }
    assert.equal(compare(0, t), 'green')
    assert.equal(compare(79.9, t), 'green')
    assert.equal(compare(80, t), 'yellow')
    assert.equal(compare(91.9, t), 'yellow')
    assert.equal(compare(92, t), 'red')
    assert.equal(compare(100, t), 'red')
  })

  it('rolls a set of levels up to the worst one', () => {
    assert.equal(worst(['green', 'green']), 'green')
    assert.equal(worst(['green', 'yellow']), 'yellow')
    assert.equal(worst(['green', 'yellow', 'red']), 'red')
    assert.equal(worst([]), 'green')
  })

  it('documents every default threshold with a rationale and sane ordering', () => {
    for (const [metric, t] of Object.entries(DEFAULTS)) {
      assert.ok(t.rationale.length > 20, `${metric} needs a documented rationale`)
      assert.ok(t.warn < t.crit, `${metric}: warn must be below crit`)
      assert.ok(t.unit.length > 0, `${metric} needs a unit`)
    }
  })
})

describe('probe roll-up', () => {
  const probe = (service: string, status: ProbeResult['status']): ProbeResult =>
    ({ service, status, latencyMs: 1, detail: null })

  it('is HEALTHY when everything configured is green', () => {
    assert.equal(overall([probe('postgres', 'green'), probe('api', 'green')]), 'HEALTHY')
  })

  it('ignores services that are not configured', () => {
    assert.equal(
      overall([probe('postgres', 'green'), probe('redis', 'not_configured'), probe('minio', 'not_configured')]),
      'HEALTHY'
    )
  })

  it('is UNHEALTHY only when the hard dependency is down', () => {
    assert.equal(overall([probe('postgres', 'red'), probe('api', 'green')]), 'UNHEALTHY')
    // an optional service being down degrades, it does not take the site out
    assert.equal(overall([probe('postgres', 'green'), probe('redis', 'red')]), 'DEGRADED')
    assert.equal(overall([probe('postgres', 'green'), probe('api', 'yellow')]), 'DEGRADED')
  })
})

describe('detail redaction', () => {
  it('never leaks connection strings, credentials or addresses', () => {
    const cases = [
      'connect ECONNREFUSED 10.0.0.5:6379',
      'failed to reach postgres://yume:hunter2@db.internal:5432/yume',
      'getaddrinfo ENOTFOUND redis://user:secret@cache'
    ]
    for (const message of cases) {
      const safe = safeDetail(new Error(message))
      assert.doesNotMatch(safe, /hunter2|secret|:\/\//, `leaked in: ${safe}`)
      assert.doesNotMatch(safe, /\b\d{1,3}(\.\d{1,3}){3}\b/, `leaked an IP in: ${safe}`)
      assert.ok(safe.length <= 120)
    }
  })
})

describe('sample mapping', () => {
  const host = {
    cpuUsagePct: 42.5, cores: 4, load1: 1.2, load5: 1, load15: 1, loadPerCore: 0.3,
    uptimeSec: 3600,
    memory: { totalBytes: 1000, availableBytes: 400, usedBytes: 600, usedPct: 60, swapTotalBytes: 0, swapUsedBytes: 0, swapUsedPct: 0 },
    disk: { path: '/', totalBytes: 500, freeBytes: 200, usedBytes: 300, usedPct: 60 },
    diskIo: { readBps: 10, writeBps: 20, iops: 5, awaitMs: 2 },
    network: { rxBps: 100, txBps: 200, dropPct: 0 },
    netLatencyMs: 30
  }
  const probes: ProbeResult[] = [
    { service: 'api', status: 'green', latencyMs: 12, detail: null },
    { service: 'postgres', status: 'green', latencyMs: 3, detail: null }
  ]

  it('maps probe latencies onto their metric names', () => {
    const samples = toSamples(host, probes, { pending: 7, dead: 0 })
    const byMetric = new Map(samples.map(s => [s.metric, s.value]))
    assert.equal(byMetric.get('api.latency_ms'), 12)
    assert.equal(byMetric.get('db.latency_ms'), 3)
    assert.equal(byMetric.get('cpu.usage_pct'), 42.5)
    assert.equal(byMetric.get('queue.pending'), 7)
  })

  it('skips missing readings instead of storing nulls or NaN', () => {
    const degraded = { ...host, cpuUsagePct: null, netLatencyMs: null, disk: null, diskIo: null, network: null }
    const samples = toSamples(degraded, [], { pending: 0, dead: 0 })
    const names = samples.map(s => s.metric)
    assert.ok(!names.includes('cpu.usage_pct'))
    assert.ok(!names.includes('disk.used_pct'))
    assert.ok(!names.includes('net.latency_ms'))
    // the readings that survived are still there and are all finite
    assert.ok(names.includes('mem.used_pct'))
    for (const sample of samples) assert.ok(Number.isFinite(sample.value), `${sample.metric} is not finite`)
  })

  it('drops non-finite values defensively', () => {
    const broken = { ...host, loadPerCore: NaN, uptimeSec: Infinity }
    const names = toSamples(broken, [], { pending: 0, dead: 0 }).map(s => s.metric)
    assert.ok(!names.includes('cpu.load_per_core'))
    assert.ok(!names.includes('host.uptime_sec'))
  })
})

describe('host collectors (real readings)', () => {
  it('reports memory within believable bounds', async () => {
    const mem = await memory()
    assert.ok(mem.totalBytes > 0)
    assert.ok(mem.usedPct >= 0 && mem.usedPct <= 100)
    assert.ok(mem.usedBytes <= mem.totalBytes)
  })

  it('reports disk usage as a percentage of a non-empty filesystem', async () => {
    const disk = await diskUsage('/')
    assert.ok(disk, 'statfs should work on /')
    assert.ok(disk!.totalBytes > 0)
    assert.ok(disk!.usedPct >= 0 && disk!.usedPct <= 100)
  })

  it('returns a complete snapshot without throwing', async () => {
    const snapshot = await collectHost()
    assert.ok(snapshot.cores >= 1)
    assert.ok(snapshot.uptimeSec > 0)
    assert.ok(snapshot.loadPerCore >= 0)
    if (snapshot.cpuUsagePct !== null) {
      assert.ok(snapshot.cpuUsagePct >= 0 && snapshot.cpuUsagePct <= 100)
    }
  })

  it('never throws when the filesystem path does not exist', async () => {
    assert.equal(await diskUsage('/no/such/path/here'), null)
  })
})
