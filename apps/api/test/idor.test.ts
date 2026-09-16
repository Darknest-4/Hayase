// Idegen sorba írni annyi, mint idegen sorba írni.
//
// A tárgyszintű hozzáférés az a hibafajta, amit a jogosultságrendszer nem fog
// meg: a hívónak *van* joga hírt elvetni, könyvtárat olvasni, beállítást írni
// — csak nem azén.
//
// Ez a suite azt a mintát vizsgálja, ami itt elromlott: az `X-Profile-Id`
// fejlécet. A helyes, tulajdonost ellenőrző feloldó három helyen létezett
// (könyvtár, beállítások, GraphQL), egy negyediken pedig nem — a hírek
// útvonalán. Egy bejelentkezett látogató bármelyik ismert profil nevében
// elvethetett egy hírt, és megtudhatta, hogy más elvetette-e.
//
// A megismételt védelem az a védelem, amiből egy példány hiányozni fog. A
// feloldó most egy helyen van, és ez a fájl minden használóján végigmegy.
//
// A szerződés szándékosan szigorú:
//
//   nincs fejléc      400
//   idegen profil     403 — elutasítás, nem néma kiszolgálás
//   saját profil      a művelet

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'idor-secret-long-enough-0123456789abcdef'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('one account cannot act as another', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  let A: { token: string, profileId: string, userId: string }
  let B: { token: string, profileId: string, userId: string }
  let animeId = ''
  let announcementId = ''

  async function account (): Promise<{ token: string, profileId: string, userId: string }> {
    const username = 'idor_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    const token = (res.json() as { accessToken: string }).accessToken
    const me = await app.inject({ url: '/v1/profiles/me', headers: { authorization: `Bearer ${token}` } })
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    return { token, profileId: (me.json() as { id: string }).id, userId: String(rows[0].id) }
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
    A = await account()
    B = await account()

    const anime = await pool.query("SELECT id FROM anime WHERE visibility = 'public' LIMIT 1")
    animeId = String(anime.rows[0].id)

    // Egy hír, amit A el tud vetni — a saját nevében.
    const { rows } = await pool.query(
      `INSERT INTO announcements (title, body, audience) VALUES ('idor probe', 'body', 'everyone') RETURNING id`)
    announcementId = String(rows[0].id)
  })

  after(async () => {
    try {
      if (announcementId) await pool.query('DELETE FROM announcements WHERE id = $1', [announcementId])
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  const as = (who: typeof A, profileId?: string): Record<string, string> => ({
    authorization: `Bearer ${who.token}`,
    ...(profileId ? { 'x-profile-id': profileId } : {})
  })

  test('the library refuses another account\'s profile', async () => {
    const res = await app.inject({ url: '/v1/me/library', headers: as(A, B.profileId) })
    assert.equal(res.statusCode, 403, res.body)
  })

  test('writing a library entry as another profile is refused', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/me/library/${animeId}`,
      headers: as(A, B.profileId),
      payload: { status: 'WATCHING' }
    })
    assert.equal(res.statusCode, 403, res.body)
    const { rows } = await pool.query(
      'SELECT 1 FROM library_entries WHERE profile_id = $1', [B.profileId])
    assert.equal(rows.length, 0, 'nothing may be written into the other account\'s library')
  })

  test('settings cannot be written into another profile', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/settings',
      headers: { ...as(A, B.profileId), 'content-type': 'application/json' },
      payload: { settings: { 'titles.language': 'english' } }
    })
    assert.equal(res.statusCode, 403, res.body)
    const { rows } = await pool.query('SELECT 1 FROM user_settings WHERE profile_id = $1', [B.profileId])
    assert.equal(rows.length, 0, 'nothing may be written into the other account\'s settings')
  })

  test('dismissing an announcement for another profile is refused', async () => {
    // Ez az, ami elromlott: az útvonal a fejlécben kapott profil nevében
    // szúrt be sort, tulajdonosi ellenőrzés nélkül.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/announcements/${announcementId}/dismiss`,
      headers: as(A, B.profileId)
    })
    assert.equal(res.statusCode, 403, res.body)
    const { rows } = await pool.query(
      'SELECT 1 FROM announcement_dismissals WHERE profile_id = $1', [B.profileId])
    assert.equal(rows.length, 0, 'the other profile must not have been marked as having dismissed it')
  })

  test('the announcement list never reports another profile\'s state', async () => {
    // B elveti a sajátjában…
    const mine = await app.inject({
      method: 'POST',
      url: `/v1/announcements/${announcementId}/dismiss`,
      headers: as(B, B.profileId)
    })
    assert.equal(mine.statusCode, 204, mine.body)

    // …A pedig B azonosítójával kérdez rá. A válasz A-ról szól, nem B-ről.
    const res = await app.inject({ url: '/v1/announcements', headers: as(A, B.profileId) })
    assert.equal(res.statusCode, 200, res.body)
    const row = (res.json() as { data: Array<{ id: string, dismissed: boolean }> })
      .data.find(r => r.id === announcementId)
    assert.equal(row?.dismissed, false, 'A has not dismissed it — B\'s state must not leak')
  })

  test('a missing profile header is a 400, not a guess', async () => {
    const res = await app.inject({ url: '/v1/me/library', headers: as(A) })
    assert.equal(res.statusCode, 400, res.body)
  })

  test('an account cannot delete another account', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${B.userId}`,
      headers: { ...as(A), 'content-type': 'application/json' },
      payload: { password: 'a-long-enough-test-password-1' }
    })
    assert.notEqual(res.statusCode, 204, 'deleting somebody else must not succeed')
    const { rows } = await pool.query('SELECT deleted_at FROM users WHERE id = $1', [B.userId])
    assert.equal(rows[0]?.deleted_at, null, 'the other account must still be live')
  })
})
