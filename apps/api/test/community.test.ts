// The forum, the chat rooms and the development log.
//
// The permission boundaries are the point. Anyone signed in may start a board
// and post in it — that is the request, and it is why the moderation grants
// exist — so what has to be checked is that the line between "anyone" and
// "a moderator" is where it is supposed to be, from both sides.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'community-test-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '50'
process.env.RATE_LIMIT_MAX ??= '5000'
process.env.WRITE_RATE_LIMIT_MAX ??= '500'

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

interface Account { username: string, token: string, id: string }

describe('community', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  const made: string[] = []
  let member: Account
  let moderator: Account

  async function register (prefix: string): Promise<Account> {
    const username = prefix + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    made.push(username)
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    return { username, token: (res.json() as { accessToken: string }).accessToken, id: String(rows[0]!.id) }
  }

  const as = (account: Account): Record<string, string> => ({ authorization: `Bearer ${account.token}` })

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    member = await register('com_')
    moderator = await register('mod_')
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = 'moderator' ON CONFLICT DO NOTHING",
      [moderator.id]
    )
  })

  after(async () => {
    for (const username of made) await pool?.query('DELETE FROM users WHERE username = $1', [username])
    await app?.close()
    await pool?.end()
  })

  // ---- forum ----

  describe('the forum', () => {
    let slug = ''
    let forumId = ''
    let topicId = ''

    test('an ordinary account can start a board', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/forum', headers: as(member),
        payload: { name: 'Teszt ' + randomBytes(3).toString('hex'), description: 'Egy kategória' }
      })
      assert.equal(res.statusCode, 201, res.body)
      const body = res.json() as { id: string, slug: string }
      slug = body.slug
      forumId = body.id
      // Hungarian accents fold rather than being dropped or escaped, or the
      // slug for "Őszi szezon" would be unreadable or empty.
      assert.match(slug, /^[a-z0-9-]+$/)
    })

    test('a signed-out visitor cannot', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/forum', payload: { name: 'Névtelen' } })
      assert.equal(res.statusCode, 401)
    })

    test('two boards with the same name both get one', async () => {
      const name = 'Ütközés ' + randomBytes(3).toString('hex')
      const first = await app.inject({ method: 'POST', url: '/v1/forum', headers: as(member), payload: { name } })
      const second = await app.inject({ method: 'POST', url: '/v1/forum', headers: as(member), payload: { name } })
      assert.equal(first.statusCode, 201)
      assert.equal(second.statusCode, 201, 'a name collision must be a rename, not an error')
      assert.notEqual((first.json() as { slug: string }).slug, (second.json() as { slug: string }).slug)
    })

    test('a topic and its first post arrive together', async () => {
      const res = await app.inject({
        method: 'POST', url: `/v1/forum/${slug}/topics`, headers: as(member),
        payload: { title: 'Első téma', body: 'Sziasztok!' }
      })
      assert.equal(res.statusCode, 201, res.body)
      topicId = (res.json() as { id: string }).id

      // A topic with no post in it is a row nothing can render.
      const posts = await app.inject({ url: `/v1/forum/topics/${topicId}/posts` })
      assert.equal((posts.json() as { data: unknown[] }).data.length, 1)
    })

    test('a reply moves the topic counters with it', async () => {
      const res = await app.inject({
        method: 'POST', url: `/v1/forum/topics/${topicId}/posts`, headers: as(member), payload: { body: 'Én is.' }
      })
      assert.equal(res.statusCode, 201, res.body)
      const topic = await app.inject({ url: `/v1/forum/topics/${topicId}` })
      assert.equal((topic.json() as { post_count: number }).post_count, 2)
    })

    test('an ordinary account cannot pin, lock or delete', async () => {
      for (const [payload, what] of [[{ pinned: true }, 'pin'], [{ locked: true }, 'lock']] as const) {
        const res = await app.inject({ method: 'PATCH', url: `/v1/forum/topics/${topicId}`, headers: as(member), payload })
        assert.equal(res.statusCode, 403, `${what} should be refused`)
      }
      assert.equal((await app.inject({ method: 'DELETE', url: `/v1/forum/${forumId}`, headers: as(member) })).statusCode, 403)
      assert.equal((await app.inject({ method: 'DELETE', url: `/v1/forum/topics/${topicId}`, headers: as(member) })).statusCode, 403)
    })

    test('a moderator can', async () => {
      const pinned = await app.inject({ method: 'PATCH', url: `/v1/forum/topics/${topicId}`, headers: as(moderator), payload: { pinned: true } })
      assert.equal(pinned.statusCode, 200, pinned.body)
      assert.equal((pinned.json() as { pinned: boolean }).pinned, true)
    })

    test('a locked topic refuses replies, from anyone', async () => {
      await app.inject({ method: 'PATCH', url: `/v1/forum/topics/${topicId}`, headers: as(moderator), payload: { locked: true } })
      for (const account of [member, moderator]) {
        const res = await app.inject({
          method: 'POST', url: `/v1/forum/topics/${topicId}/posts`, headers: as(account), payload: { body: 'Még valami' }
        })
        assert.equal(res.statusCode, 409, `${account.username} got past the lock`)
      }
      await app.inject({ method: 'PATCH', url: `/v1/forum/topics/${topicId}`, headers: as(moderator), payload: { locked: false } })
    })

    test('a post cannot be edited by somebody else', async () => {
      const posts = await app.inject({ url: `/v1/forum/topics/${topicId}/posts` })
      const [first] = (posts.json() as { data: Array<{ id: string }> }).data
      const other = await register('oth_')
      const res = await app.inject({
        method: 'PATCH', url: `/v1/forum/posts/${first!.id}`, headers: as(other), payload: { body: 'átírva' }
      })
      assert.equal(res.statusCode, 403)
    })

    test('deleting a post hides it and corrects the count', async () => {
      const before = await app.inject({ url: `/v1/forum/topics/${topicId}/posts` })
      const [, second] = (before.json() as { data: Array<{ id: string }> }).data
      assert.ok(second, 'the fixture should have two posts')

      assert.equal((await app.inject({ method: 'DELETE', url: `/v1/forum/posts/${second.id}`, headers: as(moderator) })).statusCode, 204)

      const after = await app.inject({ url: `/v1/forum/topics/${topicId}/posts` })
      assert.equal((after.json() as { data: unknown[] }).data.length, 1)
      // Hidden, not deleted: the moderation queue needs the text it acted on.
      const { rows } = await pool.query('SELECT hidden_at FROM posts WHERE id = $1', [second.id])
      assert.ok(rows[0]?.hidden_at, 'the row should still be there, hidden')
    })
  })

  // ---- chat ----

  describe('chat rooms', () => {
    test('the rooms are public to read', async () => {
      const res = await app.inject({ url: '/v1/chat/rooms' })
      assert.equal(res.statusCode, 200)
      assert.ok(Array.isArray((res.json() as { data: unknown[] }).data))
    })

    test('joining is what makes you a member, and is idempotent', async () => {
      const { rows } = await pool.query("SELECT slug FROM chats WHERE kind = 'room' LIMIT 1")
      if (!rows[0]) return // no seeded rooms in this database

      const slug = String(rows[0].slug)
      const first = await app.inject({ method: 'POST', url: `/v1/chat/rooms/${slug}/join`, headers: as(member) })
      const second = await app.inject({ method: 'POST', url: `/v1/chat/rooms/${slug}/join`, headers: as(member) })
      assert.equal(first.statusCode, 200, first.body)
      assert.equal(second.statusCode, 200, 'opening the room twice is not an error')

      const members = await pool.query(
        'SELECT count(*)::int AS n FROM chat_members m JOIN chats c ON c.id = m.chat_id WHERE c.slug = $1 AND m.user_id = $2',
        [slug, member.id]
      )
      assert.equal(members.rows[0]!.n, 1, 'joining twice must not make two memberships')
    })

    test('a signed-out visitor cannot join', async () => {
      const { rows } = await pool.query("SELECT slug FROM chats WHERE kind = 'room' LIMIT 1")
      if (!rows[0]) return
      const res = await app.inject({ method: 'POST', url: `/v1/chat/rooms/${String(rows[0].slug)}/join` })
      assert.equal(res.statusCode, 401)
    })

    test('only a moderator can take a message down', async () => {
      const { rows } = await pool.query("SELECT id FROM messages WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1")
      if (!rows[0]) return
      const id = String(rows[0].id)
      assert.equal((await app.inject({ method: 'DELETE', url: `/v1/chat/messages/${id}`, headers: as(member) })).statusCode, 403)
    })
  })

  // ---- development log ----

  describe('the development log', () => {
    let releaseId = ''
    const version = '99.' + randomBytes(2).toString('hex')

    test('is public to read, planned releases included', async () => {
      const res = await app.inject({ url: '/v1/changelog' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Array<{ status: string, entries: unknown[] }> }
      assert.ok(Array.isArray(data))
      // "What is coming" is half the point of the page, so an unreleased
      // version has to be served rather than filtered out.
      if (data.length) assert.ok(data.every(release => Array.isArray(release.entries)))
    })

    test('an ordinary account cannot write to it', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/changelog', headers: as(member), payload: { version, title: 'Nem szabad' }
      })
      assert.equal(res.statusCode, 403)
    })

    test('an editor can, with its lines', async () => {
      const editor = await register('edt_')
      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = 'editor' ON CONFLICT DO NOTHING",
        [editor.id]
      )
      const res = await app.inject({
        method: 'POST', url: '/v1/changelog', headers: as(editor),
        payload: {
          version,
          title: 'Teszt kiadás',
          status: 'planned',
          entries: [{ kind: 'added', body: 'Valami új' }, { kind: 'fixed', body: 'Valami javítva' }]
        }
      })
      assert.equal(res.statusCode, 201, res.body)
      releaseId = (res.json() as { id: string }).id

      const read = await app.inject({ url: `/v1/changelog/${version}` })
      const release = read.json() as { entries: Array<{ kind: string }> }
      assert.equal(release.entries.length, 2)
      assert.deepEqual(release.entries.map(e => e.kind).sort(), ['added', 'fixed'])
    })

    test('the same version cannot be written twice', async () => {
      const editor = await register('ed2_')
      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = 'editor' ON CONFLICT DO NOTHING",
        [editor.id]
      )
      const res = await app.inject({
        method: 'POST', url: '/v1/changelog', headers: as(editor), payload: { version, title: 'Megint' }
      })
      assert.equal(res.statusCode, 409)
      await pool.query('DELETE FROM releases WHERE id = $1', [releaseId])
    })
  })

  // ---- the permissions themselves ----

  test('the permissions these routes enforce are marked as enforced', async () => {
    // The admin Roles screen reads `status` to say which grants a route
    // actually checks today. A route enforcing a permission still marked
    // `planned` tells an administrator it does nothing.
    const { rows } = await pool.query(
      `SELECT slug FROM permissions
        WHERE slug = ANY($1::text[]) AND status <> 'active'`,
      [['forum.create', 'forum.delete', 'topic.create', 'topic.pin', 'topic.lock',
        'post.create', 'post.delete', 'chat.moderate', 'changelog.manage']]
    )
    assert.deepEqual(rows.map(r => r.slug), [])
  })
})
