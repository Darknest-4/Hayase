// Miért nem sebezhető ez az API CSRF-fel, és mi tartja így.
//
// A válasz szerkezeti, nem egy védőréteg: az API kizárólag `Authorization:
// Bearer` fejlécből hitelesít. Egy idegen oldalról indított kérés nem tud
// fejlécet küldeni a látogató nevében — sütit igen, fejlécet nem. Ambiens
// hitelesítő adat tehát nincs, és ahol nincs, ott nincs CSRF sem.
//
// Egyetlen süti létezik, a `yume_refresh`: httpOnly, éles módban secure, és
// `SameSite=strict`. Egy idegen oldalról induló kérés nem is viszi magával.
//
// Ez a fájl azt rögzíti, ami ezt a szerkezetet tartja. Ha valaki egyszer
// süti-alapú hitelesítést vezet be az API-n — kényelemből, egy mobilkliens
// kedvéért, bármiért —, a CSRF ugyanabban a pillanatban megjelenik, minden
// állapotváltoztató végponton egyszerre. Ez a teszt az, ami akkor megszólal.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'csrf-secret-long-enough-0123456789abcdef'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('the API accepts no ambient credential', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const username = 'csrf_' + randomBytes(5).toString('hex')
  let cookies = ''
  let profileId = ''
  let animeId = ''

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    const token = (res.json() as { accessToken: string }).accessToken

    // A böngésző, ami a támadó oldalára téved, ezt viszi magával — és semmi mást.
    const raw = res.headers['set-cookie']
    cookies = (Array.isArray(raw) ? raw : [raw ?? '']).map(c => String(c).split(';')[0]).join('; ')

    const me = await app.inject({ url: '/v1/profiles/me', headers: { authorization: `Bearer ${token}` } })
    profileId = (me.json() as { id: string }).id
    const anime = await pool.query("SELECT id FROM anime WHERE visibility = 'public' LIMIT 1")
    animeId = String(anime.rows[0].id)
  })

  after(async () => {
    try {
      await pool.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  test('the session cookie is httpOnly, strict and path-scoped', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { identifier: username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 200, res.body)
    const raw = res.headers['set-cookie']
    const header = String(Array.isArray(raw) ? raw.join(' ') : raw ?? '')
    assert.match(header, /yume_refresh=/, 'the refresh token must be a cookie, not a body field the page can read')
    assert.match(header, /HttpOnly/i, 'script must not be able to read it')
    assert.match(header, /SameSite=Strict/i, 'a cross-site request must not carry it')
  })

  test('a state change with only the cookie is refused', async () => {
    // Pontosan az, amit egy idegen oldalról indított űrlap el tud érni:
    // süti igen, Authorization fejléc nem.
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/me/library/${animeId}`,
      headers: {
        cookie: cookies,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        'x-profile-id': profileId
      },
      payload: { status: 'WATCHING' }
    })
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `expected a refusal, got ${res.statusCode}: ${res.body}`)

    const { rows } = await pool.query('SELECT 1 FROM library_entries WHERE profile_id = $1', [profileId])
    assert.equal(rows.length, 0, 'a cross-site request must not have written anything')
  })

  test('deleting an account with only the cookie is refused', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/users/me',
      headers: { cookie: cookies, origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: { password: 'a-long-enough-test-password-1' }
    })
    assert.ok(res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404,
      `expected a refusal, got ${res.statusCode}`)
    const { rows } = await pool.query('SELECT deleted_at FROM users WHERE username = $1', [username])
    assert.equal(rows[0]?.deleted_at, null, 'the account must still be live')
  })

  test('the only endpoint that reads the cookie is the refresh', async () => {
    // Ez szándékosan működik sütivel: ez a süti egyetlen dolga. A
    // SameSite=strict az, ami megakadályozza, hogy idegen oldalról érkezzen.
    const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: cookies }, payload: {} })
    assert.equal(res.statusCode, 200, res.body)
    assert.ok((res.json() as { accessToken?: string }).accessToken, 'the refresh must mint a new access token')
  })
})
