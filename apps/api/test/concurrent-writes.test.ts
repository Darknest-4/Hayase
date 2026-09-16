// Ugyanaz a kérés kétszer, egyszerre.
//
// Ez a suite egy HIBAFAJTÁT őriz, nem egy végpontot. A YUME-ban eddig három
// hiba tartozott ide, és mind ugyanúgy nézett ki: olvasás, döntés, írás — zár
// nélkül, és két kérés között. Egyenként ártalmatlannak látszik, együtt nem:
//
//   * a frissítő token forgatása — négy párhuzamos 401 négy frissítést
//     indított, az egyik nyert, a többi kijelentkeztette a felhasználót
//     (lásd tests/e2e/session-refresh.test.mjs);
//   * a tiltás — kétszer kiadva két élő sort hagyott, a feloldás egyet
//     oldott fel (lásd ban-identity.test.ts);
//   * a jelszóváltás — az alábbi.
//
// A duplán megnyomott gomb nem különleges eset. Egy lassú hálózaton ez a
// NORMÁLIS viselkedés, és egy felhasználó soha nem fogja hibaüzenetből
// megérteni, mi történt vele.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'concurrent-secret-long-enough-0123456789ab'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'
process.env.RATE_LIMIT_MAX ??= '100000'

describe('egyszerre érkező, azonos írások', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  const PASSWORD = 'a-long-enough-test-password-1'

  async function account (): Promise<{ username: string, token: string, profileId: string }> {
    const username = 'cw_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: PASSWORD }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    const token = (res.json() as { accessToken: string }).accessToken
    const me = await app.inject({ url: '/v1/profiles/me', headers: { authorization: `Bearer ${token}` } })
    return { username, token, profileId: (me.json() as { id: string }).id }
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
   * A JELSZÓVÁLTÁS VERSENYE.
   *
   * A kezelő kiolvasta a tárolt kivonatot, ellenőrizte rá a beküldött mostani
   * jelszót, majd írt — három lépés, zár nélkül. Három párhuzamos változtatás
   * mind a három ellenőrzése átment, mind a három írt, és az utolsó nyert:
   * mérve 200/200/200.
   *
   * Amiért ez több a rendetlenségnél: aki ismeri a RÉGI jelszót — pontosan az,
   * aki ellen a jelszóváltás szól — az írása a tulajdonosé UTÁN landolhat, és
   * a fiók az ő jelszavára áll be, noha addigra a régi már nem volt érvényes.
   *
   * A javítás után az írás a kiolvasott kivonatra hivatkozik: aki lemaradt,
   * 409-et kap, mert amire ellenőrzött, az már nincs ott.
   */
  test('három párhuzamos jelszóváltásból pontosan egy nyer', async () => {
    const { username, token } = await account()

    const results = await Promise.all([1, 2, 3].map(i => app.inject({
      method: 'POST', url: '/v1/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: PASSWORD, newPassword: `uj-hosszu-jelszo-${i}-abcdef` }
    })))

    const winners = results.filter(r => r.statusCode < 400)
    assert.equal(winners.length, 1,
      `${winners.length} jelszóváltás sikerült: ${results.map(r => r.statusCode).join('/')}`)

    const losers = results.filter(r => r.statusCode >= 400)
    for (const loser of losers) {
      assert.equal(loser.statusCode, 409,
        `a lemaradó kérésnek 409-et kell kapnia, nem ${loser.statusCode}: ${loser.body}`)
    }

    // És a fiókon tényleg a nyertes jelszava van. Ez a lényeg: nem az, hogy a
    // kérések közül hány kapott hibát, hanem hogy mi lett a végállapot.
    const index = results.findIndex(r => r.statusCode < 400) + 1
    const good = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { identifier: username, password: `uj-hosszu-jelszo-${index}-abcdef` }
    })
    assert.equal(good.statusCode, 200, 'a nyertes jelszavával be kell lehessen lépni')

    for (const other of [1, 2, 3].filter(i => i !== index)) {
      const bad = await app.inject({
        method: 'POST', url: '/v1/auth/login',
        payload: { identifier: username, password: `uj-hosszu-jelszo-${other}-abcdef` }
      })
      assert.ok(bad.statusCode >= 400, `a lemaradó ${other}. jelszavával nem szabad belépni`)
    }
  })

  /*
   * A NORMÁL ESET, mert egy versenyjavítás könnyen elrontja azt is. Két
   * egymás UTÁN végzett változtatásnak működnie kell — az összehasonlítás
   * mindkétszer a friss kivonatra megy.
   */
  test('a sorban végzett két jelszóváltás továbbra is megy', async () => {
    const { username, token } = await account()

    const first = await app.inject({
      method: 'POST', url: '/v1/auth/password', headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: PASSWORD, newPassword: 'elso-uj-hosszu-jelszo-12' }
    })
    assert.equal(first.statusCode, 200, first.body)

    const second = await app.inject({
      method: 'POST', url: '/v1/auth/password',
      headers: { authorization: `Bearer ${(first.json() as { accessToken: string }).accessToken}` },
      payload: { currentPassword: 'elso-uj-hosszu-jelszo-12', newPassword: 'masodik-uj-hosszu-jelszo-34' }
    })
    assert.equal(second.statusCode, 200, second.body)

    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { identifier: username, password: 'masodik-uj-hosszu-jelszo-34' }
    })
    assert.equal(login.statusCode, 200, 'a legutóbbi jelszóval be kell lehessen lépni')
  })

  /** Két egyforma regisztráció: egy fiók, egy tiszta elutasítás — nem 500. */
  test('két egyforma regisztrációból egy fiók lesz', async () => {
    const username = 'cw_' + randomBytes(5).toString('hex')
    usernames.push(username)
    const payload = { email: `${username}@test.invalid`, username, password: PASSWORD }

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/auth/register', payload }),
      app.inject({ method: 'POST', url: '/v1/auth/register', payload })
    ])
    const codes = [a.statusCode, b.statusCode].sort()
    assert.deepEqual(codes, [201, 409], `${a.statusCode}/${b.statusCode}: ${a.body} | ${b.body}`)

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE username = $1', [username])
    assert.equal(Number(rows[0].n), 1)
  })

  /** A duplán megnyomott „könyvtárba" gomb egy sort hagy, nem kettőt. */
  test('a kétszer beküldött könyvtárba tétel egy sort hagy', async () => {
    const { token, profileId } = await account()
    const { rows } = await pool.query("SELECT id FROM anime WHERE visibility = 'public' LIMIT 1")
    const animeId = String(rows[0].id)
    const headers = { authorization: `Bearer ${token}`, 'x-profile-id': profileId }

    const both = await Promise.all([1, 2].map(() => app.inject({
      method: 'PUT', url: `/v1/me/library/${animeId}`, headers, payload: { status: 'WATCHING' }
    })))
    assert.ok(both.every(r => r.statusCode < 400), both.map(r => `${r.statusCode} ${r.body}`).join(' | '))

    const count = await pool.query(
      'SELECT count(*)::int AS n FROM library_entries WHERE profile_id = $1 AND anime_id = $2',
      [profileId, animeId])
    assert.equal(Number(count.rows[0].n), 1)
  })
})
