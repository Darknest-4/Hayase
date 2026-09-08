// The component registry, and whether its health means anything.
//
// The instruction this was built from was "no fake health status", repeated.
// It is trivially easy to write a registry that reports Operational for
// everything because nothing is measuring anything, and such a page is worse
// than none: it answers the question an operator came to ask, wrongly, and
// they stop looking.
//
// So most of these are about honesty rather than about any one component:
// something unmeasurable says so, a measurement that throws does not become
// green, the reverse edges are derived rather than declared, and the blast
// radius follows the graph.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'components-secret-long-enough-0123456789'

describe('component registry', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let components: typeof import('../src/lib/components.ts').components

  before(async () => {
    const [db, mod] = await Promise.all([
      import('../src/db.ts'),
      import('../src/lib/components.ts')
    ])
    pool = db.pool
    components = mod.components
  })

  after(async () => { await pool?.end() })

  test('every component says what its status was measured from', async () => {
    const { components: list } = await components()
    assert.ok(list.length >= 8, `only ${list.length} components`)
    for (const c of list) {
      // A status a reader cannot go and verify is a claim, not a measurement.
      assert.ok(c.measuredBy && c.measuredBy.length > 5, `${c.id} does not say what it measured`)
      assert.ok(c.detail && c.detail.length > 5, `${c.id} does not say what it found`)
      assert.ok(['operational', 'degraded', 'down', 'unknown'].includes(c.status), `${c.id}: ${c.status}`)
      // The id is the error-code namespace too, so it has to look like one.
      assert.match(c.id, /^YUME-[A-Z0-9-]+-\d{3}$/, `${c.id} is not a component id`)
      assert.match(c.errorPrefix, /^YUME-[A-Z]+$/, `${c.id} has no error prefix`)
    }
  })

  test('says unknown rather than operational when there is nothing to measure', async () => {
    // A metadata sync that has never run has no health to report. Rounding
    // that up to green is precisely the invention this registry exists to
    // avoid — and on a fresh instance most of it is legitimately unknown.
    await pool.query("DELETE FROM metadata_runs WHERE status IN ('queued','running')")
    const { components: list } = await components()
    const sync = list.find(c => c.id === 'YUME-SYNC-001')
    assert.ok(sync)
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM metadata_runs')
    if (Number(rows[0].n) === 0) {
      assert.equal(sync.status, 'unknown')
      assert.match(sync.detail, /has ever been started/)
    }
  })

  test('the counts add up to the components', async () => {
    const { components: list, summary } = await components()
    const total = summary.operational + summary.degraded + summary.down + summary.unknown
    assert.equal(total, list.length)
  })

  test('the reverse edges are derived, so they cannot disagree', async () => {
    const { components: list } = await components()
    const byId = new Map(list.map(c => [c.id, c]))

    for (const c of list) {
      for (const dependency of c.dependsOn) {
        const target = byId.get(dependency)
        assert.ok(target, `${c.id} depends on ${dependency}, which is not a component`)
        assert.ok(target.usedBy.includes(c.id),
          `${dependency} does not list ${c.id} among what uses it`)
      }
      for (const dependent of c.usedBy) {
        assert.ok(byId.get(dependent)?.dependsOn.includes(c.id),
          `${c.id} claims ${dependent} uses it, but ${dependent} does not depend on it`)
      }
    }
  })

  test('nothing depends on a component that is not in the registry', async () => {
    const { components: list } = await components()
    const ids = new Set(list.map(c => c.id))
    for (const c of list) {
      for (const dependency of c.dependsOn) {
        assert.ok(ids.has(dependency), `${c.id} depends on the unknown ${dependency}`)
      }
    }
  })

  test('a healthy component claims no blast radius', async () => {
    // `affects` is what would break if this stayed broken. A component that is
    // working is not breaking anything, and filling it in anyway would make
    // every card look alarming.
    const { components: list } = await components()
    for (const c of list) {
      if (c.status === 'operational' || c.status === 'unknown') {
        assert.deepEqual(c.affects, [], `${c.id} is ${c.status} but claims to be affecting things`)
      }
    }
  })

  test('a broken foundation is named by everything standing on it', async () => {
    // The reason to draw the graph at all: when several rows are red, which
    // one do you fix? The answer is the one nothing else is blocking.
    const { components: list } = await components()
    const db = list.find(c => c.id === 'YUME-DB-001')
    assert.ok(db)
    // It is healthy here, so the assertion is about the shape rather than the
    // state: everything that names the database as a dependency must be
    // reachable from the database's own `usedBy`.
    const standingOnIt = list.filter(c => c.dependsOn.includes('YUME-DB-001')).map(c => c.id)
    assert.ok(standingOnIt.length >= 4, 'the database carries less than expected')
    for (const id of standingOnIt) assert.ok(db.usedBy.includes(id))
  })

  // The two below drive the wrapper with definitions of their own. A module
  // namespace binding cannot be reassigned, so there is no way to make a real
  // component throw from outside — and the behaviour under test belongs to the
  // wrapper, which is the same one production runs.
  const throwing = (message: string) => [{
    id: 'YUME-TEST-001',
    name: 'Deliberately broken',
    dependsOn: [],
    errorPrefix: 'YUME-API',
    measuredBy: 'a measurement that throws',
    measure: async () => { throw new Error(message) }
  }]

  test('a measurement that throws is unknown, not operational', async () => {
    // "We could not tell" and "it is fine" are different answers.
    const { components: list } = await components(throwing('the probe itself is broken') as never)
    assert.equal(list.length, 1)
    assert.equal(list[0].status, 'unknown', 'a throwing measurement was reported as healthy')
    assert.match(list[0].detail, /could not be measured/)
  })

  test('never leaks a connection string out of a failed measurement', async () => {
    // Probe errors carry the DSN they were dialling. safeDetail strips it, and
    // this is the assertion that keeps that true through the registry.
    const secret = 'postgres://someone:hunter2@db.internal:5432/yume'
    const { components: list } = await components(
      throwing(`connect ECONNREFUSED ${secret}`) as never)
    const serialised = JSON.stringify(list)
    assert.ok(!serialised.includes('hunter2'), 'a credential reached the report')
    assert.ok(!serialised.includes('db.internal'), 'an internal hostname reached the report')
  })

  test('is generated fresh', async () => {
    const first = await components()
    await new Promise(resolve => setTimeout(resolve, 1100))
    const second = await components()
    assert.notEqual(first.generatedAt, second.generatedAt)
  })

  test('the error prefixes match codes the server actually emits', async () => {
    // A component whose error namespace does not exist in lib/error-codes.ts
    // sends an operator looking for codes that are never produced.
    const { errorCode } = await import('../src/lib/error-codes.ts')
    const { components: list } = await components()
    const produced = new Set([
      '/v1/auth/x', '/v1/anime/x', '/v1/admin/catalogue/x', '/v1/admin/webhooks/x',
      '/v1/admin/themes/x', '/v1/admin/users', '/v1/comments', '/v1/me/x', '/v1/nothing'
    ].map(route => errorCode(route, 500).replace(/-\d{3}$/, '')))
    // YUME-JOBS is emitted by the worker rather than by a route, so it is
    // allowed not to appear in the route-derived set.
    const routeless = new Set(['YUME-JOBS'])
    for (const c of list) {
      if (routeless.has(c.errorPrefix)) continue
      assert.ok(produced.has(c.errorPrefix),
        `${c.id} claims the prefix ${c.errorPrefix}, which no route produces`)
    }
  })
})
