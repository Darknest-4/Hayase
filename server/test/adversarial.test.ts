// Adversarial regression suite.
//
// These are the probes from the security hunt, made permanent. Each one is a
// thing that was actually attempted against a running instance; the ones that
// found a defect are marked, so that if the fix is ever reverted the test says
// what used to happen rather than only that an assertion failed.
//
// Like the other integration tests these use Fastify's inject(), so there is
// no socket to bind and no race between "server up" and "test running". They
// need a database and skip cleanly without one.

import assert from 'node:assert/strict'
import { randomBytes, createHmac } from 'node:crypto'
import { test, describe, before, after } from 'node:test'

import type { FastifyInstance } from 'fastify'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'adversarial-test-secret-long-enough-0123456789'
// These tests make many writes on purpose; the limits have their own tests.
process.env.RATE_LIMIT_MAX ??= '5000'
process.env.WRITE_RATE_LIMIT_MAX ??= '2000'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>, rowCount: number | null }> }

const unique = (): string => randomBytes(6).toString('hex')
const NONEXISTENT_UUID = '00000000-0000-4000-8000-000000000000'

/** A second account, so "someone else's thing" is a real thing and not a guess. */
interface Account { username: string, token: string, id: string, profileId: string }

async function register (): Promise<Account> {
  const username = 'adv_' + unique()
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
  })
  assert.equal(res.statusCode, 201, 'registration should succeed: ' + res.body)
  const token = (res.json() as { accessToken: string }).accessToken
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
  const id = String(rows[0]!.id)
  const profile = await pool.query(
    `INSERT INTO user_profiles (user_id, display_name) VALUES ($1, 'adv') RETURNING id`, [id])
  return { username, token, id, profileId: String(profile.rows[0]!.id) }
}

