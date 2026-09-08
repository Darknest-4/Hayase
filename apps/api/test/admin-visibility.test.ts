// The administration surface answers 404, not 403, to an account without it.
//
// A 403 there is a map: it confirms the panel exists, that this account is
// simply not in it, and — in the old message — which permission to go after.
// For a surface whose *existence* is the information, the honest answer is the
// one a non-existent route would give.
//
// Only that surface. 403 stays everywhere else: "this exists, you cannot do
// it" lets a legitimate user ask for access, while a blanket 404 turns every
// permission mistake into a support ticket about a broken link.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'admin-visibility-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('administration is invisible without permission', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  let plain = ''
  let admin = ''

  async function account (role?: string): Promise<string> {
    const username = 'vis_' + randomBytes(5).toString('hex')
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
    return (res.json() as { accessToken: string }).accessToken
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
    plain = await account()
    admin = await account('admin')
  })

  after(async () => {
    if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    await app?.close()
    await pool?.end()
  })

  const ADMIN_ROUTES = [
    '/v1/admin/users',
    '/v1/admin/catalogue',
    '/v1/admin/reports',
    '/v1/admin/analytics/overview',
    '/v1/admin/monitoring/current'
  ]

  test('an ordinary account gets 404 from every admin route', async () => {
    for (const url of ADMIN_ROUTES) {
      const res = await app.inject({ url, headers: { authorization: `Bearer ${plain}` } })
      assert.equal(res.statusCode, 404, `${url} answered ${res.statusCode}`)
    }
  })

  test('the 404 body says nothing about permissions', async () => {
    // Naming the missing permission would undo the point of the status code.
    const res = await app.inject({ url: '/v1/admin/users', headers: { authorization: `Bearer ${plain}` } })
    const body = res.body.toLowerCase()
    for (const word of ['permission', 'forbidden', 'admin', 'role']) {
      assert.ok(!body.includes(word), `the reply leaked "${word}": ${res.body}`)
    }
  })

  test('an account that has the permission still gets in', async () => {
    // The other half: hiding it from everybody would be easy and useless.
    const res = await app.inject({ url: '/v1/admin/users', headers: { authorization: `Bearer ${admin}` } })
    assert.equal(res.statusCode, 200, res.body)
  })

  test('every module mounted under /v1/admin is hidden, not just admin.ts', async () => {
    // Seven route modules sit under that prefix — catalogue, roles, webhooks,
    // translations, monitoring and config as well as admin.ts. Hiding one file
    // and calling it done would leave six ways to confirm the panel exists.
    for (const url of [
      '/v1/admin/catalogue/anime',
      '/v1/admin/roles',
      '/v1/admin/webhooks',
      '/v1/admin/config',
      '/v1/admin/monitoring/current',
      '/v1/admin/translations/anime'
    ]) {
      const res = await app.inject({ url, headers: { authorization: `Bearer ${plain}` } })
      assert.notEqual(res.statusCode, 403, `${url} still answers 403`)
    }
  })

  test('an unauthenticated request is still 401, not 404', async () => {
    // Without a token there is no account to hide the route from, and 401 is
    // what tells a client to sign in rather than to give up.
    for (const url of ADMIN_ROUTES) {
      assert.equal((await app.inject({ url })).statusCode, 401, url)
    }
  })

  test('a public route does not hide itself behind its permission', async () => {
    // The change is scoped to the administration surface. The comments
    // endpoint is no secret, so an ordinary member reaches the handler and is
    // answered on the merits — here, that the anime does not exist. Reaching
    // the handler at all is the assertion: a hidden route would have been
    // refused by the permission layer before getting this far.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/comments',
      headers: { authorization: `Bearer ${plain}` },
      payload: { subjectType: 'anime', subjectId: '00000000-0000-0000-0000-000000000000', body: 'hello there' }
    })
    assert.match(res.body, /Unknown anime/, `expected the handler's own answer, got: ${res.body}`)
  })
})
