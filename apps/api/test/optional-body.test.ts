// A hiányzó törzs nem hiba ott, ahol semmi sem kötelező benne.
//
// EZ EGY BIZTONSÁGI HIBÁBÓL NŐTT KI. A `POST /v1/auth/logout` sémája törzset
// követelt, noha egyetlen mezője sem volt kötelező, és a kezelő maga `?? {}`
// -val számolt a hiányára. Egy törzs nélküli kijelentkezés ezért 400-at kapott
// („body must be object"), a munkamenet NEM lett visszavonva, és a hozzáférési
// token további tizenöt percig működött. A böngészőkliens csak azért kerülte
// el, mert mindig küld `{}`-t — a `navigator.sendBeacon` lapbezáráskor nem, a
// `curl` nem, és egy mobilkliens sem köteles.
//
// A javítás nem az útvonalon van, hanem egy `preValidation` szabályban
// (`app.ts`): ha a séma egyetlen mezőt sem követel, a hiányzó törzs `{}`.
// Ezért ez a fájl a SZABÁLYT méri, két irányban:
//
//   * ahol nincs `required`, a törzs nélküli hívás úgy viselkedik, mint a `{}`;
//   * ahol VAN `required`, a hiányzó törzs továbbra is 400 — a hiányzó jelszó
//     hiányzó jelszó marad, nem csendes üres objektum.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'optional-body-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('a hiányzó törzs ott mehet, ahol semmi sem kötelező', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []

  async function account (): Promise<{ token: string, profileId: string }> {
    const username = 'ob_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    const token = (res.json() as { accessToken: string }).accessToken
    const me = await app.inject({ url: '/v1/profiles/me', headers: { authorization: `Bearer ${token}` } })
    return { token, profileId: (me.json() as { id: string }).id }
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
  })

  after(async () => {
    try {
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  /*
   * A hiba maga: kijelentkezés törzs nélkül.
   *
   * Nem a státuszkód a lényeg, hanem hogy a TOKEN MEGHAL. Egy 204-et vissza
   * lehetne adni úgy is, hogy közben semmi nem történik — az állítás ezért a
   * kijelentkezés utáni kérésre vonatkozik.
   */
  test('a törzs nélküli kijelentkezés tényleg kijelentkeztet', async () => {
    const { token } = await account()

    const out = await app.inject({
      method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${token}` }
    })
    assert.equal(out.statusCode, 204, out.body)

    const after = await app.inject({
      url: '/v1/auth/permissions', headers: { authorization: `Bearer ${token}` }
    })
    assert.equal(after.statusCode, 401,
      'a kijelentkezés után a hozzáférési tokennek halottnak kell lennie')
  })

  test('a `{}` törzzsel küldött kijelentkezés ugyanaz', async () => {
    const { token } = await account()
    const out = await app.inject({
      method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${token}` }, payload: {}
    })
    assert.equal(out.statusCode, 204, out.body)
    const after = await app.inject({
      url: '/v1/auth/permissions', headers: { authorization: `Bearer ${token}` }
    })
    assert.equal(after.statusCode, 401)
  })

  /*
   * A szabály többi használója. Mindegyik olyan útvonal, aminek a sémája
   * egyetlen mezőt sem követel — tehát a törzs nélküli hívás értelmes kérés,
   * nem hiányos.
   */
  test('a többi „minden mező opcionális" útvonal sem kér törzset', async () => {
    const { token, profileId } = await account()
    const headers = { authorization: `Bearer ${token}`, 'x-profile-id': profileId }

    for (const [method, url] of [
      ['POST', '/v1/me/notifications/read'],
      ['PATCH', '/v1/profiles/me']
    ] as const) {
      const res = await app.inject({ method, url, headers })
      assert.notEqual(res.statusCode, 400,
        `${method} ${url} törzs nélkül 400-at adott: ${res.body}`)
    }
  })

  /*
   * A MÁSIK IRÁNY, és ez a fontosabbik.
   *
   * A szabály engedékeny — ezért meg kell mutatni, hol NEM az. Ha a hiányzó
   * törzs mindenhol `{}` lenne, egy jelszó nélküli belépési kísérlet a
   * jelszóellenőrzésig jutna el, egy név nélküli regisztráció a beszúrásig. A
   * `required` a határ, és ez az állítás őrzi.
   */
  test('ahol van kötelező mező, a hiányzó törzs továbbra is 400', async () => {
    for (const url of ['/v1/auth/login', '/v1/auth/register', '/v1/auth/forgot', '/v1/auth/reset']) {
      const res = await app.inject({ method: 'POST', url })
      assert.equal(res.statusCode, 400,
        `${url} törzs nélkül nem 400-at adott, hanem ${res.statusCode}: ${res.body}`)
    }
  })
})