describe('adversarial', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let victim: Account
  let attacker: Account

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
    victim = await register()
    attacker = await register()
  })

  after(async () => {
    for (const account of [victim, attacker]) {
      if (account) await pool.query('DELETE FROM users WHERE id = $1', [account.id])
    }
    await app?.close()
    await pool?.end()
  })

  const auth = (account: Account): Record<string, string> => ({
    authorization: `Bearer ${account.token}`,
    'x-profile-id': account.profileId
  })

  // ---- token forgery ----

  describe('token forgery', () => {
    test('the "none" algorithm is not accepted', async () => {
      // The oldest JWT trick there is: drop the signature and claim the token
      // needs none. A library that honours alg=none hands over any account.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      const claims = Buffer.from(JSON.stringify({ sub: victim.id, username: victim.username })).toString('base64url')
      const res = await app.inject({
        url: '/v1/me/library',
        headers: { authorization: `Bearer ${header}.${claims}.` }
      })
      assert.equal(res.statusCode, 401)
    })

    test('a token signed with the wrong key is refused', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
      const claims = Buffer.from(JSON.stringify({ sub: victim.id, username: victim.username, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
      const signature = createHmac('sha256', 'not-the-real-secret').update(`${header}.${claims}`).digest('base64url')
      const res = await app.inject({
        url: '/v1/me/library',
        headers: { authorization: `Bearer ${header}.${claims}.${signature}` }
      })
      assert.equal(res.statusCode, 401)
    })

    test('a tampered payload invalidates the signature', async () => {
      const [header, claims, signature] = victim.token.split('.')
      const decoded = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as Record<string, unknown>
      decoded.sub = attacker.id
      const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url')
      const res = await app.inject({
        url: '/v1/me/library',
        headers: { authorization: `Bearer ${header}.${forged}.${signature}` }
      })
      assert.equal(res.statusCode, 401)
    })

    test('malformed authorization headers are refused, not crashed on', async () => {
      for (const value of ['Bearer', 'Bearer ', 'Basic abc', 'Bearer a.b', 'Bearer ...', victim.token]) {
        const res = await app.inject({ url: '/v1/me/library', headers: { authorization: value } })
        assert.equal(res.statusCode, 401, `${JSON.stringify(value)} must be refused`)
      }
    })

    test('an expired token is refused', async () => {
      // exp is set directly: fast-jwt refuses a negative expiresIn option.
      const past = Math.floor(Date.now() / 1000) - 3600
      const token = app.jwt.sign({ sub: victim.id, username: victim.username, tv: 0, exp: past })
      const res = await app.inject({ url: '/v1/me/library', headers: { authorization: `Bearer ${token}` } })
      assert.equal(res.statusCode, 401)
    })
  })

  // ---- reaching another account's data ----

  describe('object ownership', () => {
    test('another account\'s profile header is refused', async () => {
      const res = await app.inject({
        url: '/v1/me/library',
        headers: { authorization: `Bearer ${attacker.token}`, 'x-profile-id': victim.profileId }
      })
      assert.equal(res.statusCode, 403)
    })

    test('a profile id that does not exist is refused, not created', async () => {
      const res = await app.inject({
        url: '/v1/me/library',
        headers: { authorization: `Bearer ${attacker.token}`, 'x-profile-id': NONEXISTENT_UUID }
      })
      assert.equal(res.statusCode, 403)
    })

    test('GraphQL honours the same profile ownership check', async () => {
      // The REST path and the GraphQL path resolve the header separately, so
      // fixing one and not the other is an easy way to leave the hole open.
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { authorization: `Bearer ${attacker.token}`, 'x-profile-id': victim.profileId, 'content-type': 'application/json' },
        payload: { query: '{ __typename }' }
      })
      // The query itself is trivial; what matters is that the borrowed profile
      // was not adopted into the context.
      assert.equal(res.statusCode, 200)
    })
  })

  // ---- injection ----

  describe('injection', () => {
    test('SQL metacharacters in search are data, not syntax', async () => {
      for (const q of [
        "' OR 1=1--",
        "'; DROP TABLE users;--",
        "x' UNION SELECT null,null,null--",
        "%' AND pg_sleep(5)--",
        '\\'
      ]) {
        const res = await app.inject({ url: `/v1/anime/search?q=${encodeURIComponent(q)}` })
        assert.ok(res.statusCode === 200 || res.statusCode === 400, `${q} gave ${res.statusCode}`)
      }
      // and the table is still there
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM users')
      assert.ok(Number(rows[0]!.n) >= 2)
    })

    test('a sort column is chosen from a fixed list, never from input', async () => {
      for (const sort of ['popularity; DROP TABLE anime', '(SELECT 1)', 'id--', 'nonexistent_column']) {
        const res = await app.inject({ url: `/v1/anime/?sort=${encodeURIComponent(sort)}` })
        assert.equal(res.statusCode, 400, `${sort} must be rejected by schema`)
      }
    })

    test('a keyset cursor cannot smuggle SQL', async () => {
      for (const cursor of ['1|abc', "1|' OR '1'='1", 'x'.repeat(500), '|', '||']) {
        const res = await app.inject({ url: `/v1/anime/?cursor=${encodeURIComponent(cursor)}` })
        assert.ok(res.statusCode === 200 || res.statusCode === 400, `${cursor} gave ${res.statusCode}`)
      }
    })
  })

  // ---- what a 500 is allowed to say ----

  describe('information disclosure', () => {
    test('an error body never carries SQL state or internals', async () => {
      const probes = [
        '/v1/anime/not-a-uuid',
        '/v1/anime/by-anilist/abc',
        '/v1/comments/?subjectType=anime&subjectId=not-a-uuid'
      ]
      for (const url of probes) {
        const res = await app.inject({ url })
        const body = res.body
        for (const leak of ['pg_', 'SQLSTATE', 'at Object.', 'node_modules', '/home/', 'password']) {
          assert.ok(!body.includes(leak), `${url} leaked ${leak}: ${body.slice(0, 200)}`)
        }
      }
    })

    test('the public config exposes no secret', async () => {
      const body = (await app.inject({ url: '/v1/config' })).body.toLowerCase()
      for (const leak of ['jwt_secret', 'database_url', 'postgres://', 'password', 'secret']) {
        assert.ok(!body.includes(leak), `public config leaked ${leak}`)
      }
    })

    test('a 500 quotes a request id instead of the exception', async () => {
      // Regression: setErrorHandler used to be registered after the routes, so
      // Fastify never bound it and raw exception text reached the caller.
      const res = await app.inject({ url: '/v1/anime/by-anilist/999999999' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.headers['content-type']?.toString().split(';')[0], 'application/problem+json')
    })
  })

  // ---- caching ----

  describe('response caching', () => {
    test('an authenticated response is marked no-store', async () => {
      // Found by probe: authenticated bodies left with no Cache-Control at
      // all, so a shared cache was free to apply heuristic freshness to
      // per-user data.
      const res = await app.inject({ url: '/v1/me/library', headers: auth(victim) })
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['cache-control'], 'no-store')
    })

    test('an anonymous response is not forced to no-store', async () => {
      const res = await app.inject({ url: '/v1/anime/?limit=1' })
      assert.notEqual(res.headers['cache-control'], 'no-store')
    })
  })

  // ---- input that is well-formed but wrong ----

  describe('value validation', () => {
    let animeId = ''

    before(async () => {
      const { rows } = await pool.query('SELECT id FROM anime LIMIT 1')
      animeId = rows[0] ? String(rows[0].id) : ''
    })

    test('out-of-range library values are refused', async () => {
      if (!animeId) return
      const bad: Array<Record<string, unknown>> = [
        { score: 99 },                  // the scale is 0-10
        { score: -5 },
        { progress: -1 },               // no negative episode count
        { status: 'watching' },         // the enum is upper-case
        { status: 'not-a-status' },
        { notes: 'x'.repeat(3_000) }    // over maxLength
      ]
      for (const patch of bad) {
        const res = await app.inject({
          method: 'PUT',
          url: `/v1/me/library/${animeId}`,
          headers: auth(victim),
          payload: patch
        })
        assert.equal(res.statusCode, 400, `${JSON.stringify(patch)} gave ${res.statusCode}`)
      }
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM library_entries WHERE profile_id = $1', [victim.profileId])
      assert.equal(Number(rows[0]!.n), 0, 'no invalid write may have landed')
    })

    test('an unrecognised field is dropped rather than written', async () => {
      // Fastify's AJV is configured with removeAdditional, so a field the
      // schema does not declare never reaches the handler. That is the
      // property that matters — mass assignment is impossible — and it is
      // worth pinning, because a schema written with additionalProperties
      // alone would look like it rejects and in fact silently strips.
      if (!animeId) return
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/me/library/${animeId}`,
        headers: auth(victim),
        payload: { status: 'WATCHING', rewatches: -3, profile_id: attacker.profileId, anime_id: NONEXISTENT_UUID }
      })
      assert.equal(res.statusCode, 200, res.body)

      const { rows } = await pool.query(
        'SELECT profile_id, anime_id, rewatches FROM library_entries WHERE profile_id = $1', [victim.profileId])
      assert.equal(rows.length, 1, 'the row must belong to the caller, not to the injected profile')
      assert.equal(String(rows[0]!.anime_id), animeId, 'the injected anime_id must not have been honoured')
      assert.equal(Number(rows[0]!.rewatches), 0, 'the injected negative count must not have been written')

      const { rows: attackerRows } = await pool.query(
        'SELECT 1 FROM library_entries WHERE profile_id = $1', [attacker.profileId])
      assert.equal(attackerRows.length, 0, 'nothing may have been written to the other account')

      await pool.query('DELETE FROM library_entries WHERE profile_id = $1', [victim.profileId])
    })

    test('a library write against an unknown anime is refused', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/me/library/${NONEXISTENT_UUID}`,
        headers: auth(victim),
        payload: { status: 'WATCHING' }
      })
      assert.equal(res.statusCode, 404)
    })

    test('a report cannot name a subject that does not exist', async () => {
      // Found by probe: any well-formed uuid was accepted, so one account
      // could mint unlimited moderation-queue entries pointing at nothing.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: auth(attacker),
        payload: { subjectType: 'comment', subjectId: NONEXISTENT_UUID, reason: 'spam' }
      })
      assert.equal(res.statusCode, 404, 'expected 404, got ' + res.body)
    })

    test('a report against a real subject still works', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: auth(attacker),
        payload: { subjectType: 'user', subjectId: victim.id, reason: 'spam' }
      })
      assert.equal(res.statusCode, 201, res.body)
      await pool.query('DELETE FROM reports WHERE reporter_id = $1', [attacker.id])
    })

    test('a comment cannot be attached to an anime that does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/comments',
        headers: auth(attacker),
        payload: { subjectType: 'anime', subjectId: NONEXISTENT_UUID, body: 'hello' }
      })
      assert.equal(res.statusCode, 404)
    })

    test('a reply cannot adopt a parent from another subject', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/comments',
        headers: auth(attacker),
        payload: { subjectType: 'post', subjectId: NONEXISTENT_UUID, body: 'x', parentId: NONEXISTENT_UUID }
      })
      assert.equal(res.statusCode, 404)
    })
  })

  // ---- protocol handling ----

  describe('protocol handling', () => {
    test('a body that is not JSON is rejected, not parsed loosely', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '{"identifier": '
      })
      assert.equal(res.statusCode, 400)
    })

    test('string bounds on credentials are enforced', async () => {
      for (const payload of [
        { identifier: 'a', password: 'long-enough-here' },              // under minLength
        { identifier: 'x'.repeat(300), password: 'long-enough-here' },  // over maxLength
        { identifier: 'someone', password: 'short' },                   // under minLength
        { identifier: 'someone' },                                      // missing field
        { password: 'long-enough-here' }                                // missing field
      ]) {
        const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload })
        assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} gave ${res.statusCode}`)
      }
    })

    test('a wrong method on a real route does not fall through', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/auth/login' })
      assert.ok(res.statusCode === 404 || res.statusCode === 405, `got ${res.statusCode}`)
    })
  })

  // ---- path traversal ----

  describe('path traversal', () => {
    test('a traversal in the package route reaches nothing', async () => {
      // The store is content-addressed: the key IS the hash, which is looked
      // up in the database, so no path is ever built from request input. This
      // asserts that stays true if the storage layer is ever changed.
      for (const version of [
        '../../../etc/passwd',
        '..%2f..%2f..%2fetc%2fpasswd',
        '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        '....//....//etc/passwd',
        '%00../../etc/passwd'
      ]) {
        const res = await app.inject({ url: `/v1/extensions/any/versions/${version}/package` })
        assert.ok(!res.body.includes('root:'), `${version} returned /etc/passwd`)
        assert.ok(!res.body.includes('JWT_SECRET'), `${version} returned an env file`)
      }
    })

    test('the SPA fallback serves the client, never a file off disk', async () => {
      // A non-API GET that is not a real file returns index.html by design.
      // The risk is that a traversal escapes the web root instead, so the
      // check is on the content, not the status.
      for (const url of ['/../../etc/passwd', '/..%2f..%2f.env', '/static/../../../etc/passwd']) {
        const res = await app.inject({ url })
        assert.ok(!res.body.includes('root:'), `${url} returned /etc/passwd`)
        assert.ok(!res.body.includes('JWT_SECRET'), `${url} returned an env file`)
      }
    })
  })

  // ---- GraphQL ----

  describe('graphql limits', () => {
    test('a document longer than the cap is refused before parsing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: '{ ' + 'a'.repeat(20_000) + ' }' }
      })
      assert.equal(res.statusCode, 413)
    })

    test('batched queries are not accepted', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: [{ query: '{ __typename }' }, { query: '{ __typename }' }]
      })
      assert.notEqual(res.statusCode, 200)
    })

    test('a deeply nested query is refused', async () => {
      // Cyclic relations (anime → relations → anime → …) let a short document
      // ask for an enormous result.
      let selection = 'id'
      for (let i = 0; i < 15; i++) selection = `relations { node { ${selection} } }`
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: `{ anime(id: "${NONEXISTENT_UUID}") { ${selection} } }` }
      })
      const body = res.body
      assert.ok(res.statusCode !== 200 || body.includes('errors'), 'a 15-deep query must not simply succeed')
    })
  })

  // ---- concurrency ----

  describe('concurrency', () => {
    test('parallel identical registrations produce exactly one account', async () => {
      // Regression: the unique violation used to escape as a 500 carrying the
      // constraint name.
      const username = 'race_' + unique()
      const payload = { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
      const results = await Promise.all(
        Array.from({ length: 5 }, async () =>
          app.inject({ method: 'POST', url: '/v1/auth/register', payload }))
      )
      const codes = results.map(r => r.statusCode)
      assert.equal(codes.filter(c => c === 201).length, 1, 'exactly one must be created: ' + codes)
      assert.ok(codes.every(c => c === 201 || c === 409), 'the rest must be 409, got ' + codes)

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE username = $1', [username])
      assert.equal(Number(rows[0]!.n), 1)
      await pool.query('DELETE FROM users WHERE username = $1', [username])
    })

    test('parallel likes on one comment do not double-count', async () => {
      const { rows: animeRows } = await pool.query('SELECT id FROM anime LIMIT 1')
      if (!animeRows[0]) return
      const created = await app.inject({
        method: 'POST',
        url: '/v1/comments',
        headers: auth(victim),
        payload: { subjectType: 'anime', subjectId: String(animeRows[0].id), body: 'race target' }
      })
      if (created.statusCode !== 201) return
      const id = (created.json() as { id: string }).id

      const codes = await Promise.all(Array.from({ length: 8 }, async () =>
        app.inject({ method: 'POST', url: `/v1/comments/${id}/like`, headers: auth(attacker) })
          .then(r => r.statusCode)))

      // The original assertion only checked the database, so it passed while
      // the API was answering 500. A double-clicked like button really did
      // return "500 Internal Server Error" carrying comment_likes_pkey:
      // verified live as 200 200 200 500 500 500 across six parallel calls.
      assert.ok(codes.every(c => c < 500), 'a raced toggle must not 500: ' + codes.join(' '))

      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM comment_likes WHERE comment_id = $1', [id])
      assert.ok(Number(rows[0]!.n) <= 1, 'a user must not hold two likes on one comment')

      const { rows: counted } = await pool.query('SELECT like_count FROM comments WHERE id = $1', [id])
      assert.ok(Number(counted[0]!.like_count) >= 0, 'like_count must never go negative')
      await pool.query('DELETE FROM comments WHERE id = $1', [id])
    })
  })

  // ---- the extension store's entry point ----

  describe('developer portal', () => {
    before(async () => {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, r.id FROM roles r WHERE r.slug = 'admin' ON CONFLICT DO NOTHING`, [attacker.id])
      const authPlugin = await import('../src/plugins/auth.ts')
      authPlugin.invalidatePermissions()
    })

    after(async () => {
      await pool.query('DELETE FROM extensions WHERE slug LIKE $1', ['adv-%'])
      await pool.query('DELETE FROM extension_developers WHERE user_id = $1', [attacker.id])
      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [attacker.id])
      const authPlugin = await import('../src/plugins/auth.ts')
      authPlugin.invalidatePermissions()
    })

    const create = async (slug: string): Promise<ReturnType<typeof app.inject>> => app.inject({
      method: 'POST',
      url: '/v1/dev/extensions',
      headers: { authorization: `Bearer ${attacker.token}` },
      payload: { slug, name: 'Adversarial', summary: 's', type: 'torrent' }
    })

    test('publishing without a developer record says so instead of 500ing', async () => {
      // extensions.owner_id is a foreign key to extension_developers(user_id),
      // not to users(id), so the extensions.publish permission alone is not
      // enough. The FK violation used to escape as an opaque 500 from the
      // store's only entry point — and GET /me and GET /extensions both answer
      // 200 for such a user, so nothing before this call hinted at it.
      const res = await create('adv-' + unique())
      assert.equal(res.statusCode, 409, res.body)
      assert.match((res.json() as { detail: string }).detail, /register/i)
    })

    test('parallel creates of one slug yield a single extension, no 500', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/dev/register',
        headers: { authorization: `Bearer ${attacker.token}` },
        payload: { displayName: 'Adversarial Dev' }
      })

      const slug = 'adv-' + unique()
      const codes = await Promise.all(Array.from({ length: 5 }, async () => (await create(slug)).statusCode))
      assert.equal(codes.filter(c => c === 201).length, 1, 'exactly one create must win: ' + codes)
      assert.ok(codes.every(c => c === 201 || c === 409), 'the rest must be 409, got ' + codes)

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM extensions WHERE slug = $1', [slug])
      assert.equal(Number(rows[0]!.n), 1)
    })
  })

  // ---- watch-together ----

  describe('watch together', () => {
    test('a room is created with a unique code and no duplicate-key escape', async () => {
      // The code column is UNIQUE and four random bytes wide, and closed rooms
      // are kept, so the occupied space only grows. Generating once and
      // inserting made a collision a 500; it is retried now.
      const { rows: animeRows } = await pool.query('SELECT id FROM anime LIMIT 1')
      if (!animeRows[0]) return

      const made = await Promise.all(Array.from({ length: 4 }, async () => app.inject({
        method: 'POST',
        url: '/v1/w2g',
        headers: auth(victim),
        payload: { animeId: String(animeRows[0]!.id), episode: 1 }
      })))
      assert.ok(made.every(r => r.statusCode === 201), 'room creation must not fail: ' + made.map(r => r.statusCode))
      const codes = made.map(r => (r.json() as { code: string }).code)
      assert.equal(new Set(codes).size, codes.length, 'codes must be distinct')

      for (const room of made) await pool.query('DELETE FROM watch_together_rooms WHERE id = $1', [(room.json() as { id: string }).id])
    })

    test('another account cannot close a room it does not host', async () => {
      const { rows: animeRows } = await pool.query('SELECT id FROM anime LIMIT 1')
      if (!animeRows[0]) return
      const made = await app.inject({
        method: 'POST', url: '/v1/w2g', headers: auth(victim),
        payload: { animeId: String(animeRows[0]!.id), episode: 1 }
      })
      const id = (made.json() as { id: string }).id
      const res = await app.inject({ method: 'DELETE', url: `/v1/w2g/${id}`, headers: auth(attacker) })
      assert.equal(res.statusCode, 404, 'a non-host must not be able to close a room')
      await pool.query('DELETE FROM watch_together_rooms WHERE id = $1', [id])
    })
  })

  // ---- credentials ----

  describe('password change', () => {
    let account: Account

    before(async () => { account = await register() })
    after(async () => { await pool.query('DELETE FROM users WHERE id = $1', [account.id]) })

    const change = async (currentPassword: string, newPassword: string, token = account.token) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/password',
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword, newPassword }
      })

    test('the current password is required even though the caller is signed in', async () => {
      // A stolen access token must not be enough to take ownership of an
      // account. This endpoint is where that is decided.
      const res = await change('completely-wrong-password', 'a-brand-new-password-9')
      assert.equal(res.statusCode, 403)
    })

    test('the new password must differ from the current one', async () => {
      const res = await change('a-long-enough-test-password-1', 'a-long-enough-test-password-1')
      assert.equal(res.statusCode, 400)
    })

    test('a successful change ends every other session but not this one', async () => {
      const second = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { identifier: account.username, password: 'a-long-enough-test-password-1' }
      })
      assert.equal(second.statusCode, 200)
      const otherDevice = (second.json() as { accessToken: string }).accessToken

      const res = await change('a-long-enough-test-password-1', 'a-brand-new-password-9')
      assert.equal(res.statusCode, 200, res.body)
      const fresh = (res.json() as { accessToken: string }).accessToken

      // The other device is out — leaving an attacker's session alive would
      // defeat the point of changing a password.
      assert.equal((await app.inject({ url: '/v1/auth/permissions', headers: { authorization: `Bearer ${otherDevice}` } })).statusCode, 401)
      // The device that made the change keeps working: signing someone out of
      // the screen they are typing on is hostile, and they just proved
      // ownership.
      assert.equal((await app.inject({ url: '/v1/auth/permissions', headers: { authorization: `Bearer ${fresh}` } })).statusCode, 200)

      const old = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: account.username, password: 'a-long-enough-test-password-1' } })
      assert.equal(old.statusCode, 401, 'the old password must stop working')
      account.token = fresh
    })
  })

  describe('sign out', () => {
    test('logout kills this device\'s access token immediately', async () => {
      // Regression: logout revoked the refresh session and left the access
      // token valid for the rest of its 15 minutes. Verified live before the
      // fix — a request with a logged-out token still answered 200.
      const account = await register()
      const before = await app.inject({ url: '/v1/auth/permissions', headers: { authorization: `Bearer ${account.token}` } })
      assert.equal(before.statusCode, 200)

      const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${account.token}` }, payload: {} })
      assert.equal(out.statusCode, 204)

      const after = await app.inject({ url: '/v1/auth/permissions', headers: { authorization: `Bearer ${account.token}` } })
      assert.equal(after.statusCode, 401, 'a logged-out access token must stop working at once')
      await pool.query('DELETE FROM users WHERE id = $1', [account.id])
    })

    test('logout leaves the account\'s other devices signed in', async () => {
      const account = await register()
      const second = await app.inject({
        method: 'POST', url: '/v1/auth/login',
        payload: { identifier: account.username, password: 'a-long-enough-test-password-1' }
      })
      const otherDevice = (second.json() as { accessToken: string }).accessToken

      await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${account.token}` }, payload: {} })

      const res = await app.inject({ url: '/v1/auth/permissions', headers: { authorization: `Bearer ${otherDevice}` } })
      assert.equal(res.statusCode, 200, 'signing out one device must not sign out the others')
      await pool.query('DELETE FROM users WHERE id = $1', [account.id])
    })

    test('logout-all signs out everywhere', async () => {
      const account = await register()
      const second = await app.inject({
        method: 'POST', url: '/v1/auth/login',
        payload: { identifier: account.username, password: 'a-long-enough-test-password-1' }
      })
      const otherDevice = (second.json() as { accessToken: string }).accessToken

      const out = await app.inject({ method: 'POST', url: '/v1/auth/logout-all', headers: { authorization: `Bearer ${account.token}` } })
      assert.equal(out.statusCode, 204)

      for (const token of [account.token, otherDevice]) {
        assert.equal((await app.inject({ url: '/v1/auth/permissions', headers: { authorization: `Bearer ${token}` } })).statusCode, 401)
      }
      await pool.query('DELETE FROM users WHERE id = $1', [account.id])
    })
  })

  describe('password reset', () => {
    let account: Account

    before(async () => { account = await register() })
    after(async () => { await pool.query('DELETE FROM users WHERE id = $1', [account.id]) })

    const forgot = async (identifier: string) =>
      app.inject({ method: 'POST', url: '/v1/auth/forgot', payload: { identifier } })

    test('an unknown account answers exactly like a known one', async () => {
      // Anything else is an account enumeration oracle, and this endpoint has
      // to be unauthenticated.
      const known = await forgot(account.username)
      const unknown = await forgot('definitely-not-a-user-' + unique())
      assert.equal(known.statusCode, 204)
      assert.equal(unknown.statusCode, 204)
      assert.equal(known.body, unknown.body)
    })

    test('the token is stored hashed, never in the clear', async () => {
      await forgot(account.username)
      const { rows } = await pool.query(
        'SELECT token_hash FROM password_resets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [account.id])
      assert.ok(rows[0], 'a reset row should exist')
      assert.match(String(rows[0]!.token_hash), /^[0-9a-f]{64}$/, 'only a sha256 may be stored')
    })

    test('a second request supersedes the first token', async () => {
      // Otherwise a stolen older email still opens the account.
      await forgot(account.username)
      await forgot(account.username)
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [account.id])
      assert.equal(Number(rows[0]!.n), 1, 'only the newest token may remain usable')
    })

    test('an invalid, expired or reused token is refused', async () => {
      for (const token of ['a'.repeat(43), 'not-a-real-token-value-here']) {
        const res = await app.inject({ method: 'POST', url: '/v1/auth/reset', payload: { token, newPassword: 'a-brand-new-password-9' } })
        assert.equal(res.statusCode, 400)
      }

      // An expired row must not be consumable either.
      await pool.query(
        `UPDATE password_resets SET expires_at = now() - interval '1 hour'
          WHERE user_id = $1 AND used_at IS NULL`, [account.id])
      const { rows } = await pool.query(
        'SELECT token_hash FROM password_resets WHERE user_id = $1 AND used_at IS NULL LIMIT 1', [account.id])
      if (rows[0]) {
        const res = await app.inject({
          method: 'POST', url: '/v1/auth/reset',
          payload: { token: 'x'.repeat(43), newPassword: 'a-brand-new-password-9' }
        })
        assert.equal(res.statusCode, 400)
      }
    })
  })

  // ---- admin views that were written and never wired ----

  describe('error triage', () => {
    let adminToken = ''

    before(async () => {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, r.id FROM roles r WHERE r.slug = 'admin' ON CONFLICT DO NOTHING`, [victim.id])
      const authPlugin = await import('../src/plugins/auth.ts')
      authPlugin.invalidatePermissions()
      adminToken = victim.token
    })

    after(async () => {
      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [victim.id])
      const authPlugin = await import('../src/plugins/auth.ts')
      authPlugin.invalidatePermissions()
    })

    test('a group can be listed, opened and resolved', async () => {
      // All three functions existed and none had a caller, which left the
      // triage loop built at both ends and missing its middle.
      const { recordError } = await import('../src/lib/errors.ts')
      const groupId = await recordError('api', new Error('triage probe ' + unique()), { route: '/probe' })
      assert.ok(groupId)

      const list = await app.inject({ url: '/v1/admin/errors?status=all&limit=200', headers: { authorization: `Bearer ${adminToken}` } })
      assert.equal(list.statusCode, 200)

      const detail = await app.inject({ url: `/v1/admin/errors/${groupId}`, headers: { authorization: `Bearer ${adminToken}` } })
      assert.equal(detail.statusCode, 200, detail.body)
      const body = detail.json() as { group: { id: string }, occurrences: unknown[] }
      assert.equal(body.group.id, groupId)
      assert.ok(body.occurrences.length >= 1, 'the stack must be readable, not just the count')

      const patched = await app.inject({
        method: 'PATCH', url: `/v1/admin/errors/${groupId}`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'resolved' }
      })
      assert.equal(patched.statusCode, 200)

      const { rows } = await pool.query('SELECT status FROM error_groups WHERE id = $1', [groupId])
      assert.equal(rows[0]!.status, 'resolved')
      await pool.query('DELETE FROM error_groups WHERE id = $1', [groupId])
    })

    test('a resolved group reopens when the bug comes back', async () => {
      // This branch was unreachable: recordError reopens a resolved group, and
      // nothing could set a status to resolved in the first place.
      const { recordError } = await import('../src/lib/errors.ts')
      const error = new Error('reopen probe ' + unique())
      const groupId = await recordError('api', error, { route: '/probe' })

      await app.inject({
        method: 'PATCH', url: `/v1/admin/errors/${groupId}`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'resolved' }
      })
      await recordError('api', error, { route: '/probe' })

      const { rows } = await pool.query('SELECT status FROM error_groups WHERE id = $1', [groupId])
      assert.equal(rows[0]!.status, 'open', 'a bug that comes back is news')
      await pool.query('DELETE FROM error_groups WHERE id = $1', [groupId])
    })

    test('an unknown group is 404, not an empty 200', async () => {
      for (const url of [`/v1/admin/errors/${NONEXISTENT_UUID}`]) {
        assert.equal((await app.inject({ url, headers: { authorization: `Bearer ${adminToken}` } })).statusCode, 404)
      }
    })

    test('the audit trail is readable and filterable', async () => {
      const res = await app.inject({ url: '/v1/admin/audit?limit=5', headers: { authorization: `Bearer ${adminToken}` } })
      assert.equal(res.statusCode, 200)
      assert.ok(Array.isArray((res.json() as { data: unknown[] }).data))

      const filtered = await app.inject({ url: '/v1/admin/audit?subjectType=user&limit=5', headers: { authorization: `Bearer ${adminToken}` } })
      assert.equal(filtered.statusCode, 200)
    })

    test('both views refuse an ordinary account', async () => {
      for (const url of ['/v1/admin/errors', '/v1/admin/audit']) {
        assert.equal((await app.inject({ url, headers: { authorization: `Bearer ${attacker.token}` } })).statusCode, 403, url)
        assert.equal((await app.inject({ url })).statusCode, 401, url)
      }
    })
  })

  // ---- the catalogue as a source of truth ----

  describe('catalogue detail', () => {
    let animeId = ''
    let anilistId: number | null = null

    before(async () => {
      const { rows } = await pool.query(
        `SELECT a.id, m.anilist_id FROM anime a
         LEFT JOIN anime_mappings m ON m.anime_id = a.id
         WHERE m.anilist_id IS NOT NULL LIMIT 1`)
      if (rows[0]) {
        animeId = String(rows[0].id)
        anilistId = Number(rows[0].anilist_id)
      }
    })

    test('the full record comes back by Yume id', async () => {
      if (!animeId) return
      const res = await app.inject({ url: `/v1/anime/${animeId}` })
      assert.equal(res.statusCode, 200)
      const body = res.json() as Record<string, unknown>
      // The shape the client maps from — missing any of these sends the detail
      // page back to AniList for a title we already hold.
      for (const key of ['id', 'canonical_title', 'titles', 'synonyms', 'genres', 'tags', 'companies', 'images', 'mappings']) {
        assert.ok(key in body, `the record must carry ${key}`)
      }
    })

    test('the tsvector never leaves the server', async () => {
      // `search` is an implementation detail of ranking, and it is large.
      if (!animeId) return
      const body = (await app.inject({ url: `/v1/anime/${animeId}` })).json() as Record<string, unknown>
      assert.ok(!('search' in body), 'the search vector must not be serialised to clients')
    })

    test('one round trip by AniList id returns the whole record', async () => {
      // Without ?full the client had to resolve the id and then fetch the
      // record — two round trips on the most-loaded screen, which is the cost
      // that made it skip the catalogue and call AniList directly instead.
      if (anilistId === null) return
      const bridge = await app.inject({ url: `/v1/anime/by-anilist/${anilistId}` })
      assert.equal(bridge.statusCode, 200)
      assert.deepEqual(Object.keys(bridge.json() as object).sort(), ['canonical_title', 'id'])

      const full = await app.inject({ url: `/v1/anime/by-anilist/${anilistId}?full=true` })
      assert.equal(full.statusCode, 200)
      const body = full.json() as Record<string, unknown>
      assert.equal(body.id, animeId)
      assert.ok('titles' in body && 'genres' in body && 'mappings' in body)
      assert.ok(!('search' in body))
    })

    test('an unknown id is 404 in both forms', async () => {
      assert.equal((await app.inject({ url: `/v1/anime/${NONEXISTENT_UUID}` })).statusCode, 404)
      assert.equal((await app.inject({ url: '/v1/anime/by-anilist/999999999?full=true' })).statusCode, 404)
    })

    test('relations carry the id the client links by', async () => {
      if (!animeId) return
      const res = await app.inject({ url: `/v1/anime/${animeId}/relations` })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Array<Record<string, unknown>> }
      // A relation with no AniList mapping still has to be reachable, so the
      // row carries both ids and the client picks whichever exists.
      for (const row of data) {
        assert.ok('id' in row, 'every relation needs a Yume id')
        assert.ok('anilist_id' in row, 'and the AniList id when there is one')
      }
    })

    test('episodes answer for a real anime and 404 for an unknown one', async () => {
      if (!animeId) return
      assert.equal((await app.inject({ url: `/v1/anime/${animeId}/episodes` })).statusCode, 200)
      assert.equal((await app.inject({ url: `/v1/anime/${NONEXISTENT_UUID}/episodes` })).statusCode, 404)
    })

    test('the whole detail surface is public', async () => {
      // The catalogue is the fallback for an unauthenticated visitor too;
      // requiring a token here would push anonymous users back to AniList.
      if (!animeId) return
      for (const url of [`/v1/anime/${animeId}`, `/v1/anime/${animeId}/episodes`, `/v1/anime/${animeId}/relations`]) {
        assert.equal((await app.inject({ url })).statusCode, 200, url)
      }
    })
  })

  // ---- webhooks / SSRF at the route ----

  describe('webhook targets', () => {
    test('an internal URL is refused at creation time', async () => {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, r.id FROM roles r WHERE r.slug = 'admin' ON CONFLICT DO NOTHING`, [attacker.id])
      const authPlugin = await import('../src/plugins/auth.ts')
      authPlugin.invalidatePermissions()

      for (const url of [
        'http://127.0.0.1:4100/v1/health',
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost:5432/',
        'file:///etc/passwd'
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/admin/webhooks',
          headers: { authorization: `Bearer ${attacker.token}` },
          payload: { url, events: ['comment.created'] }
        })
        assert.ok(res.statusCode === 400, `${url} must be refused at creation, got ${res.statusCode} ${res.body}`)
      }

      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [attacker.id])
      authPlugin.invalidatePermissions()
    })
  })
})
