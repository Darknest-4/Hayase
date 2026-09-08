// The kill switches, enforced.
//
// `feature_flags` was read in exactly one place — routes/config.ts, which
// projects the table to the client — and enforced nowhere else. The client
// gates its own routing on the projection, so turning a feature off removed
// its page and left its API answering normally: comments could still be
// posted, watch-together rooms could still be created. Only the buttons went
// away.
//
// A switch that removes the button and leaves the door open is worse than no
// switch, because an operator believes they closed something.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'feature-flag-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('feature flags', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  let flags: typeof import('../src/modules/settings/feature-flags.ts').flags
  const usernames: string[] = []
  let token = ''

  async function account (): Promise<string> {
    const username = 'ff_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    return (res.json() as { accessToken: string }).accessToken
  }

  const as = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })

  /** Flip a flag and drop the cache, the way the admin write path does. */
  async function setFlag (key: string, enabled: boolean): Promise<void> {
    await pool.query('UPDATE feature_flags SET enabled = $2 WHERE key = $1', [key, enabled])
    flags.invalidate()
  }

  before(async () => {
    const [{ buildApp }, db, ff] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/settings/feature-flags.ts')
    ])
    app = await buildApp()
    pool = db.pool
    flags = ff.flags
    await app.ready()
    token = await account()
  })

  after(async () => {
    try {
      await setFlag('feature.comments', true)
      await setFlag('feature.watch_together', true)
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  test('comments answer normally while the feature is on', async () => {
    await setFlag('feature.comments', true)
    const res = await app.inject({ url: '/v1/comments/recent' })
    assert.notEqual(res.statusCode, 404, 'precondition: the route exists')
  })

  test('turning comments off closes the API, not only the button', async () => {
    await setFlag('feature.comments', false)

    // Every method, including the write — a client with a stale page must not
    // be able to post into a feature the instance has turned off.
    const calls = [
      { method: 'GET' as const, url: '/v1/comments/recent' },
      { method: 'GET' as const, url: '/v1/comments?subjectType=anime&subjectId=00000000-0000-0000-0000-000000000000' },
      { method: 'POST' as const, url: '/v1/comments', payload: { subjectType: 'anime', subjectId: '00000000-0000-0000-0000-000000000000', body: 'hello' } }
    ]
    for (const call of calls) {
      const res = await app.inject({ ...call, headers: as(token) })
      assert.equal(res.statusCode, 404, `${call.method} ${call.url} answered ${res.statusCode}`)
    }
  })

  // 404 rather than 403: an instance with comments turned off does not have
  // comments. "Forbidden" would describe a permission the caller might go and
  // acquire, which is not what happened.
  test('a disabled feature is absent, not forbidden', async () => {
    await setFlag('feature.comments', false)
    const res = await app.inject({ url: '/v1/comments/recent', headers: as(token) })
    assert.equal(res.statusCode, 404)
    assert.doesNotMatch(res.body, /permission|forbidden/i)
  })

  test('turning it back on reopens it', async () => {
    await setFlag('feature.comments', false)
    assert.equal((await app.inject({ url: '/v1/comments/recent' })).statusCode, 404)
    await setFlag('feature.comments', true)
    assert.notEqual((await app.inject({ url: '/v1/comments/recent' })).statusCode, 404)
  })

  test('watch together is switched independently', async () => {
    await setFlag('feature.comments', true)
    await setFlag('feature.watch_together', false)

    assert.equal((await app.inject({ method: 'POST', url: '/v1/w2g', headers: as(token), payload: {} })).statusCode, 404)
    // The other feature is untouched by it.
    assert.notEqual((await app.inject({ url: '/v1/comments/recent' })).statusCode, 404)

    await setFlag('feature.watch_together', true)
  })

  // The switch is about the instance, not the caller, so it applies before any
  // question of who is asking.
  test('a signed-out caller is refused the same way', async () => {
    await setFlag('feature.comments', false)
    const res = await app.inject({ url: '/v1/comments/recent' })
    assert.equal(res.statusCode, 404)
    await setFlag('feature.comments', true)
  })

  test('a key nobody has configured counts as on', async () => {
    // Deleting a row must not disable a feature: the table lists what somebody
    // chose to make switchable, and a missing key is not a decision to turn
    // something off. Migration 0033 removes three rows on exactly this basis.
    assert.equal(await flags.enabled('feature.nothing_has_ever_defined_this'), true)
  })

  test('the dead switches are gone', async () => {
    // They toggled features with no API and no UI, or duplicated a setting
    // that is actually enforced. See migration 0033.
    const { rows } = await pool.query(
      `SELECT key FROM feature_flags
        WHERE key IN ('feature.reviews', 'feature.custom_lists', 'feature.registration')`)
    assert.deepEqual(rows, [], 'a flag that switches nothing is still in the catalogue')
  })
})
