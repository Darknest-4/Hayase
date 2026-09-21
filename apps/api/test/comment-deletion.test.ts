// A hozzászólás törlése — ki törölhet, és mi lesz a válaszokkal.
//
// MI HIÁNYZOTT. A `/v1/comments` modulnak EGYÁLTALÁN nem volt törlő végpontja:
// `GET /`, `GET /recent`, `POST /`, `POST /:id/like` — és semmi más. Tehát sem
// a szerző, sem egy moderátor nem tudott hozzászólást levenni, akkor sem, ha a
// jogosultság (`comment.moderate`) régóta létezett a táblában.
//
// A SÉMA VISZONT KÉSZEN ÁLLT RÁ, és pont ez a kényes pont: a `parent_id`
// idegen kulcsa `ON DELETE CASCADE`. Egy szálindító puszta eldobása MÁSOK
// hozzászólásait is elvinné. Ez a suite a nagyobbik felében erről szól.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import { publicInstance } from './support/instance.ts'

const HAS_DB = Boolean(process.env.DATABASE_URL)

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>, rowCount: number | null }> }

interface Account { username: string, token: string, id: string }

describe('a hozzászólás törlése', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  publicInstance()

  const made: string[] = []
  let author: Account
  let stranger: Account
  let moderator: Account
  let subjectId = ''

  async function register (prefix: string): Promise<Account> {
    const username = prefix + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    made.push(username)
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    return { username, token: (res.json() as { accessToken: string }).accessToken, id: String(rows[0]!.id) }
  }

  const as = (account: Account): Record<string, string> => ({ authorization: `Bearer ${account.token}` })

  /** Egy hozzászólás, opcionálisan válaszként. Visszaadja az azonosítót. */
  async function comment (account: Account, body: string, parentId: string | null = null): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/v1/comments', headers: as(account),
      payload: { subjectType: 'anime', subjectId, body, ...(parentId ? { parentId } : {}) }
    })
    assert.equal(res.statusCode, 201, res.body)
    return (res.json() as { id: string }).id
  }

  const remove = async (account: Account, id: string): ReturnType<typeof app.inject> =>
    await app.inject({ method: 'DELETE', url: `/v1/comments/${id}`, headers: as(account) })

  const row = async (id: string): Promise<Record<string, unknown> | null> => {
    const { rows } = await pool.query('SELECT body, deleted_at, reply_count FROM comments WHERE id = $1', [id])
    return rows[0] ?? null
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    author = await register('del_a_')
    stranger = await register('del_s_')
    moderator = await register('del_m_')
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = 'moderator' ON CONFLICT DO NOTHING",
      [moderator.id]
    )

    const { rows } = await pool.query(
      `INSERT INTO anime (canonical_title, format, status, episode_count, is_adult)
       VALUES ($1, 'TV', 'FINISHED', 1, false) RETURNING id`,
      ['Törlésteszt ' + randomBytes(3).toString('hex')]
    )
    subjectId = String(rows[0]!.id)
  })

  after(async () => {
    if (subjectId) await pool?.query('DELETE FROM anime WHERE id = $1', [subjectId])
    for (const username of made) await pool?.query('DELETE FROM users WHERE username = $1', [username])
    await app?.close()
    await pool?.end()
  })

  describe('ki törölhet', () => {
    test('a szerző a sajátját', async () => {
      const id = await comment(author, 'Ezt én írtam')
      const res = await remove(author, id)
      assert.equal(res.statusCode, 204, res.body)
      assert.equal(await row(id), null, 'a sor megmaradt')
    })

    /*
     * 404 ÉS NEM 403. Egy 403 megerősítené, hogy a megtippelt azonosító mögött
     * van valami — ugyanaz a megfontolás, ami miatt a privilegizált útvonalak
     * is 404-gyel felelnek.
     */
    test('idegen a másét nem — és nem is tudja meg, hogy létezik', async () => {
      const id = await comment(author, 'Ehhez ne nyúlj')
      const res = await remove(stranger, id)
      assert.equal(res.statusCode, 404)
      assert.ok(await row(id), 'mégis törölte')
    })

    test('moderátor a másét igen', async () => {
      const id = await comment(author, 'Ezt egy moderátor veszi le')
      const res = await remove(moderator, id)
      assert.equal(res.statusCode, 204, res.body)
      assert.equal(await row(id), null)
    })

    test('bejelentkezés nélkül semmit', async () => {
      const id = await comment(author, 'Névtelenül nem megy')
      const res = await app.inject({ method: 'DELETE', url: `/v1/comments/${id}` })
      assert.equal(res.statusCode, 401)
      assert.ok(await row(id))
    })

    test('nem létező azonosítóra ugyanaz a válasz', async () => {
      const res = await remove(author, '00000000-0000-0000-0000-000000000000')
      assert.equal(res.statusCode, 404)
    })

    test('értelmezhetetlen azonosító nem hasal el 500-zal', async () => {
      const res = await remove(author, 'nem-uuid')
      assert.equal(res.statusCode, 400)
    })
  })

  describe('mi lesz a válaszokkal', () => {
    /*
     * EZ A SUITE LÉNYEGE. A `parent_id` cascade-je miatt egy szálindító
     * eldobása MÁSOK hozzászólásait vinné el. Sírkő marad helyette.
     */
    test('a szálindító törlése nem viszi el mások válaszait', async () => {
      const parent = await comment(author, 'Szálindító')
      const reply = await comment(stranger, 'Egy idegen válasza', parent)

      assert.equal(await remove(author, parent).then(r => r.statusCode), 204)

      const survivor = await row(reply)
      assert.ok(survivor, 'az idegen válasza eltűnt a szálindítóval együtt')
      assert.equal(survivor.body, 'Egy idegen válasza')

      const tomb = await row(parent)
      assert.ok(tomb, 'a szálindító sora eltűnt, tehát a szál szétesett')
      assert.ok(tomb.deleted_at, 'nincs megjelölve töröltként')
      assert.notEqual(tomb.body, 'Szálindító', 'a törzs megmaradt')
    })

    test('a sírkő a listában is jelölve érkezik', async () => {
      const parent = await comment(author, 'Listában látszó szál')
      await comment(stranger, 'válasz', parent)
      await remove(author, parent)

      const res = await app.inject({
        method: 'GET', url: `/v1/comments?subjectType=anime&subjectId=${subjectId}`
      })
      assert.equal(res.statusCode, 200)
      const found = (res.json() as { data: Array<{ id: string, deleted_at: string | null, body: string }> })
        .data.find(c => c.id === parent)
      assert.ok(found, 'a sírkő kimaradt a listából — a szál szétesne')
      assert.ok(found.deleted_at, 'a kliens nem tudja megkülönböztetni a töröltet')
      assert.notEqual(found.body, 'Listában látszó szál')
    })

    /*
     * A friss folyam SZÁLAKAT mutat, nem szálrészleteket — ott egy sírkőnek
     * nincs mit megtartania.
     */
    test('a friss folyamba nem kerül sírkő', async () => {
      const parent = await comment(author, 'Friss folyamból kiesik')
      await comment(stranger, 'válasz', parent)
      await remove(author, parent)

      const res = await app.inject({ method: 'GET', url: '/v1/comments/recent?limit=50' })
      const ids = (res.json() as { data: Array<{ id: string }> }).data.map(c => c.id)
      assert.ok(!ids.includes(parent))
    })

    test('a levél törlése visszaveszi a szülő válaszszámlálóját', async () => {
      const parent = await comment(author, 'Számláló-teszt')
      const reply = await comment(stranger, 'Egy válasz', parent)
      assert.equal((await row(parent))?.reply_count, 1)

      assert.equal(await remove(stranger, reply).then(r => r.statusCode), 204)
      assert.equal((await row(parent))?.reply_count, 0, 'a szál fejlécében ott maradt egy válasz, ami nincs')
    })

    /* Kétszer törölni nem hiba: a kívánt állapot már fennáll. */
    test('a második törlés is 204', async () => {
      const parent = await comment(author, 'Kétszer')
      await comment(stranger, 'válasz', parent)
      assert.equal(await remove(author, parent).then(r => r.statusCode), 204)
      assert.equal(await remove(author, parent).then(r => r.statusCode), 204)
    })
  })
})
