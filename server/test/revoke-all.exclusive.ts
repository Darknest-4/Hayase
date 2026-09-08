// Signing every account out of everything.
//
// Deliberately not named `*.test.ts`, so `npm test` does not pick it up. That
// is not squeamishness: the operation under test revokes every session in the
// database and bumps every account's token_version, which invalidates every
// access token that exists. `npm test` runs its files in parallel against one
// database, so running this among them killed the tokens the other suites were
// holding and failed fourteen of their tests — in adversarial, publishing and
// error triage, none of which have anything to do with this feature.
//
// The blast radius is the feature. There is no version of it scoped to one
// caller, and pretending otherwise would test something else. So it runs on
// its own:
//
//   npm run test:exclusive       (from server/, with DATABASE_URL set)
//
// which is also a step of its own in CI, next to test:integration and
// test:adversarial — the same shape the repository already uses for suites
// that need conditions the parallel run cannot give them.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'revoke-all-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('revoking every session', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  let adminToken = ''

  async function account (role?: string): Promise<{ token: string, username: string }> {
    const username = 'rv_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    if (role) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = $2
         ON CONFLICT DO NOTHING`, [username, role])
      const auth = await import('../src/plugins/auth.ts')
      auth.invalidatePermissions()
    }
    return { token: (res.json() as { accessToken: string }).accessToken, username }
  }

  const as = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool
    await app.ready()
    adminToken = (await account('admin')).token
  })

  after(async () => {
    try {
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  test('needs security.manage, and is hidden without it', async () => {
    const plain = await account()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/security/revoke-all-sessions',
      headers: as(plain.token),
      payload: { reason: 'should not be allowed' }
    })
    assert.equal(res.statusCode, 404, 'the route is visible to an ordinary account')
  })

  test('ends every session and invalidates every access token', async () => {
    const victim = await account()
    const before = await app.inject({ url: '/v1/auth/permissions', headers: as(victim.token) })
    assert.equal(before.statusCode, 200, 'precondition: the token works')

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/security/revoke-all-sessions',
      headers: as(adminToken),
      payload: { reason: 'signing key rotated' }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.ok(Number((res.json() as { revoked: number }).revoked) >= 1)

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now()')
    assert.equal(Number(rows[0].n), 0, 'a session survived')

    // Revoking the refresh tokens alone would leave access tokens working
    // until they expired, which on an incident timeline is exactly the window
    // that matters. The token version is what closes it.
    const after = await app.inject({ url: '/v1/auth/permissions', headers: as(victim.token) })
    assert.equal(after.statusCode, 401, 'an access token outlived the revocation')
  })

  test('signs the operator out too', async () => {
    // "Everybody except me" is not the guarantee this is meant to give: if the
    // reason for pulling it is a signing key you no longer trust, the caller's
    // own token is exactly as suspect as anybody else's.
    const res = await app.inject({ url: '/v1/admin/users', headers: as(adminToken) })
    assert.equal(res.statusCode, 401, 'the operator who pulled it stayed signed in')
  })

  test('is written to the audit log with its reason', async () => {
    const { rows } = await pool.query(
      `SELECT after FROM audit_logs
        WHERE action = 'user.sessions.revoke' AND subject_id = 'all-sessions'
        ORDER BY created_at DESC LIMIT 1`)
    assert.ok(rows.length, 'nothing recorded')
    assert.equal(rows[0].after.reason, 'signing key rotated')
    assert.equal(rows[0].after.sessions, 0)
  })

  test('leaves accounts able to sign back in', async () => {
    // Revocation is not a lockout: the credentials still work, the old tokens
    // do not.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { identifier: usernames[0], password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.ok((res.json() as { accessToken: string }).accessToken)
  })
})
