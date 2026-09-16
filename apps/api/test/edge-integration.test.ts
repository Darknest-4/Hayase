// Az él a KÉRÉSI ÚTON — a valódi alkalmazáson keresztül.
//
// Az előző fájlok a motorokat mérik külön. Ez azt méri, amit a látogató lát:
// átmegy-e a kérése, és ha nem, miért.
//
// A LEGFONTOSABB ÁLLÍTÁS EBBEN A FÁJLBAN: a normál YUME-forgalom NEM akad
// fenn. Egy biztonsági réteg, ami a látogatók századát megfogja, rosszabb,
// mint amilyen nincs — mert az operátor kikapcsolja, és utána semmi nincs.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'edge-secret-long-enough-0123456789'
// Az él saját korlátai tágabbak a sebességkorlátnál; hogy ne az akadjon meg,
// a globálist felengedjük erre a futásra.
process.env.RATE_LIMIT_MAX ??= '100000'

describe('the edge on the request path', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  let events: typeof import('../src/modules/edge/events.ts')
  let bans: typeof import('../src/modules/edge/bans.ts')
  let counters: typeof import('../src/modules/edge/counters.ts')
  const usernames: string[] = []
  let admin = ''

  before(async () => {
    const [{ buildApp }, db, e, b, c] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/edge/events.ts'),
      import('../src/modules/edge/bans.ts'),
      import('../src/modules/edge/counters.ts')
    ])
    app = await buildApp()
    pool = db.pool
    events = e; bans = b; counters = c
    await app.ready()

    const username = 'edge_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/register',
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
      await pool.query("DELETE FROM edge_bans WHERE reason LIKE 'teszt:%' OR subject = '127.0.0.1'")
      await pool.query("DELETE FROM site_settings WHERE key = 'edge'")
      const { settings } = await import('../src/modules/settings/site-settings.ts')
      settings.invalidate()
      bans.invalidate()
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  const as = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })
  const browser = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537 Chrome/130 Safari/537',
    accept: 'application/json',
    'accept-language': 'hu-HU,hu;q=0.9'
  }

  // ---- amit át KELL engednie ------------------------------------------

  test('ordinary browsing is untouched', async () => {
    const urls = [
      '/v1/config',
      '/v1/anime?sort=popularity&limit=25',
      '/v1/anime?genre=action&sort=trending',
      '/v1/anime/search?q=Shingeki%20no%20Kyojin',
      '/v1/anime/suggest?q=Nich&limit=8'
    ]
    for (const url of urls) {
      const res = await app.inject({ url, headers: browser })
      assert.ok(res.statusCode < 400, `${url} → ${res.statusCode} ${res.body.slice(0, 160)}`)
    }
  })

  test('a signed-in reader is untouched', async () => {
    // A könyvtár profil nevében válaszol, és a profilazonosító fejlécben megy.
    const me = await app.inject({ url: '/v1/profiles/me', headers: { ...as(admin), ...browser } })
    const profileId = (me.json() as { id?: string }).id
    assert.ok(profileId, 'nincs profil a fiókhoz')

    for (const url of ['/v1/me/library?limit=50', '/v1/me/favorites', '/v1/me/continue-watching']) {
      const res = await app.inject({
        url, headers: { ...as(admin), ...browser, 'x-profile-id': profileId }
      })
      assert.ok(res.statusCode < 400, `${url} → ${res.statusCode} ${res.body.slice(0, 120)}`)
    }
  })

  test('a fast but ordinary reader is not blocked', async () => {
    // Negyven kérés egymás után egy emberi böngészésnél is előfordul: egy
    // részletoldal hat hívás, hét cím megnyitása negyvenkettő.
    counters.reset()
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({ url: '/v1/anime?limit=5&sort=popularity', headers: browser })
      assert.ok(res.statusCode < 400, `a(z) ${i + 1}. kérés elakadt: ${res.statusCode}`)
    }
  })

  test('the health probe is never inspected', async () => {
    // Egy orchestrátor 503-at olvasna belőle, és újraindítaná a konténert.
    const res = await app.inject({ url: '/v1/health' })
    assert.ok(res.statusCode < 400)
  })

  // ---- amit meg KELL fognia -------------------------------------------

  test('an attack pattern is scored, and in dry run still answered', async () => {
    // Alapból SZÁRAZ üzem: kiértékel és naplóz, de nem utasít vissza. Ez az
    // üzembe helyezés első lépése, és ezt a viselkedést is ki kell kötni.
    const res = await app.inject({
      url: "/v1/anime?genre=a' UNION SELECT password_hash FROM users--",
      headers: browser
    })
    assert.notEqual(res.statusCode, 403, 'száraz üzemben is visszautasított')

    await events.flush()
    const { rows } = await pool.query(
      `SELECT action, score, rule, signals FROM edge_decisions
        WHERE rule = 'sqli.union' AND at > now() - interval '1 minute'
        ORDER BY at DESC LIMIT 1`)
    assert.equal(rows.length, 1, 'a támadás nem került a döntésnaplóba')
    assert.ok(Number(rows[0].score) > 0)
    // A jelek a pontszámaikkal: ebből derül ki UTÓLAG, miért.
    assert.ok(Object.keys(rows[0].signals).length > 0, 'a jelek nem kerültek a naplóba')
  })

  test('with dry run off, the same request is refused', async () => {
    const { settings } = await import('../src/modules/settings/site-settings.ts')
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ('edge', '{"dryRun": false}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = '{"dryRun": false}'::jsonb`)
    settings.invalidate()

    try {
      const res = await app.inject({
        url: "/v1/anime?genre=a' UNION SELECT password_hash FROM users--",
        headers: browser
      })
      assert.equal(res.statusCode, 403, res.body)

      // A válasz NEM árulja el a pontszámot vagy a jeleket: abból egy támadó
      // megtudná, melyik jel mennyit ér, és addig hangolna, amíg alá nem megy.
      const body = res.json() as Record<string, unknown>
      assert.equal(JSON.stringify(body).includes('score'), false, 'a pontszám kiszivárgott a válaszba')
      assert.equal(JSON.stringify(body).includes('sqli'), false, 'a szabály neve kiszivárgott')
    } finally {
      /*
       * Az AUTOMATIKUS tiltás is eltakarítandó.
       *
       * Éles üzemben a blokk után az él kitiltja a támadó címet — és ez a
       * teszt épp ezt bizonyítja. Csakhogy a suite minden kérése ugyanarról a
       * hurokcímről jön, tehát a saját tiltásunk a KÖVETKEZŐ teszteket is
       * megfogná. (Pontosan ez történt, és három teszt bukott el tőle.)
       */
      await pool.query("DELETE FROM edge_bans WHERE subject = '127.0.0.1'")
      await pool.query("DELETE FROM site_settings WHERE key = 'edge'")
      settings.invalidate()
      bans.invalidate()
    }
  })

  test('a blocked attacker is banned automatically', async () => {
    // Az előző teszt mellékhatása volt; itt kimondjuk, mert ez a rendszer
    // egyik lényege: aki átlépi a tiltási küszöböt, az nem kérésenként akad
    // fenn újra, hanem kikerül az útból.
    const { settings } = await import('../src/modules/settings/site-settings.ts')
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ('edge', '{"dryRun": false}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = '{"dryRun": false}'::jsonb`)
    settings.invalidate()
    await pool.query("DELETE FROM edge_bans WHERE subject = '127.0.0.1'")
    bans.invalidate()

    try {
      await app.inject({ url: '/v1/anime?genre=' + encodeURIComponent("x';DROP TABLE users"), headers: browser })
      // Az automatikus tiltás a háttérben íródik; adunk neki egy pillanatot.
      await new Promise(resolve => setTimeout(resolve, 150))

      const { rows } = await pool.query(
        `SELECT reason, source, automatic, expires_at FROM edge_bans
          WHERE subject = '127.0.0.1' AND automatic ORDER BY created_at DESC LIMIT 1`)
      assert.equal(rows.length, 1, 'a blokkolt cím nem került tiltásra')
      assert.equal(rows[0].source, 'waf')
      // IDEIGLENES, nem végleges: az első tiltás gyakran félreértés — egy
      // elszabadult szkript, egy megosztott hálózat.
      assert.ok(rows[0].expires_at, 'az első automatikus tiltás végleges lett')
    } finally {
      await pool.query("DELETE FROM edge_bans WHERE subject = '127.0.0.1'")
      await pool.query("DELETE FROM site_settings WHERE key = 'edge'")
      settings.invalidate()
      bans.invalidate()
    }
  })

  test('a banned address is refused, and the ban says why', async () => {
    const { settings } = await import('../src/modules/settings/site-settings.ts')
    await bans.ban({
      kind: 'ip', subject: '127.0.0.1', reason: 'teszt: kézi tiltás', source: 'manual', seconds: 120
    })
    settings.invalidate()

    try {
      const res = await app.inject({ url: '/v1/anime?limit=1', headers: browser })
      // A tiltás SZÁRAZ ÜZEMBEN IS hat: aki kézzel tiltott, annak a döntése
      // nem próba.
      assert.equal(res.statusCode, 403, res.body)
      assert.ok(res.headers['retry-after'], 'nincs Retry-After egy ideiglenes tiltáson')
    } finally {
      await pool.query("DELETE FROM edge_bans WHERE reason LIKE 'teszt:%' OR subject = '127.0.0.1'")
      bans.invalidate()
    }
  })

  test('a lifted ban stops applying at once', async () => {
    const created = await bans.ban({
      kind: 'ip', subject: '127.0.0.1', reason: 'teszt: feloldandó', source: 'manual', seconds: 600
    })
    assert.ok(created)
    assert.equal((await app.inject({ url: '/v1/anime?limit=1', headers: browser })).statusCode, 403)

    await bans.lift(created.id, null, 'teszt vége')
    const after = await app.inject({ url: '/v1/anime?limit=1', headers: browser })
    assert.ok(after.statusCode < 400, 'a feloldott tiltás még mindig fog')
  })

  // ---- az admin felület ------------------------------------------------

  test('the edge surface needs its own permission', async () => {
    const plain = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: {
        email: `edgep${randomBytes(4).toString('hex')}@test.invalid`,
        username: 'edgep' + randomBytes(5).toString('hex'),
        password: 'a-long-enough-test-password-1'
      }
    })
    usernames.push((plain.json() as { username?: string }).username ?? '')
    const token = (plain.json() as { accessToken: string }).accessToken

    // Olvasás: 403 (létezik, de nem a tiéd).
    assert.equal((await app.inject({ url: '/v1/admin/edge', headers: as(token) })).statusCode, 403)
    // Tiltás: 404 — rejtett. Aki nem tilthat, annak a végpont nem létezik.
    const banAttempt = await app.inject({
      method: 'POST', url: '/v1/admin/edge/bans',
      headers: { ...as(token), 'content-type': 'application/json' },
      payload: { kind: 'ip', subject: '203.0.113.5', reason: 'nem szabadna' }
    })
    assert.equal(banAttempt.statusCode, 404)

    assert.equal((await app.inject({ url: '/v1/admin/edge', headers: as(admin) })).statusCode, 200)
  })

  test('a whole-internet ban is refused, with the reason', async () => {
    // Egy /8 tizenhatmillió címet fed le. A legtöbbje mögött olyan ember van,
    // aki nem csinált semmit.
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/edge/bans',
      headers: { ...as(admin), 'content-type': 'application/json' },
      payload: { kind: 'network', subject: '10.0.0.0/8', reason: 'teszt: túl tág' }
    })
    assert.equal(res.statusCode, 400, res.body)
    assert.match((res.json() as { detail: string }).detail, /maszk/)
  })

  test('thresholds out of order are refused rather than quietly reordered', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/admin/edge/config',
      headers: { ...as(admin), 'content-type': 'application/json' },
      payload: { reason: 'teszt', thresholds: { monitor: 90, challenge: 50, throttle: 60, block: 20 } }
    })
    assert.equal(res.statusCode, 400, res.body)
    assert.match((res.json() as { detail: string }).detail, /növekvő/)
  })

  test('a config change is audited', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/admin/edge/config',
      headers: { ...as(admin), 'content-type': 'application/json' },
      payload: { reason: 'teszt: küszöb hangolása', thresholds: { monitor: 30 } }
    })
    assert.equal(res.statusCode, 200, res.body)

    const { rows } = await pool.query(
      `SELECT after FROM audit_logs WHERE action = 'edge.config' ORDER BY created_at DESC LIMIT 1`)
    assert.equal(rows[0]?.after?.reason, 'teszt: küszöb hangolása')

    await pool.query("DELETE FROM site_settings WHERE key = 'edge'")
    const { settings } = await import('../src/modules/settings/site-settings.ts')
    settings.invalidate()
  })

  test('the rule list is readable, and each rule explains itself', async () => {
    const res = await app.inject({ url: '/v1/admin/edge/rules', headers: as(admin) })
    assert.equal(res.statusCode, 200)
    const { rules } = res.json() as { rules: Array<{ id: string, title: string, severity: string }> }
    assert.ok(rules.length >= 10)
    for (const rule of rules) assert.ok(rule.title.length > 8, `${rule.id}: nincs magyarázata`)
  })
})
