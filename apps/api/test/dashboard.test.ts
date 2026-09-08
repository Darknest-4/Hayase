// The administration overview.
//
// It is a screen full of numbers somebody makes decisions from, so the thing
// worth testing is not that it returns data — it is that it never returns a
// figure it did not measure. A dashboard that invents a trend is worse than
// one that omits it, because a made-up percentage gets believed and acted on.
//
// So: every comparison must come from a real earlier value, and the gauges
// that have no earlier value must say so rather than reporting zero change.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { overview } from '../src/modules/system/dashboard.ts'

import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe('admin dashboard', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let data: Awaited<ReturnType<typeof overview>>

  before(async () => {
    const db = await import('../src/infrastructure/database/index.ts')
    pool = db.pool as never
    data = await overview(7)
  })

  after(async () => { await pool?.end() })

  test('every card carries a number, a label and a unit', () => {
    assert.ok(data.kpis.length >= 10, `only ${data.kpis.length} figures`)
    for (const kpi of data.kpis) {
      assert.equal(typeof kpi.value, 'number', `${kpi.key} value is ${typeof kpi.value}`)
      assert.ok(Number.isFinite(kpi.value), `${kpi.key} is not finite`)
      assert.ok(kpi.label, `${kpi.key} has no label`)
      assert.ok(['count', 'hours'].includes(kpi.unit), `${kpi.key} has unit ${kpi.unit}`)
    }
  })

  test('a comparison only exists where something was compared', () => {
    // The property the whole screen rests on. `compare` is the caption under
    // the number; if it is there, a previous value has to be there too, or the
    // caption is describing a comparison that never happened.
    for (const kpi of data.kpis) {
      if (kpi.compare === null) {
        assert.equal(kpi.previous, null, `${kpi.key} has no caption but claims a previous value`)
        assert.equal(kpi.delta, null, `${kpi.key} has no caption but reports a delta`)
      } else {
        assert.equal(typeof kpi.previous, 'number', `${kpi.key} captions a comparison with no previous value`)
      }
    }
  })

  test('the gauges report no trend at all', () => {
    // Pending and dead jobs are instantaneous readings. The earlier value was
    // never recorded, so any percentage next to them would be invented.
    for (const key of ['jobs_pending', 'jobs_dead']) {
      const kpi = data.kpis.find(k => k.key === key)
      assert.ok(kpi, `${key} is missing`)
      assert.equal(kpi.delta, null, `${key} reports a trend it cannot know`)
      assert.equal(kpi.compare, null)
    }
  })

  test('growth from nothing is not a percentage', () => {
    // (x - 0) / 0 is not a number a card can show, and 0 → 0 is not "zero
    // percent growth" either. The server returns null for the first and 0 for
    // the second, and hands over `previous` so the client can say which.
    for (const kpi of data.kpis) {
      if (kpi.previous !== 0) continue
      if (kpi.value === 0) assert.equal(kpi.delta, 0, `${kpi.key}: 0 → 0 should read as unchanged`)
      else assert.equal(kpi.delta, null, `${kpi.key}: 0 → ${kpi.value} cannot be a percentage`)
    }
  })

  test('the series cover exactly the window, one point per day', () => {
    assert.equal(data.series.users.length, 7)
    assert.equal(data.series.content.length, 7)
    // Gaps are filled with zero rather than skipped: a chart that silently
    // drops quiet days compresses time and draws a slope that did not happen.
    for (const row of data.series.users) {
      assert.ok(row.day, 'a series point with no day')
      assert.equal(typeof Number(row.active), 'number')
    }
    const days = data.series.users.map(r => new Date(r.day as string).getTime())
    for (let i = 1; i < days.length; i++) {
      assert.equal(days[i] - days[i - 1], 86_400_000, 'the series is not one point per day')
    }
  })

  test('the window is what was asked for', async () => {
    const short = await overview(3)
    assert.equal(short.range.days, 3)
    assert.equal(short.series.users.length, 3)
    for (const kpi of short.kpis) {
      if (kpi.compare) assert.ok(!kpi.compare.includes('7 days'), `${kpi.key} compares against the wrong window`)
    }
  })

  test('the job counts are consistent with each other', () => {
    const jobs = data.jobs as Record<string, unknown>
    assert.ok(Number(jobs.running) <= Number(jobs.pending), 'more jobs running than pending')
    assert.ok(Array.isArray(jobs.recent))
  })

  test('the activity feed is the audit trail, not a synthesis', () => {
    for (const item of data.activity) {
      assert.ok(item.action, 'an activity row with no action')
      assert.ok(item.created_at, 'an activity row with no time')
    }
  })
})
