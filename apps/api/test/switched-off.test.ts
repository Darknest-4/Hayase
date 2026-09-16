// Egy kikapcsolt kapcsoló nem hiba.
//
// A metaadat-szinkron vészkapcsolója szándékosan a futás ELEJÉN utasít vissza,
// és a worker kommentje ki is mondja, miért: „az operátornak ne kelljen
// rájönnie, hogy ő maga kapcsolta ki". Ez a szándék nem ért el a felületig: a
// kivétel továbbdobódott, a hibakezelő 500-at csinált belőle, és az operátor
// egy névtelen „Request … failed" üzenetet kapott — miközben a saját
// kapcsolója állt útban.
//
// Ötven ilyen sor gyűlt a hibanaplóba nyitott hibacsoportként. Egy
// konfigurációs állapot triázsra várt.
//
// Ez a fájl azt a határt köti ki, ami a kettőt elválasztja:
//
//   * amit az operátor maga kapcsolt ki → 4xx, a saját szavaival;
//   * ami tényleg elromlott → 5xx, és akkor kerüljön a hibanaplóba.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, mock, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'switched-off-secret-long-enough-0123456789'

describe('a switch somebody threw is not a failure', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  let siteSettings: { externalSyncEnabled: () => Promise<boolean> }
  const usernames: string[] = []
  let admin = ''

  before(async () => {
    const [{ buildApp }, db, ss] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/settings/site-settings.ts')
    ])
    app = await buildApp()
    pool = db.pool
    siteSettings = ss.settings as never
    await app.ready()

    const username = 'off_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
       ON CONFLICT DO NOTHING`, [username])
    const auth = await import('../src/middleware/auth.ts')
    auth.invalidatePermissions()
    admin = (res.json() as { accessToken: string }).accessToken
  })

  after(async () => {
    try {
      mock.restoreAll()
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  test('starting a sync while sync is off is refused, in words, with no 500', async () => {
    // A beállítást a folyamaton belül kapcsoljuk ki, nem az adatbázisban: ez
    // egy megosztott adatbázis, és egy beragadt vészkapcsoló minden további
    // suite-ot megfojtana.
    mock.method(siteSettings, 'externalSyncEnabled', async () => false)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalogue/metadata/runs',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      payload: { kind: 'basic', scope: 'missing', limit: 1 }
    })
    mock.restoreAll()

    assert.notEqual(res.statusCode, 500, 'a saját kapcsolója 500-at adott vissza az operátornak')
    assert.equal(res.statusCode, 409, res.body)

    // És a válasz megmondja, mit kell tenni. Egy 409 „Conflict" felirattal
    // ugyanolyan néma, mint az 500 volt.
    const body = res.json() as { detail: string }
    assert.match(body.detail, /ki van kapcsolva/)
    assert.match(body.detail, /Biztonság/)
  })

  test('a refusal like this does not become an error group', async () => {
    // Ez a lelet lényege: ötven ilyen sor gyűlt a hibanaplóba nyitott
    // hibacsoportként, és minden egyes futtatáskor újabb keletkezett. Egy
    // konfigurációs állapot nem triázsra váró hiba.
    const before = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM error_logs WHERE message LIKE '%switched off%' AND created_at > now() - interval '1 minute'")

    mock.method(siteSettings, 'externalSyncEnabled', async () => false)
    await app.inject({
      method: 'POST',
      url: '/v1/admin/catalogue/metadata/runs',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      payload: { kind: 'basic', scope: 'missing', limit: 1 }
    })
    mock.restoreAll()

    const after = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM error_logs WHERE message LIKE '%switched off%' AND created_at > now() - interval '1 minute'")
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, 'a visszautasítás bekerült a hibanaplóba')
  })

  test('with sync on, the same request is accepted', async () => {
    // A másik oldal: a 409 nem attól jön, hogy valami más baj van.
    mock.method(siteSettings, 'externalSyncEnabled', async () => true)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalogue/metadata/runs',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      payload: { kind: 'basic', scope: 'missing', limit: 1 }
    })
    mock.restoreAll()

    // 202, vagy 409 azért, mert épp fut egy másik passz — mindkettő azt
    // jelenti, hogy a kapcsoló nem állt útban. Ami NEM lehet: 500.
    assert.ok([202, 409].includes(res.statusCode), res.body)
    if (res.statusCode === 202) {
      const { id } = res.json() as { id: string }
      // A sort eltakarítjuk: megosztott adatbázison egy sorban álló passz a
      // következő suite-ot 409-cel fogadná.
      await pool.query("UPDATE metadata_runs SET status = 'cancelled', finished_at = now() WHERE id = $1", [id])
      await pool.query("DELETE FROM jobs WHERE queue = 'metadata' AND payload->>'runId' = $1", [id])
    }
  })
})
