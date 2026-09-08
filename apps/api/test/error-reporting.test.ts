// Can a failure be reported, and can the report be looked up?
//
// The server has always answered a 500 with "Request <id> failed — quote this
// id when reporting it". Two things made that sentence a dead end:
//
//   * the client dropped the id. `_request` threw `new Error(detail)`, so the
//     message reached the screen and the id did not.
//   * nothing stored it. `error_logs.context` carried the route, the method
//     and the status, but not the request id — so an operator handed the
//     number had nowhere to search for it.
//
// Both halves have to hold for the sentence to be true, so this file follows
// one failure the whole way: the response carries a code and an id, the
// occurrence records both, and the lookup finds it.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { errorCode } from '../src/errors/codes.ts'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'error-reporting-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('error codes', () => {
  // Derived from the route and the status rather than enumerated, so these
  // assert the derivation rules rather than a list somebody has to maintain.
  test('names the component from the route', () => {
    assert.equal(errorCode('/v1/auth/login', 401), 'YUME-AUTH-401')
    assert.equal(errorCode('/v1/anime/:id', 500), 'YUME-ANIME-500')
    assert.equal(errorCode('/v1/comments', 400), 'YUME-COMMENT-400')
  })

  test('prefers the longest matching prefix', () => {
    // /v1/admin/catalogue is CATALOGUE, not ADMIN — otherwise every admin
    // failure would collapse into one component and the code would say
    // nothing useful.
    assert.equal(errorCode('/v1/admin/catalogue/:id', 500), 'YUME-CATALOGUE-500')
    assert.equal(errorCode('/v1/admin/security/read_only', 403), 'YUME-SECURITY-403')
    assert.equal(errorCode('/v1/admin/users', 500), 'YUME-ADMIN-500')
  })

  test('a 404 never names a component', () => {
    // The admin surface answers 404 rather than 403 so an account without
    // permission cannot tell a route it may not open from one that is not
    // there. A code saying ADMIN hands that back on the very reply meant to
    // hide it.
    assert.equal(errorCode('/v1/admin/users', 404), 'YUME-API-404')
    assert.equal(errorCode('/v1/admin/catalogue/:id', 404), 'YUME-API-404')
    assert.equal(errorCode('/v1/anime/:id', 404), 'YUME-API-404')
  })

  test('falls back rather than throwing on a route it does not know', () => {
    // A new prefix must produce a usable code the day it is written, without
    // anybody registering anything.
    assert.equal(errorCode('/v1/something-brand-new', 500), 'YUME-API-500')
    assert.equal(errorCode('', 500), 'YUME-API-500')
  })

  test('is stable across the ids a route is called with', () => {
    // The route *pattern* is what the handler passes, so the same fault gives
    // the same code whatever it was called with — which is the only way a code
    // is worth quoting.
    assert.equal(errorCode('/v1/anime/:id', 500), errorCode('/v1/anime/:id', 500))
  })
})

