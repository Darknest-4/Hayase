// The posture, and whether the number means anything.
//
// The brief asked for "Security Score: 94/100". A score is worth exactly what
// the checks behind it are worth, and a score with nothing behind it is the
// most confident lie a dashboard can tell — the reader sees 94 and stops
// looking. So most of this file is about the relationship between the checks
// and the number, not about any individual verdict:
//
//   * the number is arithmetic over the checks, and moves when they do;
//   * a check that cannot apply here does not quietly cost points;
//   * a check that throws is reported as unknown, because "we could not tell"
//     and "it is fine" are different answers;
//   * every check says what it inspected, so a verdict can be checked rather
//     than believed.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, mock, test } from 'node:test'

import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'posture-secret-long-enough-0123456789'

describe('security posture', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let posture: typeof import('../src/lib/security-posture.ts').posture
  const hookIds: string[] = []

  before(async () => {
    const [db, sp] = await Promise.all([
      import('../src/db.ts'),
      import('../src/lib/security-posture.ts')
    ])
    pool = db.pool
    posture = sp.posture
  })

  after(async () => {
    try {
      if (hookIds.length) await pool.query('DELETE FROM webhooks WHERE id = ANY($1)', [hookIds])
    } finally {
      await pool?.end()
    }
  })

  test('every check says what it looked at and what it found', async () => {
    const { checks } = await posture()
    assert.ok(checks.length >= 10, `only ${checks.length} checks`)
    for (const c of checks) {
      // A verdict a reader cannot go and verify is an assertion, not a check.
      assert.ok(c.looksAt && c.looksAt.length > 3, `${c.id} does not say what it inspected`)
      assert.ok(c.found && c.found.length > 5, `${c.id} does not say what it found`)
      assert.ok(['pass', 'warn', 'fail', 'skipped', 'unknown'].includes(c.verdict), `${c.id}: ${c.verdict}`)
      // Anything not passing has to say what to do about it, or the page is a
      // list of complaints.
      if (c.verdict === 'warn' || c.verdict === 'fail') {
        assert.ok(c.remedy, `${c.id} is ${c.verdict} with no remedy`)
      }
    }
  })

  test('the counts add up to the checks', async () => {
    const { checks, summary } = await posture()
    const total = summary.pass + summary.warn + summary.fail + summary.skipped + summary.unknown
    assert.equal(total, checks.length, 'the summary counts something other than the checks')
  })

  test('the score is derived from the checks, not decided separately', async () => {
    const { checks, summary } = await posture()
    assert.ok(summary.score !== null)
    assert.ok(summary.score >= 0 && summary.score <= 100, `score ${summary.score}`)

    // The direction has to hold: all-passing is 100, and anything failing is
    // not. Without this the number could be a constant and every other
    // assertion here would still pass.
    const applicable = checks.filter(c => c.verdict !== 'skipped')
    if (applicable.every(c => c.verdict === 'pass')) {
      assert.equal(summary.score, 100)
    } else {
      assert.ok(summary.score < 100, 'something is not passing but the score is perfect')
    }
  })

  test('a check that cannot apply here does not cost points', async () => {
    // Running outside production, HSTS is skipped: sending it over plain http
    // would lock a browser out of the instance. A skipped check must leave the
    // denominator alone rather than quietly making a healthy instance look bad.
    const { checks, summary } = await posture()
    const hsts = checks.find(c => c.id === 'hsts')
    assert.ok(hsts)
    assert.equal(hsts.verdict, 'skipped', 'expected HSTS to be skipped outside production')
    assert.ok(summary.skipped >= 1)

    // With every applicable check passing the score is 100 even though a
    // skipped one exists.
    const applicable = checks.filter(c => c.verdict !== 'skipped')
    assert.ok(applicable.length > 0, 'everything was skipped, which proves nothing')
  })

  test('the score moves when a check does', async () => {
    const before = await posture()

    // A real finding, made real: an enabled webhook posting over plain http.
    // The payload and its signature would travel in the clear.
    const { rows } = await pool.query(
      `INSERT INTO webhooks (name, url, format, events, enabled, secret)
       VALUES ($1, 'http://insecure.invalid/hook', 'json', ARRAY['user.registered']::text[], true, 'a-secret')
       RETURNING id`, ['posture_' + randomBytes(4).toString('hex')])
    hookIds.push(String(rows[0].id))

    const after = await posture()
    const check = after.checks.find(c => c.id === 'webhook-transport')
    assert.equal(check?.verdict, 'fail', 'a plain-http webhook did not register')
    assert.match(String(check?.found), /http/)
    assert.ok(after.summary.score < before.summary.score, 'the score ignored a new failure')

    await pool.query('DELETE FROM webhooks WHERE id = $1', [rows[0].id])
    hookIds.pop()

    const restored = await posture()
    assert.equal(restored.summary.score, before.summary.score, 'the score did not come back')
  })

  test('never puts the signing secret in the report', async () => {
    // The check reads JWT_SECRET. Its finding is the length and whether it is
    // the placeholder — never the value, never a prefix of it.
    const { checks } = await posture()
    const jwt = checks.find(c => c.id === 'jwt-secret')
    assert.ok(jwt)
    const serialised = JSON.stringify(checks)
    assert.ok(!serialised.includes(process.env.JWT_SECRET as string), 'the secret is in the report')
  })

  test('reports a broken check as unknown rather than passing it', async () => {
    // "We could not tell" and "it is fine" are different answers, and a
    // posture that rounds the first to the second is worse than no posture.
    //
    // Broken through the reader the check actually calls. A module namespace
    // binding cannot be reassigned, and `settings` is a plain exported object
    // for exactly this reason — see the header of lib/site-settings.ts.
    const { settings } = await import('../src/lib/site-settings.ts')
    mock.method(settings, 'requiresLogin', async () => { throw new Error('the reader is broken') })
    try {
      const { checks, summary } = await posture()
      const broken = checks.find(c => c.id === 'private-instance')
      assert.equal(broken?.verdict, 'unknown', 'a check that threw reported something other than unknown')
      assert.match(String(broken?.found), /could not run/)
      assert.ok(summary.unknown >= 1)
      // And it costs points rather than being waved through.
      assert.ok(summary.score !== null && summary.score < 100)
    } finally {
      mock.restoreAll()
    }
  })

  test('is generated fresh, with the time it was taken', async () => {
    // Not cached: a posture that can be stale is one that can be wrong at the
    // moment somebody is relying on it.
    const first = await posture()
    await new Promise(resolve => setTimeout(resolve, 1100))
    const second = await posture()
    assert.notEqual(first.generatedAt, second.generatedAt)
  })
})
