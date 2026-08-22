// Route-level integration tests.
//
// Until these existed, CI typechecked, ran unit tests, applied migrations and
// drained the worker — but never sent a single HTTP request at the assembled
// application. A commit that left every admin endpoint unauthenticated would
// have gone green.
//
// These use Fastify's built-in inject(), so there is no port to bind, no new
// dependency, and no flakiness from a race between "server started" and "test
// started". They need a database: CI provides one, and they skip cleanly when
// DATABASE_URL is absent so a laptop `npm test` still passes.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test, describe, before, after } from 'node:test'

import type { FastifyInstance } from 'fastify'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'integration-test-secret-long-enough-0123456789'
// The bypass test needs a limit low enough to reach, and headroom for the rest.
process.env.AUTH_RATE_LIMIT_MAX ??= '50'
process.env.RATE_LIMIT_MAX ??= '5000'

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

const unique = (): string => randomBytes(6).toString('hex')

describe('API integration', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
  })

  after(async () => {
    await app?.close()
    await pool?.end()
  })

  // ---- the shape every client depends on ----

  describe('public surface', () => {
    test('health answers without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/health' })
      assert.equal(res.statusCode, 200)
    })

    test('readiness answers without authentication', async () => {
      assert.equal((await app.inject({ url: '/v1/health/ready' })).statusCode, 200)
    })

    test('catalogue browse and search are public', async () => {
      for (const url of ['/v1/anime/?limit=2', '/v1/anime/search?q=a', '/v1/anime/suggest?q=a', '/v1/config']) {
        assert.equal((await app.inject({ url })).statusCode, 200, `${url} must be public`)
      }
    })

    test('a malformed query is rejected by schema, not by a crash', async () => {
      const res = await app.inject({ url: '/v1/anime/search?q=x&sort=DROP+TABLE' })
      assert.equal(res.statusCode, 400)
    })

    test('errors use the problem+json shape', async () => {
      const res = await app.inject({ url: '/v1/anime/by-anilist/999999999' })
      assert.equal(res.statusCode, 404)
      assert.deepEqual(Object.keys(res.json() as object).sort(), ['status', 'title', 'type'])
    })
  })

  // ---- the gate that matters most ----

  describe('authentication gates', () => {
    const PROTECTED = [
      '/v1/me/library',
      '/v1/admin/users',
      '/v1/admin/reports',
      '/v1/admin/monitoring/current',
      '/v1/admin/catalogue',
      '/v1/admin/roles',
      '/v1/admin/webhooks',
      '/v1/auth/permissions'
    ]

    for (const url of PROTECTED) {
      test(`${url} refuses an anonymous request`, async () => {
        assert.equal((await app.inject({ url })).statusCode, 401)
      })
    }

    test('a forged token is refused', async () => {
      const res = await app.inject({
        url: '/v1/me/library',
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.not-a-real-signature' }
      })
      assert.equal(res.statusCode, 401)
    })
  })

  // ---- permissions, end to end ----

  describe('authorization', () => {
    let token = ''
    let username = ''
    let profileId = ''

    before(async () => {
      username = 'itest_' + unique()
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
      })
      assert.equal(res.statusCode, 201, 'registration should succeed: ' + res.body)
      token = (res.json() as { accessToken: string }).accessToken
    })

    after(async () => { await pool.query('DELETE FROM users WHERE username = $1', [username]) })

    test('the library requires a profile to be named', async () => {
      // Not a bug: the library is per-profile, so the route refuses to guess.
      const res = await app.inject({ url: '/v1/me/library', headers: { authorization: `Bearer ${token}` } })
      assert.equal(res.statusCode, 400)
    })

    test('a signed-in user reaches their own profile library', async () => {
      // Deliberately not the default: a partial unique index allows only one
      // default profile per account, and registration may already have made it.
      const { rows } = await pool.query(
        `INSERT INTO user_profiles (user_id, display_name)
         SELECT id, 'itest' FROM users WHERE username = $1 RETURNING id`, [username])
      profileId = String(rows[0]!.id)

      const res = await app.inject({
        url: '/v1/me/library',
        headers: { authorization: `Bearer ${token}`, 'x-profile-id': profileId }
      })
      assert.equal(res.statusCode, 200)
    })

    test('another account\'s profile is refused, not silently served', async () => {
      // The header is client-supplied, so ownership has to be re-checked
      // server-side — otherwise anyone could read any profile's library.
      const { rows } = await pool.query(
        "SELECT id FROM user_profiles WHERE user_id <> (SELECT id FROM users WHERE username = $1) LIMIT 1",
        [username])
      if (!rows[0]) return // no other profile in this database to borrow

      const res = await app.inject({
        url: '/v1/me/library',
        headers: { authorization: `Bearer ${token}`, 'x-profile-id': String(rows[0].id) }
      })
      assert.equal(res.statusCode, 403, 'a profile belonging to another account must be refused')
    })

    test('an ordinary account is refused admin routes', async () => {
      for (const url of ['/v1/admin/users', '/v1/admin/catalogue', '/v1/admin/monitoring/current']) {
        const res = await app.inject({ url, headers: { authorization: `Bearer ${token}` } })
        assert.equal(res.statusCode, 403, `${url} must require a permission, got ${res.statusCode}`)
      }
    })

    test('granting the role opens exactly the gated route', async () => {
      const before = await app.inject({ url: '/v1/admin/catalogue', headers: { authorization: `Bearer ${token}` } })
      assert.equal(before.statusCode, 403)

      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
         ON CONFLICT DO NOTHING`, [username])

      // The permission cache is deliberately short-lived rather than
      // invalidated from outside, so the grant lands within its TTL.
      const auth = await import('../src/plugins/auth.ts')
      auth.invalidatePermissions()

      const after = await app.inject({ url: '/v1/admin/catalogue', headers: { authorization: `Bearer ${token}` } })
      assert.equal(after.statusCode, 200, 'the granted role should open the route')
    })
  })

  // ---- the finding that started the audit ----

  describe('rate limiting', () => {
    test('a spoofed X-Forwarded-For does not buy a fresh quota', async () => {
      const attempt = (headers: Record<string, string> = {}): Promise<number> =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          headers,
          payload: { identifier: 'nobody_' + unique(), password: 'wrong-password-but-long-enough' }
        }).then(res => res.statusCode)

      const max = Number(process.env.AUTH_RATE_LIMIT_MAX)
      for (let i = 0; i < max + 2; i++) await attempt()

      // The limit is now exhausted for this client. Varying the forwarded
      // header must NOT reset it — that was the original bypass.
      const spoofed: number[] = []
      for (let i = 0; i < 5; i++) spoofed.push(await attempt({ 'x-forwarded-for': `10.9.${i}.${i}` }))

      assert.ok(
        spoofed.every(code => code === 429),
        `spoofed requests must stay rate limited, got ${spoofed.join(', ')}`
      )
    })
  })
})
