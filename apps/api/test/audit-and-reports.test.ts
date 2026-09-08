// Reading the audit trail, and the moderation queue's other end.
//
// The trail filtered by subject type alone — the least useful of the three
// things somebody arrives knowing. "What did this person do", "what happened
// to this thing" and "what happened around the time it broke" were all
// unanswerable, and the record itself was printed as the raw `after` object,
// which says what a value became without ever saying what it was.
//
// The queue showed the open reports and nothing else: no way to see what had
// been decided or by whom, and no context beyond the report itself.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'audit-reports-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('audit trail and moderation queue', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  const marker = 'ar_' + randomBytes(4).toString('hex')
  let adminToken = ''
  let adminId = ''
  let victimId = ''

  async function account (role?: string): Promise<{ token: string, id: string, username: string }> {
    const username = marker + randomBytes(4).toString('hex')
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
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    return { token: (res.json() as { accessToken: string }).accessToken, id: String(rows[0].id), username }
  }

  const as = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/infrastructure/database/index.ts')])
    app = await buildApp()
    pool = db.pool
    await app.ready()

    const admin = await account('admin')
    adminToken = admin.token
    adminId = admin.id
    const victim = await account()
    victimId = victim.id

    // Two different actions on the same subject, so the filters have
    // something to tell apart.
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${victimId}/status`,
      headers: as(adminToken),
      payload: { status: 'suspended', reason: 'for the audit test' }
    })
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${victimId}/roles`,
      headers: as(adminToken),
      payload: { role: 'moderator', granted: true, reason: 'for the audit test' }
    })
  })

  after(async () => {
    try {
      await pool.query("DELETE FROM reports WHERE details LIKE $1", [marker + '%'])
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  // ---- the trail ----

  test('a record says what a value was as well as what it became', async () => {
    const res = await app.inject({
      url: `/v1/admin/audit?subjectId=${victimId}&action=user.status`,
      headers: as(adminToken)
    })
    assert.equal(res.statusCode, 200, res.body)
    const { data } = res.json() as { data: any[] }
    assert.equal(data.length, 1)
    // Both halves, or the screen cannot draw a change — which is what it used
    // to be reduced to doing.
    assert.equal(data[0].before.status, 'active')
    assert.equal(data[0].after.status, 'suspended')
    assert.equal(data[0].actor, usernames[0])
  })

  test('a role grant records the same shape on both sides', async () => {
    const res = await app.inject({
      url: `/v1/admin/audit?subjectId=${victimId}&action=user.role.grant`,
      headers: as(adminToken)
    })
    const { data } = res.json() as { data: any[] }
    assert.equal(data.length, 1)
    // Parallel keys: `granted` is what moved, `role` is the context that says
    // what the grant was about. A `before` that named different keys made the
    // record unreadable as a change.
    assert.equal(data[0].before.role, 'moderator')
    assert.equal(data[0].after.role, 'moderator')
    assert.equal(data[0].before.granted, false)
    assert.equal(data[0].after.granted, true)
  })

  test('filtering by actor name finds what that person did', async () => {
    const res = await app.inject({ url: `/v1/admin/audit?actor=${usernames[0]}`, headers: as(adminToken) })
    const { data, total } = res.json() as { data: any[], total: number }
    assert.ok(data.length >= 2, 'both actions are attributed')
    assert.ok(Number(total) >= 2)
    for (const row of data) assert.equal(row.actor, usernames[0])
  })

  test('an action prefix selects a family of actions', async () => {
    const res = await app.inject({ url: `/v1/admin/audit?subjectId=${victimId}&action=user.`, headers: as(adminToken) })
    const { data } = res.json() as { data: any[] }
    assert.ok(data.length >= 2, 'the prefix matched more than one action')
    for (const row of data) assert.match(String(row.action), /^user\./)
  })

  test('a time window excludes what happened before it', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const res = await app.inject({ url: `/v1/admin/audit?since=${encodeURIComponent(future)}`, headers: as(adminToken) })
    const { data, total } = res.json() as { data: any[], total: number }
    assert.deepEqual(data, [])
    assert.equal(Number(total), 0)
  })

  test('the total counts the whole filtered set, not the page', async () => {
    const res = await app.inject({ url: `/v1/admin/audit?actor=${usernames[0]}&limit=1`, headers: as(adminToken) })
    const { data, total } = res.json() as { data: any[], total: number }
    assert.equal(data.length, 1)
    assert.ok(Number(total) > 1, 'a page of one out of several must still report several')
  })

  test('paging does not repeat a row', async () => {
    const page = async (offset: number): Promise<string[]> => {
      const res = await app.inject({
        url: `/v1/admin/audit?actor=${usernames[0]}&limit=1&offset=${offset}`,
        headers: as(adminToken)
      })
      return (res.json() as { data: any[] }).data.map(r => String(r.id))
    }
    const [first, second] = await Promise.all([page(0), page(1)])
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.notEqual(first[0], second[0])
  })

  test('the action list offers what this instance has recorded', async () => {
    const res = await app.inject({ url: '/v1/admin/audit', headers: as(adminToken) })
    const { actions } = res.json() as { actions: Array<{ action: string, n: number }> }
    assert.ok(Array.isArray(actions) && actions.length > 0)
    assert.ok(actions.some(a => a.action === 'user.status'), 'an action that was just written is offered')
    for (const a of actions) assert.equal(typeof a.n, 'number')
  })

  test('an ordinary account cannot read the trail', async () => {
    const plain = await account()
    const res = await app.inject({ url: '/v1/admin/audit', headers: as(plain.token) })
    assert.equal(res.statusCode, 404)
  })

  // ---- the queue ----

  async function report (status: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO reports (reporter_id, subject_type, subject_id, reason, details, status)
       VALUES ($1, 'user', $2, 'spam', $3, $4) RETURNING id`,
      [adminId, victimId, marker + ' queue fixture', status]
    )
    return String(rows[0].id)
  }

  test('the queue counts every status, not only the one being viewed', async () => {
    await report('open')
    await report('resolved')

    const res = await app.inject({ url: '/v1/admin/reports?status=open', headers: as(adminToken) })
    assert.equal(res.statusCode, 200, res.body)
    const { totals } = res.json() as { totals: Record<string, number> }
    assert.ok(Number(totals.open) >= 1)
    assert.ok(Number(totals.resolved) >= 1, 'the resolved ones are counted while viewing the open ones')
    assert.ok(Number(totals.total) >= Number(totals.open))
  })

  test('resolved reports are reachable, which is where a decision is checked', async () => {
    const id = await report('dismissed')
    await pool.query('UPDATE reports SET resolved_by = $2, resolved_at = now() WHERE id = $1', [id, adminId])

    const res = await app.inject({ url: '/v1/admin/reports?status=dismissed', headers: as(adminToken) })
    const { data } = res.json() as { data: any[] }
    const row = data.find(r => r.id === id)
    assert.ok(row, 'the dismissed report is listed')
    assert.equal(row.resolver, usernames[0], 'who decided it')
    assert.ok(row.resolved_at, 'and when')
  })

  test('a report carries the reporter record that decides most of them', async () => {
    await report('open')
    const res = await app.inject({ url: '/v1/admin/reports?status=open', headers: as(adminToken) })
    const { data } = res.json() as { data: any[] }
    const row = data.find(r => r.details?.startsWith(marker))
    assert.ok(row)
    assert.equal(typeof row.reporter_total, 'number')
    assert.equal(typeof row.reporter_dismissed, 'number')
    assert.ok(Number(row.subject_reports) >= 1, 'how often this subject has been reported')
  })

  test('"all" is a status, so nothing is invisible', async () => {
    const res = await app.inject({ url: '/v1/admin/reports?status=all', headers: as(adminToken) })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: any[] }
    const mine = data.filter(r => r.details?.startsWith(marker))
    assert.ok(mine.some(r => r.status === 'open'))
    assert.ok(mine.some(r => r.status !== 'open'), 'decided reports appear alongside open ones')
  })

  test('a status that is not a status is refused', async () => {
    const res = await app.inject({ url: '/v1/admin/reports?status=whatever', headers: as(adminToken) })
    assert.equal(res.statusCode, 400)
  })
})
