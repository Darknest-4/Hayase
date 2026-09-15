// Announcements: who may write one, and who may see it.
//
// The interesting property is not the CRUD — it is that `audience` narrows the
// read in SQL. A message written for staff must not leave the database on a
// request from a signed-out visitor, and the way to be sure of that is to ask
// as each kind of viewer and look at what comes back.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'announcements-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

const PASSWORD = 'a-long-enough-test-password-1'

describe('announcements', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const userIds: string[] = []
  const madeIds: string[] = []
  let plain = ''
  let admin = ''
  let adminProfile = ''

  async function account (role?: string): Promise<{ token: string, profileId: string }> {
    const username = 'ann_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: PASSWORD }
    })
    assert.equal(res.statusCode, 201, res.body)
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    userIds.push(rows[0].id as string)
    if (role) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = $2
         ON CONFLICT DO NOTHING`, [username, role])
      const auth = await import('../src/middleware/auth.ts')
      auth.invalidatePermissions()
    }
    const token = (res.json() as { accessToken: string }).accessToken
    const me = await app.inject({ url: '/v1/profiles/me', headers: { authorization: `Bearer ${token}` } })
    return { token, profileId: (me.json() as { id: string }).id }
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/infrastructure/database/index.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
    plain = (await account()).token
    const a = await account('admin')
    admin = a.token
    adminProfile = a.profileId
  })

  after(async () => {
    if (madeIds.length) await pool.query('DELETE FROM announcements WHERE id = ANY($1)', [madeIds])
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds])
    await app?.close()
    await pool?.end()
  })

  async function make (audience: string, title: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/announcements',
      headers: { authorization: `Bearer ${admin}` },
      payload: { title, body: 'body text', audience }
    })
    assert.equal(res.statusCode, 201, res.body)
    const id = (res.json() as { id: string }).id
    madeIds.push(id)
    return id
  }

  test('writing needs the permission', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/announcements',
      headers: { authorization: `Bearer ${plain}` },
      payload: { title: 'nope', body: 'nope' }
    })
    assert.equal(res.statusCode, 403, res.body)
  })

  test('audience narrows the read, and it narrows it in SQL', async () => {
    const everyone = await make('everyone', 'ann-everyone-' + randomBytes(3).toString('hex'))
    const members = await make('members', 'ann-members-' + randomBytes(3).toString('hex'))
    const staff = await make('staff', 'ann-staff-' + randomBytes(3).toString('hex'))

    const idsFor = async (headers: Record<string, string>): Promise<string[]> => {
      const res = await app.inject({ url: '/v1/announcements', headers })
      assert.equal(res.statusCode, 200, res.body)
      return (res.json() as { data: Array<{ id: string }> }).data.map(r => r.id)
    }

    // No anonymous case here on purpose. This instance runs with
    // `require_login`, so the global gate refuses an unauthenticated /v1 call
    // before this route sees it, and announcements are deliberately not on the
    // gate's exempt list. `audience = 'everyone'` still has to behave as the
    // widest bucket for everybody who *can* ask.
    const member = await idsFor({ authorization: `Bearer ${plain}` })
    assert.ok(member.includes(everyone) && member.includes(members), 'a member sees both')
    assert.ok(!member.includes(staff), 'a member must not see a staff message')

    const privileged = await idsFor({ authorization: `Bearer ${admin}` })
    assert.ok(privileged.includes(staff), 'somebody with the permission sees the staff message')
  })

  test('dismissing is per profile and idempotent', async () => {
    const id = await make('members', 'ann-dismiss-' + randomBytes(3).toString('hex'))
    const headers = { authorization: `Bearer ${admin}`, 'x-profile-id': adminProfile }

    const before = await app.inject({ url: '/v1/announcements', headers })
    const seen = (before.json() as { data: Array<{ id: string, dismissed: boolean }> }).data.find(r => r.id === id)
    assert.equal(seen?.dismissed, false, 'starts undismissed')

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: `/v1/announcements/${id}/dismiss`, headers })
      assert.equal(res.statusCode, 204, `dismiss #${i + 1}: ${res.body}`)
    }

    const after = await app.inject({ url: '/v1/announcements', headers })
    const now = (after.json() as { data: Array<{ id: string, dismissed: boolean }> }).data.find(r => r.id === id)
    assert.equal(now?.dismissed, true, 'stays dismissed')
  })

  test('a window that has not opened yet is not live', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/announcements',
      headers: { authorization: `Bearer ${admin}` },
      payload: {
        title: 'ann-future-' + randomBytes(3).toString('hex'),
        body: 'body',
        audience: 'everyone',
        startsAt: new Date(Date.now() + 86_400_000).toISOString()
      }
    })
    assert.equal(res.statusCode, 201, res.body)
    const id = (res.json() as { id: string }).id
    madeIds.push(id)

    const live = await app.inject({ url: '/v1/announcements', headers: { authorization: `Bearer ${plain}` } })
    const ids = (live.json() as { data: Array<{ id: string }> }).data.map(r => r.id)
    assert.ok(!ids.includes(id), 'a future announcement must not be live yet')

    const all = await app.inject({ url: '/v1/announcements/all', headers: { authorization: `Bearer ${admin}` } })
    const allIds = (all.json() as { data: Array<{ id: string }> }).data.map(r => r.id)
    assert.ok(allIds.includes(id), 'but the author can still see it')
  })
})
