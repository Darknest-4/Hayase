// Alerting state machine and diagnostic reporting. Pure logic — no database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { decide, humanDuration } from '../src/lib/alerts.ts'
import { formatReport } from '../src/lib/diagnostics.ts'

import type { AlertOptions, AlertRow, Reading } from '../src/lib/alerts.ts'
import type { DiagnosticReport, TestResult } from '../src/lib/diagnostics.ts'

const OPTIONS: AlertOptions = { debounceCycles: 3, recoveryCycles: 2, cooldownMs: 30 * 60_000 }
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)

const unhealthy = (severity: 'warning' | 'critical' = 'critical'): Reading =>
  ({ subject: 'disk.used_pct', kind: 'metric', severity, value: 95, threshold: 92 })
const healthy: Reading = { subject: 'disk.used_pct', kind: 'metric', severity: null, value: 40, threshold: 92 }

const row = (over: Partial<AlertRow> = {}): AlertRow => ({
  id: '1',
  subject: 'disk.used_pct',
  status: 'pending',
  severity: 'critical',
  streak: 1,
  healthy_streak: 0,
  started_at: new Date(NOW - 60_000).toISOString(),
  notified_at: null,
  ...over
})

describe('alert debounce', () => {
  it('opens a pending alert on the first unhealthy reading, without firing', () => {
    assert.deepEqual(decide(unhealthy(), undefined, OPTIONS, NOW), { action: 'open' })
  })

  it('does not fire before the condition has held for the full debounce', () => {
    // streak 1 → 2, still below 3
    assert.deepEqual(decide(unhealthy(), row({ streak: 1 }), OPTIONS, NOW), { action: 'accumulate' })
  })

  it('fires once the streak reaches the debounce threshold', () => {
    // streak 2 → 3 == debounceCycles
    assert.deepEqual(decide(unhealthy(), row({ streak: 2 }), OPTIONS, NOW), { action: 'fire' })
  })

  it('a single spike never fires — it resolves silently', () => {
    const pending = row({ streak: 1, status: 'pending' })
    assert.deepEqual(decide(healthy, pending, OPTIONS, NOW), { action: 'recovering' })
    const recovering = row({ streak: 1, status: 'pending', healthy_streak: 1 })
    // resolves, but notify=false because it never fired
    assert.deepEqual(decide(healthy, recovering, OPTIONS, NOW), { action: 'resolve', notify: false })
  })
})

describe('alert cooldown', () => {
  it('stays quiet while firing inside the cooldown window', () => {
    const firing = row({ status: 'firing', streak: 5, notified_at: new Date(NOW - 60_000).toISOString() })
    assert.deepEqual(decide(unhealthy(), firing, OPTIONS, NOW), { action: 'accumulate' })
  })

  it('re-notifies once the cooldown has elapsed', () => {
    const firing = row({ status: 'firing', streak: 5, notified_at: new Date(NOW - 31 * 60_000).toISOString() })
    assert.deepEqual(decide(unhealthy(), firing, OPTIONS, NOW), { action: 'renotify' })
  })

  it('re-notifies immediately when a warning escalates to critical', () => {
    const firing = row({ status: 'firing', severity: 'warning', streak: 5, notified_at: new Date(NOW - 60_000).toISOString() })
    assert.deepEqual(decide(unhealthy('critical'), firing, OPTIONS, NOW), { action: 'renotify' })
  })

  it('does not re-notify when a critical eases to a warning', () => {
    const firing = row({ status: 'firing', severity: 'critical', streak: 5, notified_at: new Date(NOW - 60_000).toISOString() })
    assert.deepEqual(decide(unhealthy('warning'), firing, OPTIONS, NOW), { action: 'accumulate' })
  })
})

describe('alert recovery', () => {
  it('waits for the recovery streak before resolving', () => {
    const firing = row({ status: 'firing', streak: 5, healthy_streak: 0 })
    assert.deepEqual(decide(healthy, firing, OPTIONS, NOW), { action: 'recovering' })
  })

  it('resolves and announces recovery for an alert that fired', () => {
    const firing = row({ status: 'firing', streak: 5, healthy_streak: 1 })
    assert.deepEqual(decide(healthy, firing, OPTIONS, NOW), { action: 'resolve', notify: true })
  })

  it('ignores healthy subjects with nothing open', () => {
    assert.deepEqual(decide(healthy, undefined, OPTIONS, NOW), { action: 'ignore' })
    assert.deepEqual(decide(healthy, row({ status: 'resolved' }), OPTIONS, NOW), { action: 'ignore' })
  })

  it('re-opens after a resolved alert comes back', () => {
    assert.deepEqual(decide(unhealthy(), row({ status: 'resolved' }), OPTIONS, NOW), { action: 'open' })
  })
})

describe('humanDuration', () => {
  it('scales the unit to the elapsed time', () => {
    assert.equal(humanDuration(new Date(NOW - 30_000).toISOString(), NOW), '30s')
    assert.equal(humanDuration(new Date(NOW - 5 * 60_000).toISOString(), NOW), '5m')
    assert.equal(humanDuration(new Date(NOW - 3 * 3600_000).toISOString(), NOW), '3h')
    assert.equal(humanDuration(new Date(NOW - 2 * 86400_000).toISOString(), NOW), '2d')
  })
})

describe('diagnostic report', () => {
  const result = (name: string, group: string, status: TestResult['status'], value: string): TestResult =>
    ({ name, group, status, value })

  const report: DiagnosticReport = {
    results: [
      result('CPU', 'Hardware', 'pass', '120M ops/s'),
      result('RAM', 'Hardware', 'pass', '9 GB/s'),
      result('Redis', 'Services', 'skip', 'not configured'),
      result('Postgres', 'Services', 'pass', '2ms'),
      result('API latency', 'Platform', 'warn', 'p95 420ms')
    ],
    passed: 3, warned: 1, failed: 0, skipped: 1
  }

  it('excludes skipped tests from the score', () => {
    const text = formatReport(report)
    // 4 scored tests (5 minus the skipped one), 3 of them passing
    assert.match(text, /TOTAL\s+3\/4 PASS/)
    assert.match(text, /1 WARN/)
    assert.match(text, /1 SKIPPED/)
  })

  it('lists every test with its status label', () => {
    const text = formatReport(report)
    for (const line of ['CPU', 'RAM', 'Redis', 'Postgres', 'API latency']) assert.ok(text.includes(line))
    assert.ok(text.includes('SKIP'))
    assert.ok(text.includes('WARN'))
  })

  it('groups tests under their headings', () => {
    const text = formatReport(report)
    assert.ok(text.indexOf('CPU') < text.indexOf('Postgres'), 'hardware group comes before services')
  })
})
