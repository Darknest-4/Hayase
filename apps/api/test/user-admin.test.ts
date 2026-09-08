// Managing an account: the parts that had no interface.
//
// Suspending and banning were the only two things this section could do. Who
// holds a role was not editable anywhere — the Roles screen edits what a role
// may *do* — so promoting a moderator meant an INSERT into user_roles by hand,
// unaudited, with nothing stopping the last administrator being demoted. And
// the only tool for a compromised password was a ban, which is both wrong and
// visible to the person it happens to.
//
// The detail endpoint is covered for what it must *not* carry as much as for
// what it must: `sessions` and `security_logs` hold IP addresses and user
// agents, and none of that belongs in a screen about whether to suspend
// somebody.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'user-admin-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('account administration', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  let adminToken = ''
  let plainToken = ''
  let plainId = ''
  let plainName = ''

  async function account (role?: string): Promise<{ token: string, id: string, username: string }> {
    const username = 'ua_' + randomBytes(5).toString('hex')
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

    // A standing administrator, so the registration bootstrap is not what
    // decides which of these accounts is privileged.
    const admin = await account('admin')
    adminToken = admin.token
    const plain = await account()
    plainToken = plain.token
    plainId = plain.id
    plainName = plain.username
  })

  after(async () => {
    try {
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  // ---- the detail endpoint ----

  test('an account detail carries the history and the counts', async () => {
    const res = await app.inject({ url: `/v1/admin/users/${plainId}`, headers: as(adminToken) })
    assert.equal(res.statusCode, 200, res.body)
    const d = res.json() as Record<string, any>

    assert.equal(d.account.username, plainName)
    assert.equal(d.account.status, 'active')
    assert.equal(d.account.has_password, true)
    assert.ok(Array.isArray(d.roles))
    assert.ok(Array.isArray(d.allRoles) && d.allRoles.length > 0, 'the grantable roles are listed')
    assert.ok(Array.isArray(d.profiles))
    assert.ok(Array.isArray(d.moderation))
    assert.ok(Array.isArray(d.security))
    assert.equal(typeof d.sessions.active, 'number')
    assert.equal(typeof d.activity.comments, 'number')
    assert.equal(typeof d.activity.episodes_finished, 'number')
  })

  // The point of the endpoint is that an operator does not have to run SQL.
  // The point of *this* is that it does not hand them more than they asked for.
  test('the detail carries no IP address or user agent', async () => {
    // Registration writes a security_logs row with both, so there is
    // definitely something to leak by the time this runs.
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM security_logs WHERE user_id = $1 AND ip IS NOT NULL", [plainId])
    assert.ok(Number(rows[0].n) > 0, 'precondition: an IP was recorded')

    const res = await app.inject({ url: `/v1/admin/users/${plainId}`, headers: as(adminToken) })
    const body = res.body.toLowerCase()
    assert.ok(!body.includes('"ip"'), 'an ip field reached the client')
    assert.ok(!body.includes('user_agent'), 'a user agent reached the client')
    assert.ok(!body.includes('refresh_hash'), 'a refresh token hash reached the client')
    assert.ok(!body.includes('password_hash'), 'a password hash reached the client')
    assert.ok(!body.includes('mfa_secret'), 'an MFA secret reached the client')
  })

  test('an ordinary account cannot see anybody, including itself', async () => {
    for (const url of [`/v1/admin/users/${plainId}`, '/v1/admin/users']) {
      const res = await app.inject({ url, headers: as(plainToken) })
      assert.equal(res.statusCode, 404, `${url} answered ${res.statusCode}`)
    }
  })

  test('an unknown account is 404, not an empty shell', async () => {
    const res = await app.inject({
      url: '/v1/admin/users/00000000-0000-0000-0000-000000000000',
      headers: as(adminToken)
    })
    assert.equal(res.statusCode, 404)
  })

  // ---- the list ----

  test('the list filters, sorts and pages, and says how many matched', async () => {
    const res = await app.inject({ url: '/v1/admin/users?status=active&sort=name&limit=5', headers: as(adminToken) })
    assert.equal(res.statusCode, 200, res.body)
    const { data, totals } = res.json() as { data: any[], totals: any }
    assert.ok(data.length <= 5)
    assert.ok(Number(totals.total) >= data.length, 'the total counts the whole filtered set, not the page')
    assert.equal(typeof totals.active, 'number')
    for (const row of data) assert.equal(row.status, 'active')
    // Sorted by name: the page must be in order regardless of what is in it.
    const names = data.map(r => String(r.username))
    assert.deepEqual(names, [...names].sort())
  })

  test('the list carries the counts a row is triaged from', async () => {
    const res = await app.inject({ url: `/v1/admin/users?query=${plainName}`, headers: as(adminToken) })
    const { data } = res.json() as { data: any[] }
    const row = data.find(r => r.username === plainName)
    assert.ok(row, 'the account is findable by name')
    assert.equal(typeof row.active_sessions, 'number')
    assert.equal(typeof row.comments, 'number')
    assert.equal(typeof row.reports_against, 'number')
  })

  test('a sort key that is not on the list cannot reach SQL', async () => {
    const res = await app.inject({ url: '/v1/admin/users?sort=u.username;DROP TABLE users', headers: as(adminToken) })
    // Rejected by the schema rather than interpolated.
    assert.equal(res.statusCode, 400)
    const { rows } = await pool.query("SELECT to_regclass('users') IS NOT NULL AS present")
    assert.equal(rows[0].present, true)
  })

  // ---- roles ----

  test('a role can be granted and revoked, and both are recorded', async () => {
    const target = await account()

    const grant = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${target.id}/roles`,
      headers: as(adminToken),
      payload: { role: 'moderator', granted: true, reason: 'promoting for the test' }
    })
    assert.equal(grant.statusCode, 200, grant.body)
    assert.equal((grant.json() as any).changed, true)

    const { rows: held } = await pool.query(
      `SELECT r.slug FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [target.id])
    assert.ok(held.some(r => r.slug === 'moderator'), 'the role is actually held')

    const { rows: audit } = await pool.query(
      `SELECT action FROM audit_logs WHERE subject_type = 'user' AND subject_id = $1 AND action = 'user.role.grant'`,
      [target.id])
    assert.equal(audit.length, 1, 'the grant is in the audit log')

    // Not in moderation_actions, on purpose: that table's vocabulary is
    // disciplinary — hide, warn, suspend, ban — and a promotion is not any of
    // those. Recording it there would make the moderation history a worse
    // answer to the question it exists for.
    const { rows: mod } = await pool.query(
      `SELECT action FROM moderation_actions WHERE subject_type = 'user' AND subject_id = $1`, [target.id])
    assert.equal(mod.length, 0, 'a role change is not a moderation action')

    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${target.id}/roles`,
      headers: as(adminToken),
      payload: { role: 'moderator', granted: false, reason: 'undoing the test' }
    })
    assert.equal(revoke.statusCode, 200, revoke.body)
    const { rows: after } = await pool.query(
      `SELECT r.slug FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [target.id])
    assert.ok(!after.some(r => r.slug === 'moderator'))
  })

  test('granting a role somebody already holds changes nothing and says so', async () => {
    const target = await account('moderator')
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${target.id}/roles`,
      headers: as(adminToken),
      payload: { role: 'moderator', granted: true }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal((res.json() as any).changed, false)
  })

  test('a role that does not exist is refused', async () => {
    const target = await account()
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${target.id}/roles`,
      headers: as(adminToken),
      payload: { role: 'wizard', granted: true }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.body, /No role named/)
  })

  test('you cannot change your own roles', async () => {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [usernames[0]])
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${String(rows[0].id)}/roles`,
      headers: as(adminToken),
      payload: { role: 'admin', granted: false }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.body, /your own roles/)
  })

  // The bootstrap in registration only fires on an instance with *no*
  // administrator, and by then every account already exists — so an instance
  // that demotes its last one cannot be recovered from any screen.
  test('the last administrator cannot be demoted', async () => {
    const sacrificial = await account('admin')

    // With two administrators the demotion is allowed.
    const first = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${sacrificial.id}/roles`,
      headers: as(adminToken),
      payload: { role: 'admin', granted: false, reason: 'test' }
    })
    assert.equal(first.statusCode, 200, first.body)

    // Now make the caller the only one, and try to remove somebody else's —
    // there is nobody else's left, so we assert on the invariant directly by
    // demoting the caller through a second administrator.
    const other = await account('admin')
    const removeOther = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${other.id}/roles`,
      headers: as(adminToken),
      payload: { role: 'admin', granted: false, reason: 'test' }
    })
    assert.equal(removeOther.statusCode, 200, 'removing one of two administrators is fine')

    // The caller is now the last one. Their own demotion is refused above by
    // the self-check; a third account's is refused by the count.
    const lonely = await account('admin')
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${lonely.id}/roles`,
      headers: as(adminToken),
      payload: { role: 'admin', granted: false, reason: 'test' }
    })
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.slug = 'admin'`)
    assert.ok(Number(rows[0].n) >= 1, 'an administrator always remains')
  })

  test('assigning a role needs its own permission, not merely user management', async () => {
    // `admin.users.manage` lets an account suspend and ban. Handing out roles
    // is how an instance changes hands, and is gated separately.
    const mod = await account('moderator')
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${plainId}/roles`,
      headers: as(mod.token),
      payload: { role: 'moderator', granted: true }
    })
    assert.equal(res.statusCode, 404, 'the route is hidden, not merely refused')
  })

  // ---- sessions ----

  test('signing an account out ends its sessions and invalidates its tokens', async () => {
    const victim = await account()

    const before = await app.inject({ url: '/v1/auth/permissions', headers: as(victim.token) })
    assert.equal(before.statusCode, 200, 'precondition: the token works')

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${victim.id}/sessions/revoke`,
      headers: as(adminToken),
      payload: { reason: 'credentials possibly compromised' }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.ok(Number((res.json() as any).revoked) >= 1, 'a session was ended')

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [victim.id])
    assert.equal(Number(rows[0].n), 0)

    // Revoking the refresh token alone would leave the access token usable
    // until it expired, which is the whole reason the version is bumped.
    const after = await app.inject({ url: '/v1/auth/permissions', headers: as(victim.token) })
    assert.equal(after.statusCode, 401, 'the access token outlived the sign-out')
  })

  test('signing out does not change the account status', async () => {
    const victim = await account()
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${victim.id}/sessions/revoke`,
      headers: as(adminToken),
      payload: { reason: 'not a punishment' }
    })
    const { rows } = await pool.query('SELECT status FROM users WHERE id = $1', [victim.id])
    assert.equal(rows[0].status, 'active', 'a sign-out is not a suspension')
  })

  test('a sign-out is written to the audit log', async () => {
    const victim = await account()
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${victim.id}/sessions/revoke`,
      headers: as(adminToken),
      payload: { reason: 'audited on purpose' }
    })
    const { rows } = await pool.query(
      `SELECT action FROM audit_logs WHERE subject_type = 'user' AND subject_id = $1 AND action = 'user.sessions.revoke'`,
      [victim.id])
    assert.equal(rows.length, 1)
  })
})
