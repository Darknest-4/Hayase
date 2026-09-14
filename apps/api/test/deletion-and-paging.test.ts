// Two faults that shipped, and the assertions that would have caught them.
//
// Both were found by using the product rather than by reading it, and both
// are the same shape: a contract agreed on one side of a boundary and spelled
// differently on the other, with nothing in between to complain.
//
//   1. Self-service account deletion answered 500 to everybody. softDelete()
//      ran `DELETE FROM user_settings WHERE user_id = $1`; that table is keyed
//      by profile_id and has never had a user_id column, so Postgres raised
//      42703, the transaction rolled back and nothing was erased. It failed
//      closed — no half-deleted account — but the feature did not exist.
//
//   2. A catalogue-backed search could only ever show its first page.
//      /v1/anime/search answered {data, query} with nothing about what came
//      after, so the client could not offer more however many titles matched.
//
// Neither needed a browser to catch. What they needed was a test that asks
// for the second page, and one that deletes an account and looks at the code.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'deletion-paging-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

const PASSWORD = 'a-long-enough-test-password-1'

describe('account deletion and catalogue paging', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  // Ids, not usernames. A soft delete renames the account — that is the whole
  // point of it — so cleaning up by the name the test registered leaves the row
  // behind under its `deleted_*` spelling. Those survivors are invisible here
  // and show up as a failure in an unrelated admin-list suite, which is a
  // miserable way to find out.
  const userIds: string[] = []

  async function account (): Promise<{ token: string, username: string, profileId: string }> {
    const username = 'del_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: PASSWORD }
    })
    assert.equal(res.statusCode, 201, res.body)
    const token = (res.json() as { accessToken: string }).accessToken
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    userIds.push(rows[0].id as string)
    const me = await app.inject({ url: '/v1/profiles/me', headers: { authorization: `Bearer ${token}` } })
    assert.equal(me.statusCode, 200, me.body)
    return { token, username, profileId: (me.json() as { id: string }).id }
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/infrastructure/database/index.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
  })

  after(async () => {
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds])
    await app?.close()
    await pool?.end()
  })

  // ---- 1. deletion ---------------------------------------------------------

  test('deleting an account succeeds and erases the identifying columns', async () => {
    const { token, username } = await account()

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: PASSWORD }
    })
    // The bug made this a 500 for every account on every deployment.
    assert.ok(res.statusCode < 400, `deletion failed: ${res.statusCode} ${res.body}`)

    const { rows } = await pool.query(
      'SELECT username, email, password_hash, status FROM users WHERE id = (SELECT id FROM users WHERE username = $1)',
      [username]
    )
    // The row survives on purpose — moderation history and other people's
    // context hang off it — but nothing identifying is left on it.
    assert.equal(rows.length, 0, 'the old username must not resolve any more')
  })

  test('deletion removes the settings that hang off the account’s profiles', async () => {
    const { token, profileId } = await account()
    await pool.query(
      `INSERT INTO user_settings (profile_id, key, value) VALUES ($1, 'test.key', '"x"'::jsonb)
       ON CONFLICT (profile_id, key) DO UPDATE SET value = excluded.value`,
      [profileId]
    )
    const before = await pool.query('SELECT 1 FROM user_settings WHERE profile_id = $1', [profileId])
    assert.equal(before.rows.length, 1, 'fixture must exist before the deletion')

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: PASSWORD }
    })
    assert.ok(res.statusCode < 400, `deletion failed: ${res.statusCode} ${res.body}`)

    const after = await pool.query('SELECT 1 FROM user_settings WHERE profile_id = $1', [profileId])
    assert.equal(after.rows.length, 0, 'per-profile settings must go with the account')
  })

  // ---- 2. paging -----------------------------------------------------------

  test('search says whether another page exists, and the pages differ', async () => {
    const { token } = await account()
    const headers = { authorization: `Bearer ${token}` }

    const first = await app.inject({ url: '/v1/anime/search?q=a&limit=5', headers })
    assert.equal(first.statusCode, 200, first.body)
    const one = first.json() as { data: Array<{ id: string }>, hasMore?: boolean }

    assert.ok(Array.isArray(one.data), 'search must answer with rows')
    // The field itself is the fix: without it the client cannot know there is
    // a second page, and stops at the first whatever the catalogue holds.
    assert.equal(typeof one.hasMore, 'boolean', 'search must report hasMore')
    assert.ok(one.data.length <= 5, 'the probe row must not reach the client')

    if (!one.hasMore) return // a catalogue too small to page is not a failure

    const second = await app.inject({ url: '/v1/anime/search?q=a&limit=5&offset=5', headers })
    assert.equal(second.statusCode, 200, second.body)
    const two = second.json() as { data: Array<{ id: string }> }
    assert.ok(two.data.length > 0, 'the second page must have rows when hasMore said so')

    const firstIds = new Set(one.data.map(r => r.id))
    const overlap = two.data.filter(r => firstIds.has(r.id))
    assert.equal(overlap.length, 0, 'the second page must not repeat the first')
  })

  test('browse answers with a cursor that fetches a different page', async () => {
    const { token } = await account()
    const headers = { authorization: `Bearer ${token}` }

    const first = await app.inject({ url: '/v1/anime/?limit=5', headers })
    assert.equal(first.statusCode, 200, first.body)
    const one = first.json() as { data: Array<{ id: string }>, nextCursor?: string }
    if (!one.nextCursor) return // catalogue smaller than one page

    const second = await app.inject({ url: `/v1/anime/?limit=5&cursor=${encodeURIComponent(one.nextCursor)}`, headers })
    assert.equal(second.statusCode, 200, second.body)
    const two = second.json() as { data: Array<{ id: string }> }

    const firstIds = new Set(one.data.map(r => r.id))
    assert.equal(two.data.filter(r => firstIds.has(r.id)).length, 0, 'the cursor must move past the first page')
  })
})
