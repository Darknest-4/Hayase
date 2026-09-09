// Profile pictures and banners come from the catalogue, not from the client.
//
// The rule this suite exists to hold: the client sends a *title*, and the
// server looks the picture up. A client that could post its own image address
// would turn every profile into an arbitrary remote request made by everybody
// who loads a page with that person's name on it — a tracking pixel with a
// username attached. So the body carries a uuid, the URL is resolved here from
// anime_images, and a request that tries to set the key directly changes
// nothing.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'artwork-test-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '50'
process.env.RATE_LIMIT_MAX ??= '5000'
process.env.WRITE_RATE_LIMIT_MAX ??= '500'

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

interface Profile {
  avatar_key: string | null
  banner_key: string | null
  avatar_anime_id: string | null
  banner_anime_id: string | null
  avatar_from: string | null
  banner_from: string | null
}

interface Tile { id: string, title: string, image: string }

describe('profile artwork', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let username = ''
  let auth: Record<string, string> = {}
  let cover: Tile

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    username = 'art_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    auth = { authorization: `Bearer ${(res.json() as { accessToken: string }).accessToken}` }
  })

  after(async () => {
    if (username) await pool?.query('DELETE FROM users WHERE username = $1', [username])
    await app?.close()
    await pool?.end()
  })

  const me = async (): Promise<Profile> => {
    const res = await app.inject({ url: '/v1/profiles/me', headers: auth })
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as Profile
  }

  // ---- the grid ----

  test('the grid needs an account', async () => {
    const res = await app.inject({ url: '/v1/profiles/artwork' })
    assert.equal(res.statusCode, 401)
  })

  test('an empty library still gets a grid to look at', async () => {
    const res = await app.inject({ url: '/v1/profiles/artwork', headers: auth })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { data: Tile[], source: string }
    // Nothing watched yet, so the popular fallback is what should answer.
    assert.equal(body.source, 'popular')
    assert.ok(body.data.length > 0, 'the picker would open on an empty screen')
    cover = body.data[0]!
  })

  test('every tile has a picture, so nothing can be picked and then not appear', async () => {
    const res = await app.inject({ url: '/v1/profiles/artwork?limit=20', headers: auth })
    const { data } = res.json() as { data: Tile[] }
    assert.ok(data.length <= 20)
    for (const tile of data) {
      assert.ok(tile.image, `${tile.title} came back without an image`)
      assert.ok(tile.title, `${tile.id} came back without a title`)
    }
  })

  test('a query searches the catalogue rather than the library', async () => {
    const res = await app.inject({ url: '/v1/profiles/artwork?q=piece', headers: auth })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { data: Tile[], source: string }
    assert.equal(body.source, 'search')
  })

  test('banners fall back to the cover, because banner art is still filling in', async () => {
    const res = await app.inject({ url: '/v1/profiles/artwork?kind=banner&limit=5', headers: auth })
    assert.equal(res.statusCode, 200, res.body)
    const { data } = res.json() as { data: Tile[] }
    assert.ok(data.length > 0, 'an empty banner grid means the fallback is not working')
  })

  test('the limit is capped', async () => {
    const res = await app.inject({ url: '/v1/profiles/artwork?limit=500', headers: auth })
    assert.equal(res.statusCode, 400)
  })

  // ---- choosing ----

  test('choosing a title stores the picture and where it came from', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/profiles/me', headers: auth, payload: { avatarAnimeId: cover.id }
    })
    assert.equal(res.statusCode, 200, res.body)
    const profile = res.json() as Profile
    assert.equal(profile.avatar_anime_id, cover.id)
    assert.equal(profile.avatar_from, cover.title)

    // The stored URL is the catalogue's, not anything the caller chose.
    const { rows } = await pool.query(
      "SELECT object_key FROM anime_images WHERE anime_id = $1 AND kind = 'cover' ORDER BY is_primary DESC LIMIT 1",
      [cover.id]
    )
    assert.equal(profile.avatar_key, rows[0]!.object_key)
  })

  test('a banner is a separate choice from a picture', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/profiles/me', headers: auth, payload: { bannerAnimeId: cover.id }
    })
    assert.equal(res.statusCode, 200, res.body)
    const profile = res.json() as Profile
    assert.equal(profile.banner_anime_id, cover.id)
    assert.equal(profile.avatar_anime_id, cover.id, 'setting one must not clear the other')
  })

  test('a title with no artwork is refused rather than stored empty', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/profiles/me',
      headers: auth,
      payload: { avatarAnimeId: '00000000-0000-4000-8000-000000000000' }
    })
    assert.equal(res.statusCode, 404)
    assert.match((res.json() as { detail: string }).detail, /cover/)
    // and the profile is untouched
    assert.equal((await me()).avatar_anime_id, cover.id)
  })

  test('something that is not a uuid is refused', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/profiles/me', headers: auth, payload: { avatarAnimeId: 'not-a-title' }
    })
    assert.equal(res.statusCode, 400)
  })

  test('a client cannot set the image address itself', async () => {
    const before = await me()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/profiles/me',
      headers: auth,
      payload: { avatarKey: 'https://tracker.invalid/pixel.png', bannerKey: 'https://tracker.invalid/wide.png' }
    })
    // Whether the extra properties are stripped or the body is rejected is the
    // schema's business; what matters is that the address never lands.
    assert.ok(res.statusCode === 200 || res.statusCode === 400, res.body)
    const after = await me()
    assert.equal(after.avatar_key, before.avatar_key)
    assert.equal(after.banner_key, before.banner_key)
  })

  test('clearing takes the title away with the picture', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/profiles/me', headers: auth, payload: { avatarAnimeId: null }
    })
    assert.equal(res.statusCode, 200, res.body)
    const profile = res.json() as Profile
    assert.equal(profile.avatar_key, null)
    assert.equal(profile.avatar_anime_id, null)
    assert.equal(profile.avatar_from, null)
    // The banner is a separate choice and stays.
    assert.ok(profile.banner_key)
  })

  test('the name and the picture can be edited in one request', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/profiles/me',
      headers: auth,
      payload: { displayName: 'Álomlátó', avatarAnimeId: cover.id }
    })
    assert.equal(res.statusCode, 200, res.body)
    const profile = res.json() as Profile & { display_name: string }
    assert.equal(profile.display_name, 'Álomlátó')
    assert.ok(profile.avatar_key)
  })
})
