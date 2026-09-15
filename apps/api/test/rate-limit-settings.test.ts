// A sebességkorlát olyan védelem, amit menet közben kell állítani.
//
// Eddig kizárólag környezeti változó volt: az átállítása újraindítást
// jelentett. És az az egyetlen pillanat, amikor egy korlátot állítani kell, az
// az, amikor épp folyik valami — egy roham, egy elszabadult kliens, vagy épp
// az ellenkezője: egy iskolai NAT mögül érkező osztály, akiket a közös cím
// miatt kizártunk.
//
// Egy védelem, amihez telepítés kell, nem védelem, hanem terv.
//
// Ez a fájl azt köti ki, ami ezt használhatóvá teszi:
//
//   * a panelen írt érték AZONNAL hat, nem a gyorsítótár lejártakor;
//   * a beállítás hiánya a környezeti alapértéket jelenti, tehát egy panelen
//     soha nem járt példány pontosan úgy viselkedik, mint eddig;
//   * jogosultság kell hozzá, és nyomot hagy.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'ratelimit-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('rate limits are a setting, not a deployment', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  let admin = ''
  let plain = ''

  async function account (role?: string): Promise<string> {
    const username = 'rl_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    if (role) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = $2
         ON CONFLICT DO NOTHING`, [username, role])
      const auth = await import('../src/middleware/auth.ts')
      auth.invalidatePermissions()
    }
    return (res.json() as { accessToken: string }).accessToken
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
    plain = await account()
    admin = await account('admin')
  })

  after(async () => {
    try {
      // A beállítás sorát visszavesszük: ez egy megosztott adatbázis, és egy
      // beragadt korlát minden további suite-ot megfojtana.
      await pool.query("DELETE FROM site_settings WHERE key = 'rate_limits'")
      const { settings } = await import('../src/modules/settings/site-settings.ts')
      settings.invalidate()
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  const as = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

  test('the panel reports what is in force and what the default was', async () => {
    const res = await app.inject({ url: '/v1/admin/security', headers: as(admin) })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { rateLimits: Array<{ key: string, max: number, defaultMax: number, custom: boolean }> }
    const keys = body.rateLimits.map(r => r.key).sort()
    assert.deepEqual(keys, ['auth', 'global', 'refresh', 'write'])
    // Beállítás nélkül minden sor az alapérték, és egyik sem „egyedi".
    for (const row of body.rateLimits) {
      assert.equal(row.max, row.defaultMax, `${row.key} differs from its default with nothing stored`)
      assert.equal(row.custom, false)
    }
  })

  test('an account without the permission cannot change them', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/security/limits',
      headers: { ...as(plain), 'content-type': 'application/json' },
      payload: { reason: 'nope', limits: { global: { max: 1, windowSeconds: 60 } } }
    })
    // A biztonsági felület rejtett: 404, nem 403.
    assert.equal(res.statusCode, 404, res.body)
    const { rows } = await pool.query("SELECT 1 FROM site_settings WHERE key = 'rate_limits'")
    assert.equal(rows.length, 0, 'nothing may have been written')
  })

  test('a reason is required', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/security/limits',
      headers: { ...as(admin), 'content-type': 'application/json' },
      payload: { limits: { global: { max: 500, windowSeconds: 60 } } }
    })
    assert.equal(res.statusCode, 400, res.body)
  })

  test('zero is refused: that is a closed door, not a limit', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/security/limits',
      headers: { ...as(admin), 'content-type': 'application/json' },
      payload: { reason: 'probe', limits: { global: { max: 0, windowSeconds: 60 } } }
    })
    assert.equal(res.statusCode, 400, res.body)
  })

  test('a written limit takes effect at once, and is audited', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/security/limits',
      headers: { ...as(admin), 'content-type': 'application/json' },
      payload: { reason: 'audit trail test', limits: { write: { max: 7, windowSeconds: 120 } } }
    })
    assert.equal(res.statusCode, 200, res.body)

    // Azonnal, nem a gyorsítótár lejártakor.
    const { settings } = await import('../src/modules/settings/site-settings.ts')
    const live = await settings.rateLimits()
    assert.equal(live.write.max, 7, 'the new limit is not in force')
    assert.equal(live.write.windowSeconds, 120)

    // A többi korlát nem mozdult.
    const { rateLimitDefaults } = await import('../src/modules/settings/site-settings.ts')
    assert.equal(live.auth.max, rateLimitDefaults().auth.max, 'an untouched limit changed')

    // És a panel „egyedinek" jelöli, ami az.
    const view = await app.inject({ url: '/v1/admin/security', headers: as(admin) })
    const rows = (view.json() as { rateLimits: Array<{ key: string, custom: boolean }> }).rateLimits
    assert.equal(rows.find(r => r.key === 'write')?.custom, true)
    assert.equal(rows.find(r => r.key === 'auth')?.custom, false)

    const audit = await pool.query(
      "SELECT after FROM audit_logs WHERE action = 'config.setting' AND subject_id = 'rate_limits' ORDER BY created_at DESC LIMIT 1")
    assert.ok(audit.rows.length, 'the change left no trace')
    assert.equal((audit.rows[0].after as { reason?: string }).reason, 'audit trail test')
  })

  test('a broken stored value falls back to the default rather than to nothing', async () => {
    // Egy kézzel elrontott sor nem tehet egy korlátot nullává vagy
    // végtelenné. A hibás mező az alapértékre esik vissza, mezőnként.
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ('rate_limits', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`,
      [JSON.stringify({ global: { max: 'sok', windowSeconds: -5 }, auth: null })]
    )
    const { settings, rateLimitDefaults } = await import('../src/modules/settings/site-settings.ts')
    settings.invalidate()
    const live = await settings.rateLimits()
    const defaults = rateLimitDefaults()
    assert.equal(live.global.max, defaults.global.max)
    assert.equal(live.global.windowSeconds, defaults.global.windowSeconds)
    assert.equal(live.auth.max, defaults.auth.max)
  })
})