describe('reporting a failure', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  let adminToken = ''

  async function account (role?: string): Promise<string> {
    const username = 'er_' + randomBytes(5).toString('hex')
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
      const auth = await import('../src/middleware/auth.ts')
      auth.invalidatePermissions()
    }
    return (res.json() as { accessToken: string }).accessToken
  }

  const as = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/infrastructure/database/index.ts')])
    app = await buildApp()
    pool = db.pool
    await app.ready()
    adminToken = await account('admin')
  })

  after(async () => {
    try {
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  test('a refusal carries a code and the id that identifies it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { identifier: 'nobody-at-all', password: 'wrong-but-long-enough' }
    })
    assert.equal(res.statusCode, 401)
    const body = res.json() as { code?: string, instance?: string }
    assert.equal(body.code, 'YUME-AUTH-401')
    assert.ok(body.instance, 'no request id on the response')
  })

  test('the code follows the route, not the status alone', async () => {
    const res = await app.inject({ url: '/v1/admin/users', headers: as(adminToken), query: { sort: 'nonsense' } })
    assert.equal(res.statusCode, 400)
    assert.equal((res.json() as { code: string }).code, 'YUME-ADMIN-400')
  })

  test('every kind of refusal carries both, not just the thrown ones', async () => {
    // The reason this is a sweep rather than two examples: the error handler
    // only sees errors that were *thrown*, and most refusals in this codebase
    // are returned — `reply.code(404).send(...)` for a hidden admin route, a
    // 401 for a bad password, a 400 for a bad body. Those had neither field
    // until the onSend hook, and the two spot checks above passed while most
    // failures still went out bare.
    const plain = await account()
    const cases: Array<[string, ReturnType<typeof app.inject>]> = [
      ['400 from schema validation', app.inject({ url: '/v1/admin/users', headers: as(adminToken), query: { limit: 'not-a-number' } })],
      ['401 from a bad password', app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: 'nobody', password: 'wrong-but-long-enough' } })],
      ['401 from no token', app.inject({ url: '/v1/me/settings' })],
      ['404 from a hidden admin route', app.inject({ url: '/v1/admin/users', headers: as(plain) })],
      ['404 from an unknown api path', app.inject({ url: '/v1/nothing-here-at-all' })]
    ]

    for (const [what, pending] of cases) {
      const res = await pending
      assert.ok(res.statusCode >= 400, `${what} did not fail`)
      const body = res.json() as { code?: string, instance?: string, status?: number }
      assert.match(String(body.code), /^YUME-[A-Z]+-\d{3}$/, `${what} has no usable code: ${res.body}`)
      assert.ok(body.instance, `${what} has no request id`)
      assert.equal(body.status, res.statusCode, `${what} disagrees with its own status`)
    }
  })

  test('leaves a successful response untouched', async () => {
    // The hook runs on the way out of everything; it must cost nothing and
    // change nothing on the ordinary path.
    const res = await app.inject({ url: '/v1/health' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as Record<string, unknown>
    assert.ok(!('code' in body), 'a healthy response grew an error code')
    assert.ok(!('instance' in body), 'a healthy response grew a request id')
  })

  // ---- the whole way through ----

  test('a 500 is recorded with the id the caller was shown, and is findable by it', async () => {
    // A real fault rather than a simulated one: the recorded occurrence has to
    // come out of the same path a genuine failure takes, or this proves
    // nothing about genuine failures.
    const { recordError } = await import('../src/errors/reporting.ts')
    const requestId = 'req_' + randomBytes(8).toString('hex')
    const code = errorCode('/v1/anime/:id', 500)

    const groupId = await recordError('api', new Error('a deliberate failure, for the lookup test'), {
      route: '/v1/anime/:id',
      method: 'GET',
      statusCode: 500,
      code,
      requestId
    })
    assert.ok(groupId, 'the occurrence was not recorded at all')

    const res = await app.inject({ url: `/v1/admin/errors/by-request/${requestId}`, headers: as(adminToken) })
    assert.equal(res.statusCode, 200, res.body)
    const { occurrence, group } = res.json() as { occurrence: any, group: any }

    assert.equal(occurrence.context.requestId, requestId)
    assert.equal(occurrence.context.code, code)
    assert.equal(occurrence.context.route, '/v1/anime/:id')
    assert.ok(occurrence.stack, 'the stack is what the operator opened this for')
    // The group answers the other half: is this happening to everybody?
    assert.equal(group.id, groupId)
    assert.ok(Number(group.event_count) >= 1)

    await pool.query('DELETE FROM error_groups WHERE id = $1', [groupId])
  })

  test('an id nothing carries is 404, not an empty shell', async () => {
    const res = await app.inject({
      url: '/v1/admin/errors/by-request/req_nothing_has_this_one',
      headers: as(adminToken)
    })
    assert.equal(res.statusCode, 404)
    assert.match(res.body, /request id/i)
  })

  test('the lookup is hidden from an account that cannot read analytics', async () => {
    const plain = await account()
    const res = await app.inject({
      url: '/v1/admin/errors/by-request/anything',
      headers: as(plain)
    })
    assert.equal(res.statusCode, 404, 'the route is visible to an ordinary account')
  })

  test('a 5xx body still says nothing about internals', async () => {
    // The code and the id are additions, not a relaxation: the point of the
    // opaque 5xx body is unchanged.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { identifier: 'nobody-at-all', password: 'wrong-but-long-enough' }
    })
    assert.doesNotMatch(res.body, /select |postgres|node_modules|\/home\//i)
  })
})
