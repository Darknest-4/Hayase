// The emergency controls, and whether they control anything.
//
// The whole point of this file is the lesson from migration 0033: this
// platform has shipped switches that switched nothing — feature flags read
// only by the client, a `registration_open` twin that nothing consulted. A
// control an operator throws mid-incident, believing they have closed
// something, is the worst version of that bug.
//
// So every test here throws a switch and then tries the thing it is supposed
// to stop, through the real HTTP surface.
//
// The switches are engaged by substituting the reader, not by writing to
// `site_settings`. That table is shared, this suite's files run in parallel
// against one database, and each of them is a separate process with its own
// settings cache — so a real write of `read_only: true` put unrelated suites
// into read-only mode and failed fourteen of their tests. lib/site-settings.ts
// says as much in its own header; this is the case it was warning about.
//
// The write path is still covered, by POSTing values that are already the safe
// ones: that exercises the route, the audit row, the validation and the
// permission gate without ever leaving the instance in a state another process
// can trip over.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, mock, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'emergency-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('emergency controls', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  let siteSettings: typeof import('../src/modules/settings/site-settings.ts').settings
  const usernames: string[] = []
  let adminToken = ''
  let plainToken = ''

  async function account (role?: string): Promise<{ token: string, id: string, username: string }> {
    const username = 'em_' + randomBytes(5).toString('hex')
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
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    return { token: (res.json() as { accessToken: string }).accessToken, id: String(rows[0].id), username }
  }

  const as = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })

  /**
   * Engage a control for the length of one test, without touching the database.
   *
   * The routes and workers read through `settings.<reader>()` at call time, so
   * replacing the method is enough — and it keeps the shared table at its safe
   * values for every other process in the run.
   */
  const engage = (reader: 'readOnly' | 'externalSyncEnabled' | 'webhooksEnabled', value: boolean): void => {
    mock.method(siteSettings, reader, async () => value)
  }

  before(async () => {
    const [{ buildApp }, db, ss] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/settings/site-settings.ts')
    ])
    app = await buildApp()
    pool = db.pool
    siteSettings = ss.settings
    await app.ready()
    adminToken = (await account('admin')).token
    plainToken = (await account()).token
  })

  after(async () => {
    try {
      mock.restoreAll()
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  // ---- the screen ----

  test('lists every control with the file that enforces it', async () => {
    const res = await app.inject({ url: '/v1/admin/security', headers: as(adminToken) })
    assert.equal(res.statusCode, 200, res.body)
    const { controls, context } = res.json() as { controls: any[], context: any }

    assert.equal(controls.length, 3)
    for (const c of controls) {
      // A control that cannot say where it bites is the next switch that
      // switches nothing.
      assert.ok(c.enforcedBy && c.enforcedBy.length > 20, `${c.key} does not say what enforces it`)
      assert.equal(typeof c.value, 'boolean')
      assert.equal(typeof c.engaged, 'boolean')
    }
    assert.equal(typeof context.sessions, 'number')
    assert.equal(typeof context.hooks, 'number')
  })

  test('is hidden from an account without security.manage', async () => {
    // 404, not 403: the admin surface does not confirm it exists.
    for (const url of ['/v1/admin/security', '/v1/admin/security/read_only']) {
      const res = await app.inject({ url, headers: as(plainToken) })
      assert.equal(res.statusCode, 404, `${url} answered ${res.statusCode}`)
    }
  })

  test('a control that is not a control is refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/security/drop_everything',
      headers: as(adminToken),
      payload: { value: true, reason: 'testing' }
    })
    assert.equal(res.statusCode, 400)
  })

  test('throwing a control demands a reason and records it', async () => {
    const bare = await app.inject({
      method: 'POST',
      url: '/v1/admin/security/read_only',
      headers: as(adminToken),
      payload: { value: false }
    })
    assert.equal(bare.statusCode, 400, 'a reason is not optional')

    // `false` is read_only's safe value, so this exercises the write, the
    // audit row and the response without engaging anything. Engaging it for
    // real would put every other process in this run into read-only mode.
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/admin/security/read_only',
      headers: as(adminToken),
      payload: { value: false, reason: 'audit trail test' }
    })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal((ok.json() as any).engaged, false)

    const { rows } = await pool.query(
      `SELECT after FROM audit_logs
        WHERE subject_type = 'config' AND subject_id = 'read_only'
        ORDER BY created_at DESC LIMIT 1`)
    assert.equal(rows[0].after.reason, 'audit trail test')
    assert.equal(rows[0].after.read_only, false)
  })

  // ---- read-only mode ----

  test('read-only mode refuses writes and keeps reads working', async () => {
    engage('readOnly', true)
    try {
    const write = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: as(plainToken),
      payload: { subjectType: 'user', subjectId: '00000000-0000-0000-0000-000000000000', reason: 'spam' }
    })
    assert.equal(write.statusCode, 503, write.body)
    // 503 rather than 403: nothing is wrong with the caller, and a client that
    // retries later is behaving correctly.
    assert.equal(write.headers['retry-after'], '120')

    const read = await app.inject({ url: '/v1/health' })
    assert.equal(read.statusCode, 200, 'reads stopped working')
    } finally { mock.restoreAll() }
  })

  test('read-only mode leaves sign-in and sign-out alone', async () => {
    engage('readOnly', true)
    try {
    // Locking people out of their own sessions is not what read-only means,
    // and an operator who cannot sign in cannot turn it off.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { identifier: usernames[0], password: 'a-long-enough-test-password-1' }
    })
    assert.notEqual(res.statusCode, 503, 'sign-in was refused by read-only mode')
    } finally { mock.restoreAll() }
  })

  test('read-only mode can be turned off from inside itself', async () => {
    engage('readOnly', true)
    try {
    // The lever needs an exit that is not a database console.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/security/read_only',
      headers: as(adminToken),
      payload: { value: false, reason: 'releasing' }
    })
    // The exemption is what is under test: the POST reached the handler
    // instead of being refused by the very mode it was releasing.
    assert.equal(res.statusCode, 200, res.body)
    } finally { mock.restoreAll() }
  })

  test('read-only mode does not stop reading the admin panel', async () => {
    engage('readOnly', true)
    try {
      const res = await app.inject({ url: '/v1/admin/users', headers: as(adminToken) })
      assert.equal(res.statusCode, 200, 'the panel went dark in read-only mode')
    } finally { mock.restoreAll() }
  })

  // ---- external sync ----

  test('switching external sync off refuses a new run', async () => {
    engage('externalSyncEnabled', false)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/catalogue/metadata/runs',
        headers: as(adminToken),
        payload: { kind: 'basic', scope: 'missing' }
      })
      assert.ok(res.statusCode >= 400, `a run started with sync off (${res.statusCode})`)
    } finally { mock.restoreAll() }
  })

  test('a run queued before the switch does not start after it', async () => {
    // The queue is durable: "it was allowed when it was enqueued" is not the
    // same question as "is it allowed now".
    const { startRun } = await import('../src/modules/metadata/worker.ts')
    const { handleMetadataJob } = await import('../src/modules/metadata/worker.ts')

    await pool.query("DELETE FROM metadata_runs WHERE status IN ('queued','running')")
    const run = await startRun({ kind: 'basic', scope: 'missing', limit: 1 })

    engage('externalSyncEnabled', false)
    try {
      await handleMetadataJob({ id: 'x', queue: 'metadata', payload: { runId: run.id }, attempts: 1 })
      const { rows } = await pool.query('SELECT status, error FROM metadata_runs WHERE id = $1', [run.id])
      assert.equal(rows[0].status, 'cancelled')
      assert.match(String(rows[0].error), /switched off/)
    } finally {
      mock.restoreAll()
      await pool.query('DELETE FROM metadata_runs WHERE id = $1', [run.id])
    }
  })

  // ---- webhooks ----

  test('switching webhooks off queues nothing', async () => {
    const name = 'em_' + randomBytes(4).toString('hex')
    const { rows: hook } = await pool.query(
      `INSERT INTO webhooks (name, url, format, events, enabled)
       VALUES ($1, 'https://example.invalid/hook', 'json', ARRAY['user.registered']::text[], true)
       RETURNING id`, [name])

    const { emitEvent } = await import('../src/modules/webhooks/delivery.ts')
    const depth = async (): Promise<number> => {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM jobs WHERE queue = 'webhook' AND done_at IS NULL")
      return Number(rows[0].n)
    }

    engage('webhooksEnabled', false)
    const before = await depth()
    await emitEvent('user.registered', { username: 'nobody' })
    assert.equal(await depth(), before, 'a delivery was queued with webhooks off')

    mock.restoreAll()
    await emitEvent('user.registered', { username: 'nobody' })
    assert.ok(await depth() > before, 'nothing was queued with webhooks on')

    await pool.query("DELETE FROM jobs WHERE queue = 'webhook' AND payload->>'webhookId' = $1", [String(hook[0].id)])
    await pool.query('DELETE FROM webhooks WHERE id = $1', [hook[0].id])
  })

})
