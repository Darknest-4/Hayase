// The three global settings an administrator can change, and whether changing
// them changes anything.
//
// All three were stored, echoed back to the client in /v1/config, and enforced
// nowhere on the server:
//   * `registration_open` — the form disappeared from the client; POST
//     /v1/auth/register kept creating accounts.
//   * `require_login` — the client's route gate refused to render pages; the
//     API served the whole catalogue to anyone who called it directly.
//   * `site_name` — read once at boot, so an edit sat inert behind a cache.
//
// The enforcement tests replace the reader rather than writing to
// `site_settings`. The table is global and the suite's files run in parallel
// against one database, so a real `require_login = true`, even for a second,
// would hand unrelated suites a 401 and call it a failure. The write path is
// covered separately below, with a key whose only effect is cosmetic.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, mock, test } from 'node:test'

import { settings } from '../src/lib/site-settings.ts'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'site-settings-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('site settings actually govern the server', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  let token = ''

  function credentials (): { email: string, username: string, password: string } {
    const username = 'set_' + randomBytes(5).toString('hex')
    return { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    const body = credentials()
    const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: body })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(body.username)
    token = (res.json() as { accessToken: string }).accessToken
  })

  after(async () => {
    mock.restoreAll()
    if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    await app?.close()
    await pool?.end()
  })

  // ---- registration_open ----

  test('closing registration closes it on the API, not only in the form', async () => {
    mock.method(settings, 'registrationOpen', async () => false)
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: credentials() })
      assert.equal(res.statusCode, 403, res.body)
    } finally {
      mock.restoreAll()
    }
  })

  test('registration works again once it is reopened', async () => {
    // The other half. A guard that never lets anybody through is not a
    // setting, it is an outage.
    const body = credentials()
    const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: body })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(body.username)
  })

  test('a missing row leaves registration open', async () => {
    // A fresh deployment has no `registration_open` row at all, and must not
    // be locked out of creating its own first account.
    mock.method(settings, 'load', async () => ({}))
    try {
      assert.equal(await settings.registrationOpen(), true)
    } finally {
      mock.restoreAll()
    }
  })

  // ---- require_login ----

  test('a private instance refuses an unauthenticated API call', async () => {
    mock.method(settings, 'requiresLogin', async () => true)
    try {
      for (const url of ['/v1/anime?limit=1', '/v1/anime/search?q=test', '/v1/comments?animeId=1']) {
        const res = await app.inject({ url })
        assert.equal(res.statusCode, 401, `${url} answered ${res.statusCode}: ${res.body}`)
      }
      // GraphQL reads the same catalogue by another door. Gating REST and
      // leaving this open would make the setting decorative again.
      const graphql = await app.inject({ method: 'POST', url: '/graphql', payload: { query: '{ __typename }' } })
      assert.equal(graphql.statusCode, 401, graphql.body)
    } finally {
      mock.restoreAll()
    }
  })

  test('a private instance still serves what a signed-out viewer needs to sign in', async () => {
    // Health, so the deployment stays monitorable; /v1/config, because it is
    // what tells the client the site is private; and the auth endpoints, or
    // there is no way back in.
    mock.method(settings, 'requiresLogin', async () => true)
    try {
      for (const url of ['/v1/health', '/v1/config']) {
        const res = await app.inject({ url })
        assert.equal(res.statusCode, 200, `${url} answered ${res.statusCode}`)
      }
      // Wrong password, but it reached the handler rather than the gate.
      const login = await app.inject({
        method: 'POST', url: '/v1/auth/login', payload: { identifier: 'nobody-here', password: 'wrong-password-but-long' }
      })
      assert.equal(login.statusCode, 401)
      assert.ok(!login.body.includes('private'), login.body)
    } finally {
      mock.restoreAll()
    }
  })

  test('a signed-in caller passes the private-instance gate', async () => {
    mock.method(settings, 'requiresLogin', async () => true)
    try {
      const res = await app.inject({ url: '/v1/anime?limit=1', headers: { authorization: `Bearer ${token}` } })
      assert.equal(res.statusCode, 200, res.body)
    } finally {
      mock.restoreAll()
    }
  })

  test('a public instance is left alone', async () => {
    const res = await app.inject({ url: '/v1/anime?limit=1' })
    assert.equal(res.statusCode, 200, res.body)
  })

  test('the gate does not fire outside the API', async () => {
    // The client has to load before it can offer a sign-in form.
    mock.method(settings, 'requiresLogin', async () => true)
    try {
      const res = await app.inject({ url: '/' })
      assert.notEqual(res.statusCode, 401)
    } finally {
      mock.restoreAll()
    }
  })

  // ---- the write path ----

  test('saving a setting takes effect immediately, not when the cache expires', async () => {
    // Proven with `site_name` on purpose: it is the one key of the five whose
    // only effect is cosmetic, so a parallel suite that reads it mid-test has
    // nothing to fail on. The cache TTL is 30s — without the invalidation on
    // write, "Saved" would mean "in half a minute".
    const previous = (await settings.load()).site_name
    const wanted = 'Yume ' + randomBytes(3).toString('hex')

    // Straight through the admin route, so the invalidation is tested where it
    // actually has to happen rather than in isolation.
    const admin = 'set_' + randomBytes(5).toString('hex')
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${admin}@test.invalid`, username: admin, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(reg.statusCode, 201, reg.body)
    usernames.push(admin)
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
       ON CONFLICT DO NOTHING`, [admin])
    const auth = await import('../src/plugins/auth.ts')
    auth.invalidatePermissions()

    try {
      const patch = await app.inject({
        method: 'PATCH',
        url: '/v1/admin/config/settings/site_name',
        headers: { authorization: `Bearer ${(reg.json() as { accessToken: string }).accessToken}` },
        payload: { value: wanted }
      })
      assert.equal(patch.statusCode, 200, patch.body)

      assert.equal(await settings.siteName(), wanted)
      const config = await app.inject({ url: '/v1/config' })
      assert.equal((config.json() as { site: { name: string } }).site.name, wanted)
    } finally {
      await pool.query(
        `INSERT INTO site_settings (key, value) VALUES ('site_name', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`,
        [JSON.stringify(previous ?? 'Yume')]
      )
      settings.invalidate()
    }
  })

  test('the tagline reaches the client', async () => {
    // It is rendered in the footer now; before that it was a text box in the
    // admin panel wired to nothing at all.
    const res = await app.inject({ url: '/v1/config' })
    const site = (res.json() as { site: Record<string, unknown> }).site
    assert.ok('tagline' in site, JSON.stringify(site))
    assert.equal(typeof site.tagline, 'string')
  })
})
