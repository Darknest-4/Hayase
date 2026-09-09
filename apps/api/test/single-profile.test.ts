// One profile per account, and no way to make a second.
//
// The Netflix-style picker is gone from the product. This is what stops it
// growing back: the endpoints that created and deleted profiles no longer
// exist, and the database refuses a second row even if something bypassed
// them. Both halves matter — the row is what every user-data table hangs off,
// so a stray second profile would quietly split an account's library in two
// with nothing in the UI to switch between them.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'single-profile-test-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '50'
process.env.RATE_LIMIT_MAX ??= '5000'

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

describe('one profile per account', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  const username = 'sp_' + randomBytes(5).toString('hex')
  let token = ''
  let userId = ''

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/infrastructure/database/index.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, 'registration should succeed: ' + res.body)
    token = (res.json() as { accessToken: string }).accessToken
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    userId = String(rows[0]!.id)
  })

  after(async () => {
    await pool?.query('DELETE FROM users WHERE username = $1', [username])
    await app?.close()
    await pool?.end()
  })

  // A function, not a constant: the describe body runs before `before`, so a
  // header object built here would carry the empty token and every request
  // would come back 401.
  const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` })

  test('registration leaves the account exactly one profile', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM user_profiles WHERE user_id = $1', [userId])
    assert.equal(rows[0]!.n, 1)
  })

  test('the account can ask for its own profile', async () => {
    const res = await app.inject({ url: '/v1/profiles/me', headers: auth() })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { id: string, display_name: string }
    assert.ok(body.id, 'no profile returned')
    assert.equal(typeof body.display_name, 'string')
  })

  test('and can rename it, because that is an account setting now', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/profiles/me',
      headers: auth(),
      payload: { displayName: 'Renamed', nsfwEnabled: true }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { display_name: string, nsfw_enabled: boolean }
    assert.equal(body.display_name, 'Renamed')
    assert.equal(body.nsfw_enabled, true)
  })

  test('the routes that made and destroyed profiles are gone', async () => {
    // Not 403 or 400 — gone. A client calling them is calling something that
    // no longer exists, and the answer should say exactly that.
    const gone = [
      { method: 'POST' as const, url: '/v1/profiles', payload: { displayName: 'Second' } },
      { method: 'POST' as const, url: '/v1/profiles/', payload: { displayName: 'Second' } },
      { method: 'GET' as const, url: '/v1/profiles' },
      { method: 'DELETE' as const, url: '/v1/profiles/00000000-0000-4000-8000-000000000000' },
      { method: 'PATCH' as const, url: '/v1/profiles/00000000-0000-4000-8000-000000000000', payload: { displayName: 'x' } }
    ]
    for (const request of gone) {
      const res = await app.inject({ ...request, headers: auth() })
      assert.equal(res.statusCode, 404, `${request.method} ${request.url} should not exist, got ${res.statusCode}`)
    }
  })

  test('the database refuses a second profile even without the routes', async () => {
    // The constraint, not the absence of an endpoint, is what makes this true:
    // a script, a migration or a future feature would hit it too.
    await assert.rejects(
      () => pool.query("INSERT INTO user_profiles (user_id, display_name) VALUES ($1, 'Second')", [userId]),
      /unique|duplicate key/i,
      'a second profile must be refused by the database'
    )
  })

  test('asking twice gives the same profile, not a new one', async () => {
    const first = (await app.inject({ url: '/v1/profiles/me', headers: auth() })).json() as { id: string }
    const second = (await app.inject({ url: '/v1/profiles/me', headers: auth() })).json() as { id: string }
    assert.equal(first.id, second.id)
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM user_profiles WHERE user_id = $1', [userId])
    assert.equal(rows[0]!.n, 1)
  })
})
