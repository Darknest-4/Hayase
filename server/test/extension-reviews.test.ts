// Store reviews, end to end.
//
// `extension_reviews` sat empty for the whole life of the store and
// `extensions.rating_avg` was a column nothing wrote, so every card showed a
// blank rating. The rules worth holding still are the ones that decide whether
// that number means anything: only an account that installed the thing can
// rate it, one review per account, and the average is recomputed from the
// reviews that are actually readable — not adjusted incrementally.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'integration-test-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'
process.env.RATE_LIMIT_MAX ??= '5000'

let app: FastifyInstance
let pool: {
  end: () => Promise<void>
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

const unique = (): string => randomBytes(6).toString('hex')

describe('extension reviews', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  const slug = 'itest-review-' + unique()
  const users: string[] = []
  let extensionId = ''
  let versionId = ''

  /** A registered account and its access token. */
  const account = async (): Promise<{ username: string, token: string, id: string }> => {
    const username = 'irev_' + unique()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, 'registration should succeed: ' + res.body)
    users.push(username)
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    return { username, token: (res.json() as { accessToken: string }).accessToken, id: String(rows[0]!.id) }
  }

  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    // A store listing of our own, so the test never depends on which
    // first-party extensions happen to be published in this database.
    const owner = await account()
    await pool.query(
      `INSERT INTO extension_developers (user_id, display_name, verified) VALUES ($1, 'itest', false)
       ON CONFLICT (user_id) DO NOTHING`, [owner.id])
    const { rows: ext } = await pool.query(
      `INSERT INTO extensions (slug, owner_id, name, summary, type, status)
       VALUES ($1, $2, 'Review test', 'fixture', 'metadata', 'published') RETURNING id`,
      [slug, owner.id])
    extensionId = String(ext[0]!.id)
    const { rows: version } = await pool.query(
      `INSERT INTO extension_versions
         (extension_id, version, package_key, package_hash, package_size, manifest, review_status, published_at)
       VALUES ($1, '1.0.0', $2, $2, 10, '{}'::jsonb, 'approved', now()) RETURNING id`,
      [extensionId, 'f'.repeat(64)])
    versionId = String(version[0]!.id)
  })

  after(async () => {
    // The extension cascades to its versions, installs and reviews.
    await pool.query('DELETE FROM extensions WHERE id = $1', [extensionId])
    await pool.query('DELETE FROM users WHERE username = ANY($1)', [users])
    await app?.close()
    await pool?.end()
  })

  test('an account that has not installed it cannot review it', async () => {
    // The rating answers "does this work", which is a question only somebody
    // who ran it can answer.
    const user = await account()
    const res = await app.inject({
      method: 'PUT', url: `/v1/extensions/${slug}/reviews`, headers: auth(user.token), payload: { rating: 5 }
    })
    assert.equal(res.statusCode, 403, res.body)
  })

  test('a review moves the listing rating, and a second one is a replacement', async () => {
    const user = await account()
    // 201 for a fresh install, 200 when the row already exists.
    assert.ok([200, 201].includes((await app.inject({
      method: 'POST', url: `/v1/extensions/${slug}/install`, headers: auth(user.token)
    })).statusCode))

    const first = await app.inject({
      method: 'PUT',
      url: `/v1/extensions/${slug}/reviews`,
      headers: auth(user.token),
      payload: { rating: 4, body: 'works' }
    })
    assert.equal(first.statusCode, 200, first.body)

    let listing = await pool.query('SELECT rating_avg, rating_count FROM extensions WHERE id = $1', [extensionId])
    assert.equal(Number(listing.rows[0]!.rating_avg), 4)
    assert.equal(Number(listing.rows[0]!.rating_count), 1)

    // A rating is a current opinion, not a history of them.
    const second = await app.inject({
      method: 'PUT', url: `/v1/extensions/${slug}/reviews`, headers: auth(user.token), payload: { rating: 2 }
    })
    assert.equal(second.statusCode, 200, second.body)
    assert.equal((second.json() as { id: string }).id, (first.json() as { id: string }).id, 'the same review row')

    listing = await pool.query('SELECT rating_avg, rating_count FROM extensions WHERE id = $1', [extensionId])
    assert.equal(Number(listing.rows[0]!.rating_avg), 2, 'the replacement must move the average')
    assert.equal(Number(listing.rows[0]!.rating_count), 1, 'and must not add a second review')

    // The version the review was written against is recorded, so a rating for
    // a build from a year ago can be told apart from one for today's.
    const { rows } = await pool.query('SELECT version_id FROM extension_reviews WHERE extension_id = $1', [extensionId])
    assert.equal(String(rows[0]!.version_id), versionId)

    assert.equal((await app.inject({
      method: 'DELETE', url: `/v1/extensions/${slug}/reviews`, headers: auth(user.token)
    })).statusCode, 204)
    listing = await pool.query('SELECT rating_avg, rating_count FROM extensions WHERE id = $1', [extensionId])
    assert.equal(Number(listing.rows[0]!.rating_count), 0)
    assert.equal(listing.rows[0]!.rating_avg, null, 'no reviews means no average, not zero')
  })

  test('the list is public and only tells the caller which review is theirs', async () => {
    const user = await account()
    await app.inject({ method: 'POST', url: `/v1/extensions/${slug}/install`, headers: auth(user.token) })
    await app.inject({
      method: 'PUT', url: `/v1/extensions/${slug}/reviews`, headers: auth(user.token), payload: { rating: 5, body: 'good' }
    })

    const anonymous = await app.inject({ url: `/v1/extensions/${slug}/reviews` })
    assert.equal(anonymous.statusCode, 200, 'the list is public')
    const anon = anonymous.json() as { data: Array<{ author: string }>, mine: unknown }
    assert.equal(anon.data.length, 1)
    assert.equal(anon.data[0]!.author, user.username)
    assert.equal(anon.mine, null, 'an anonymous caller has no review of their own')

    const mine = (await app.inject({ url: `/v1/extensions/${slug}/reviews`, headers: auth(user.token) }))
      .json() as { mine: { rating: number } | null }
    assert.equal(mine.mine?.rating, 5)

    // A token the server cannot read is an anonymous request, not an error:
    // the list is public either way.
    const broken = await app.inject({ url: `/v1/extensions/${slug}/reviews`, headers: { authorization: 'Bearer not-a-jwt' } })
    assert.equal(broken.statusCode, 200)
    assert.equal((broken.json() as { mine: unknown }).mine, null)
  })

  test('a hidden review leaves both the list and the average', async () => {
    // Moderation that removes the text but leaves the score behind would let a
    // brigade keep the damage it came for.
    const { rows } = await pool.query(
      'SELECT id FROM extension_reviews WHERE extension_id = $1 LIMIT 1', [extensionId])
    const reviewId = String(rows[0]!.id)

    const moderator = await account()
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, r.id FROM roles r WHERE r.slug = 'admin' ON CONFLICT DO NOTHING`, [moderator.id])
    const authPlugin = await import('../src/plugins/auth.ts')
    authPlugin.invalidatePermissions()

    const reporter = await account()
    const report = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: auth(reporter.token),
      payload: { subjectType: 'extension_review', subjectId: reviewId, reason: 'spam' }
    })
    assert.equal(report.statusCode, 201, 'an extension review must be reportable: ' + report.body)

    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/admin/reports/${(report.json() as { id: string }).id}/resolve`,
      headers: auth(moderator.token),
      payload: { action: 'hide', reason: 'test' }
    })
    assert.equal(resolved.statusCode, 200, resolved.body)

    const listing = await pool.query('SELECT rating_avg, rating_count FROM extensions WHERE id = $1', [extensionId])
    assert.equal(Number(listing.rows[0]!.rating_count), 0, 'a hidden review no longer counts')

    const list = (await app.inject({ url: `/v1/extensions/${slug}/reviews` })).json() as { data: unknown[] }
    assert.equal(list.data.length, 0, 'a hidden review is not shown at all')
  })

  test('a rating outside 1..5 is refused by the schema, not stored', async () => {
    const user = await account()
    await app.inject({ method: 'POST', url: `/v1/extensions/${slug}/install`, headers: auth(user.token) })
    for (const rating of [0, 6, 4.5]) {
      const res = await app.inject({
        method: 'PUT', url: `/v1/extensions/${slug}/reviews`, headers: auth(user.token), payload: { rating }
      })
      assert.equal(res.statusCode, 400, `rating ${rating} must be refused`)
    }
  })
})
