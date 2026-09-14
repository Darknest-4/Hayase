// The development log's visibility flag.
//
// Its own file rather than appended to the announcements suite, even though
// the two ship in the same migration: `pool` is a module singleton and each
// suite's `after` closes it, so two suites in one file race to shut down the
// connection the other is still using. The second one loses with
// "cancelledByParent", which says nothing about what went wrong.
//
// The property under test is the one the owner asked for: write everything
// down, publish only part of it.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'changelog-visibility-secret-long-enough-0123'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

const PASSWORD = 'a-long-enough-test-password-1'

describe('development log visibility', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const userIds: string[] = []
  const versions: string[] = []
  let editor = ''

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/infrastructure/database/index.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    const username = 'clog_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: PASSWORD }
    })
    assert.equal(res.statusCode, 201, res.body)
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    userIds.push(rows[0].id as string)
    // `editor`, not `admin`: migration 0036 granted changelog.manage to the
    // editor role, which is the role that writes the log.
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'editor'
       ON CONFLICT DO NOTHING`, [username])
    const auth = await import('../src/middleware/auth.ts')
    auth.invalidatePermissions()
    editor = (res.json() as { accessToken: string }).accessToken
  })

  after(async () => {
    if (versions.length) await pool.query('DELETE FROM releases WHERE version = ANY($1)', [versions])
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds])
    await app?.close()
    await pool?.end()
  })

  async function release (isPublic: boolean): Promise<string> {
    const version = 'test-' + randomBytes(4).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/changelog',
      headers: { authorization: `Bearer ${editor}` },
      payload: { version, title: 'A release', status: 'released', isPublic, category: 'Weboldal' }
    })
    assert.equal(res.statusCode, 201, res.body)
    versions.push(version)
    return version
  }

  test('a private release is recorded but not published', async () => {
    const open = await release(true)
    const hidden = await release(false)

    const pub = await app.inject({ url: '/v1/changelog', headers: { authorization: `Bearer ${editor}` } })
    assert.equal(pub.statusCode, 200, pub.body)
    const published = (pub.json() as { data: Array<{ version: string }> }).data.map(r => r.version)
    assert.ok(published.includes(open), 'a public release is published')
    assert.ok(!published.includes(hidden), 'a private release must not reach the public log')

    const all = await app.inject({ url: '/v1/changelog/all', headers: { authorization: `Bearer ${editor}` } })
    assert.equal(all.statusCode, 200, all.body)
    const everything = (all.json() as { data: Array<{ version: string }> }).data.map(r => r.version)
    assert.ok(everything.includes(hidden), 'but the author can still see it')
  })

  test('existing releases stay public — the column defaults true', async () => {
    const { rows } = await pool.query('SELECT count(*) FILTER (WHERE NOT is_public) AS hidden FROM releases WHERE version NOT LIKE $1', ['test-%'])
    assert.equal(Number(rows[0].hidden), 0, 'the migration must not have hidden anything that was visible')
  })

  test('publishing is a PATCH away', async () => {
    const version = await release(false)
    const { rows } = await pool.query('SELECT id FROM releases WHERE version = $1', [version])
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/changelog/${rows[0].id}`,
      headers: { authorization: `Bearer ${editor}` },
      payload: { isPublic: true }
    })
    assert.equal(res.statusCode, 200, res.body)

    const pub = await app.inject({ url: '/v1/changelog', headers: { authorization: `Bearer ${editor}` } })
    const published = (pub.json() as { data: Array<{ version: string }> }).data.map(r => r.version)
    assert.ok(published.includes(version), 'flipping the flag publishes it')
  })
})
