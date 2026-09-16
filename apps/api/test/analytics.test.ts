// A látogatottság: mit enged meg a kliensnek, és mit nem.
//
// Egy kimutatás annyit ér, amennyire igaz, és az igazságát pontosan egy dolog
// fenyegeti: hogy a számokat a kliens írja. Ezért a fájl súlypontja nem az,
// hogy a számláló nő-e, hanem hogy
//
//   * a kliens csak EGY dolgot mondhat (melyik oldalra lépett),
//   * a személyazonosságot és az időt a kiszolgáló adja,
//   * a frissítgetés nem fújja fel a számokat,
//   * a napi kulcs napokon át nem fűzhető össze,
//   * és az összesítő kétszer lefuttatva ugyanazt adja — mert egy összesítő,
//     ami hozzáad, egy újraindítás után hazudik, és utólag nem lehet
//     szétválogatni.

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'analytics-secret-long-enough-0123456789'

describe('analytics', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  let visitor: typeof import('../src/modules/analytics/visitor.ts')
  let collector: typeof import('../src/modules/analytics/collector.ts')
  let events: typeof import('../src/modules/analytics/account-events.ts')
  let rollup: typeof import('../src/modules/analytics/rollup.ts')
  let normaliseRoute: (r: string) => string
  const usernames: string[] = []
  const keys: string[] = []
  let admin = ''
  let plain = ''

  async function account (role?: string): Promise<{ token: string, id: string }> {
    const username = 'an_' + randomBytes(5).toString('hex')
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
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    return { token: (res.json() as { accessToken: string }).accessToken, id: String(rows[0].id) }
  }

  const as = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })

  before(async () => {
    const [{ buildApp }, db, v, c, e, r, routes] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/analytics/visitor.ts'),
      import('../src/modules/analytics/collector.ts'),
      import('../src/modules/analytics/account-events.ts'),
      import('../src/modules/analytics/rollup.ts'),
      import('../src/modules/analytics/collect-routes.ts')
    ])
    app = await buildApp()
    pool = db.pool
    visitor = v; collector = c; events = e; rollup = r
    normaliseRoute = (routes as unknown as { normaliseRoute: (x: string) => string }).normaliseRoute
    await app.ready()
    admin = (await account('admin')).token
    plain = (await account()).token
  })

  after(async () => {
    try {
      // A munkamenetkulcs alakja `<látogatókulcs>:<ablak>`, tehát előtag
      // szerint kell takarítani, nem pontos egyezéssel.
      for (const key of keys) {
        await pool.query('DELETE FROM page_views WHERE session_key LIKE $1', [key + ':%'])
        await pool.query('DELETE FROM analytics_sessions WHERE visitor_key = $1', [key])
      }
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  // ---- ki a látogató -----------------------------------------------------

  test('the same visitor gets the same key today and a different one tomorrow', async () => {
    const ip = '198.51.100.7'
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0'
    const a = await visitor.visitorKey(ip, ua)
    const b = await visitor.visitorKey(ip, ua)
    assert.equal(a, b, 'two requests from one visitor must land on one key')

    // Holnap más só, tehát más kulcs. Ez nem hiba, hanem a cél: a napokon át
    // tartó követést a rendszer nem teszi lehetővé, és a „visszatérő
    // látogató" ezért csak a bejelentkezetteknél pontos.
    visitor.forgetSalt()
    const tomorrow = new Date(Date.now() + 86_400_000)
    const c = await visitor.visitorKey(ip, ua, tomorrow)
    assert.notEqual(a, c, 'the key must not survive the day')
    visitor.forgetSalt()
    await pool.query('DELETE FROM analytics_salt WHERE day = $1', [tomorrow.toISOString().slice(0, 10)])
  })

  test('the key does not contain the address it was made from', async () => {
    const ip = '203.0.113.42'
    const key = await visitor.visitorKey(ip, 'agent')
    assert.ok(!key.includes('203'), 'the raw address leaked into the key')
    assert.match(key, /^[0-9a-f]{32}$/)
  })

  test('recognises the device without pretending to know the model', () => {
    const cases: Array<[string, string, string]> = [
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Safari/604', 'mobile', 'iOS'],
      ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537 Chrome/130 Mobile Safari/537', 'mobile', 'Android'],
      ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605 Safari/604', 'tablet', 'iPadOS'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537 Chrome/130 Safari/537', 'desktop', 'Windows'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605 Version/17 Safari/605', 'desktop', 'macOS']
    ]
    for (const [ua, device, os] of cases) {
      const shape = visitor.shapeOf(ua)
      assert.equal(shape.deviceClass, device, ua)
      assert.equal(shape.os, os, ua)
      assert.equal(shape.isBot, false)
    }
    // Az Edge UA-ja tartalmazza a Chrome-ot is; a sorrend dönt.
    assert.equal(visitor.shapeOf('Chrome/130 Edg/130').browser, 'Edge')
    assert.equal(visitor.shapeOf('Googlebot/2.1').isBot, true)
    assert.equal(visitor.shapeOf(undefined).deviceClass, 'unknown')
  })

  test('the screen is a band, not a measurement', () => {
    assert.equal(visitor.screenClass(390), 'xs')
    assert.equal(visitor.screenClass(1440), 'lg')
    assert.equal(visitor.screenClass(1920), 'xl')
    // Amit nem hiszünk el, az 'unknown' — nem tippelünk.
    assert.equal(visitor.screenClass(-1), 'unknown')
    assert.equal(visitor.screenClass('széles'), 'unknown')
    assert.equal(visitor.screenClass(999999), 'unknown')
  })

  test('the referrer keeps the host and drops everything else', () => {
    assert.equal(visitor.referrerHost('https://www.google.com/search?q=titok'), 'www.google.com')
    // A saját oldalunkról érkező hivatkozás navigáció, nem forrás.
    assert.equal(visitor.referrerHost('https://yume.test/anime/1', 'yume.test'), null)
    assert.equal(visitor.referrerHost('nem-url'), null)
    assert.equal(visitor.referrerHost(undefined), null)
  })

  test('routes lose their identifiers, because a page is not a row', () => {
    assert.equal(normaliseRoute(`/anime/${randomUUID()}`), '/anime/:id')
    assert.equal(normaliseRoute('/search?q=valami'), '/search')
    assert.equal(normaliseRoute('/anime/12345/episodes'), '/anime/:n/episodes')
  })

  // ---- amit a kliens mondhat ---------------------------------------------

  test('the beacon accepts a route and nothing else', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/view',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130' },
      payload: { route: '/search' }
    })
    assert.equal(res.statusCode, 204, res.body)
  })

  test('a client cannot declare who it is or when it was', async () => {
    collector.resetDedupe()
    await collector.flush()

    const route = '/hamisitas-' + randomBytes(5).toString('hex')
    const forged = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/view',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130' },
      payload: {
        route,
        // Öt mező, amivel egy kliens megpróbálná megmondani, ki ő és mikor
        // volt. A séma `additionalProperties: false`, tehát a Fastify
        // ajv-je LEVÁGJA őket — nem 400, hanem eltűnnek, mielőtt a kezelő
        // meglátná. A lényeg nem a válaszkód, hanem az, hogy egyik sem
        // befolyásolja, amit rögzítünk.
        visitorKey: 'sajat-kulcs',
        sessionKey: 'sajat-munkamenet',
        at: '2020-01-01T00:00:00Z',
        userId: forged,
        count: 5000
      }
    })
    assert.equal(res.statusCode, 204, res.body)
    await collector.flush()

    const { rows } = await pool.query(
      'SELECT session_key, created_at FROM page_views WHERE route = $1', [route])
    assert.equal(rows.length, 1, 'the forged count was ignored — exactly one view')
    keys.push(String(rows[0].session_key).split(':')[0])

    // A munkamenetkulcsot a kiszolgáló számolja; a klienstől kapott szöveg
    // nyoma sincs benne.
    assert.equal(String(rows[0].session_key).includes('sajat'), false)
    // Az idő a kiszolgáló órájáról jön, nem a törzsből.
    assert.ok(Date.parse(String(rows[0].created_at)) > Date.now() - 60_000,
      'the client dictated the timestamp')

    const session = await pool.query(
      'SELECT user_id FROM analytics_sessions WHERE session_key = $1', [rows[0].session_key])
    assert.equal(session.rows[0]?.user_id, null, 'the client named a user and was believed')
  })

  test('an absurd route is refused rather than stored', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/analytics/view',
      headers: { 'content-type': 'application/json' },
      payload: { route: 'x'.repeat(5000) }
    })
    assert.equal(res.statusCode, 400)
  })

  // ---- a számok nem fújhatók fel -----------------------------------------

  test('holding F5 does not multiply the number', async () => {
    collector.resetDedupe()
    // A puffer megosztott a fájlon belül: a fenti beacon-tesztek is tettek
    // bele. Kiürítjük, hogy amit itt számolunk, az tényleg csak ez legyen.
    await collector.flush()
    const key = 'teszt' + randomBytes(12).toString('hex')
    keys.push(key)
    const event = {
      visitorKey: key,
      userId: null,
      route: '/anime/:id',
      entityId: null,
      referrerHost: null,
      utm: { source: null, medium: null, campaign: null },
      shape: { deviceClass: 'desktop' as const, browser: 'Chrome', os: 'Linux', isBot: false },
      screen: 'lg',
      language: 'hu',
      country: null,
      at: new Date()
    }
    assert.equal(collector.enqueueView(event), 'accepted')
    for (let i = 0; i < 20; i++) {
      assert.equal(collector.enqueueView({ ...event, at: new Date() }), 'duplicate')
    }
    // Egy MÁSIK oldal ugyanattól a látogatótól viszont igazi letöltés.
    assert.equal(collector.enqueueView({ ...event, route: '/search' }), 'accepted')

    const written = await collector.flush()
    assert.equal(written, 2, 'exactly the two real views may be written')

    const { rows } = await pool.query(
      'SELECT page_views FROM analytics_sessions WHERE visitor_key = $1', [key])
    assert.equal(rows.length, 1, 'one visitor, one session')
    assert.equal(Number(rows[0].page_views), 2)
  })

  // ---- fiókesemények ------------------------------------------------------

  test('an account event gets a reference somebody can say out loud', async () => {
    const user = await account()
    const reference = await events.recordAccountEvent('LOGIN', { userId: user.id })
    assert.match(String(reference), /^LOGIN_\d{6,}$/)

    const history = await events.accountHistory(user.id)
    assert.ok(history.some(h => h.reference === reference))
    // A regisztráció is ott van: azt a fiók létrehozása írta, nem ez a teszt.
    assert.ok(history.some(h => h.event === 'REG'), 'registration was not recorded')
  })

  test('secrets never reach the event log, whatever the caller passes', () => {
    const cleaned = events.sanitise({
      password: 'titkos',
      refreshToken: 'abc',
      Authorization: 'Bearer x',
      nested: { apiKey: 'k', field: 'email' },
      field: 'email'
    })
    assert.equal(cleaned.password, '[eltávolítva]')
    assert.equal(cleaned.refreshToken, '[eltávolítva]')
    assert.equal(cleaned.Authorization, '[eltávolítva]')
    assert.equal((cleaned.nested as Record<string, unknown>).apiKey, '[eltávolítva]')
    // Ami nem titok, az megmarad: a napló attól napló, hogy mond is valamit.
    assert.equal(cleaned.field, 'email')
    assert.equal((cleaned.nested as Record<string, unknown>).field, 'email')
  })

  test('a failed sign-in is recorded without the text somebody typed', async () => {
    // A név egyedi, mert az ellenőrzés az, hogy NEM találjuk meg sehol.
    const typed = 'nincs-ilyen-' + randomBytes(6).toString('hex')
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { identifier: typed, password: 'rossz-jelszo-123456' }
    })
    assert.equal(res.statusCode, 401)

    // Számlálás helyett a saját sorunkat keressük: ez a suite megosztott
    // adatbázison fut, és egy párhuzamos fájl sikertelen belépése elrontaná
    // a „pontosan eggyel több" állítást.
    const { rows } = await pool.query(
      `SELECT metadata, result FROM account_events
        WHERE event = 'LOGIN_FAILED' AND created_at > now() - interval '1 minute'
        ORDER BY created_at DESC LIMIT 20`)
    assert.ok(rows.length > 0, 'the failed attempt was not recorded at all')
    assert.ok(rows.some(r => r.result === 'failed'))
    // Az azonosító nincs benne: nem létező fióknál az nem a fiók előzménye,
    // hanem egy idegen által begépelt szöveg — lehet elgépelt e-mail-cím vagy
    // egy másik oldal jelszava.
    for (const row of rows) {
      assert.equal(JSON.stringify(row.metadata).includes(typed), false,
        'the typed identifier was stored')
    }
  })

  // ---- összesítés ---------------------------------------------------------

  test('running the rollup twice gives the same numbers, not double', async () => {
    const day = new Date().toISOString().slice(0, 10)
    await rollup.rollupVisitors(day)
    const first = await pool.query('SELECT sessions, page_views FROM analytics_daily WHERE day = $1', [day])
    await rollup.rollupVisitors(day)
    const second = await pool.query('SELECT sessions, page_views FROM analytics_daily WHERE day = $1', [day])
    assert.deepEqual(second.rows[0], first.rows[0],
      'the rollup adds instead of replacing — a restarted job would inflate every number')
  })

  // ---- ki láthatja --------------------------------------------------------

  test('the reports need the permission', async () => {
    for (const url of ['/v1/admin/analytics/visitors', '/v1/admin/analytics/realtime',
      '/v1/admin/analytics/anime', '/v1/admin/analytics/search', '/v1/admin/analytics/users']) {
      assert.equal((await app.inject({ url, headers: as(plain) })).statusCode, 403, url)
      assert.equal((await app.inject({ url, headers: as(admin) })).statusCode, 200, url)
    }
  })

  test("one account's activity is hidden behind its own permission", async () => {
    const user = await account()
    const url = `/v1/admin/analytics/accounts/${user.id}`
    // Rejtett: aki nem jogosult, annak nem létezik.
    assert.equal((await app.inject({ url, headers: as(plain) })).statusCode, 404)

    const res = await app.inject({ url, headers: as(admin) })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as Record<string, unknown>
    for (const key of ['user', 'events', 'sessions', 'devices', 'visits', 'watch']) {
      assert.ok(key in body, `${key} hiányzik`)
    }
    // IP nincs a válaszban: az a biztonsági naplóé, nem a tevékenységé.
    assert.equal(JSON.stringify(body).includes('"ip"'), false, 'an address leaked into the activity view')
  })

  test('every report answers, including the per-title drill-down', async () => {
    // Ez a teszt azért van, mert a lekérdezések fele NEM azzal az oszloppal
    // hivatkozik a címre, amivel az ember gondolná: a kedvencek és a
    // hozzászólások polimorfak (subject_type + subject_id), a könyvtár és az
    // értékelés viszont közvetlen. Négy 500-as hiba kellett ahhoz, hogy ez
    // kiderüljön — és mind olyan végponton, amit a korábbi tesztek nem
    // nyitottak meg.
    const { rows } = await pool.query(
      "SELECT id FROM anime WHERE visibility = 'public' ORDER BY popularity DESC LIMIT 1")
    const id = rows[0]?.id
    assert.ok(id, 'a katalógus üres, a teszt nem tud mit mérni')

    for (const url of [
      `/v1/admin/analytics/anime/${id}?range=30d`,
      '/v1/admin/analytics/performance?range=7d',
      '/v1/admin/analytics/breakdown?dimension=browser&range=7d',
      '/v1/admin/analytics/export?dataset=daily&format=json&range=7d',
      '/v1/admin/analytics/export?dataset=anime&format=csv&range=7d'
    ]) {
      const res = await app.inject({ url, headers: as(admin) })
      assert.equal(res.statusCode, 200, `${url} → ${res.statusCode} ${res.body.slice(0, 200)}`)
    }
  })

  test('an export is refused without its own permission, and audited with it', async () => {
    const url = '/v1/admin/analytics/export?dataset=daily&format=csv&range=7d'
    // Rejtett: adatkivitelt nem tiltunk, hanem nem is kínálunk.
    assert.equal((await app.inject({ url, headers: as(plain) })).statusCode, 404)

    const res = await app.inject({ url, headers: as(admin) })
    assert.equal(res.statusCode, 200, res.body)
    assert.match(String(res.headers['content-disposition']), /attachment; filename="yume-daily-/)
    // BOM: enélkül az Excel elrontja az ékezeteket, és az export első dolga,
    // hogy valaki megnyitja Excelben.
    assert.ok(res.body.startsWith('\uFEFF'), 'a CSV nem BOM-mal kezdődik')

    const audited = await pool.query(
      `SELECT after FROM audit_logs WHERE action = 'analytics.export' ORDER BY created_at DESC LIMIT 1`)
    assert.equal(audited.rows[0]?.after?.dataset, 'daily')
  })

  test('the visitor report compares the window with the one before it', async () => {
    const res = await app.inject({ url: '/v1/admin/analytics/visitors?range=7d', headers: as(admin) })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { window: { days: number }, totals: unknown, previous: unknown }
    assert.equal(body.window.days, 7)
    assert.ok(body.totals && body.previous, 'a number with nothing to compare it to says nothing')
  })

  test('an unknown range is refused, not silently reinterpreted', async () => {
    const res = await app.inject({ url: '/v1/admin/analytics/visitors?range=mindent', headers: as(admin) })
    assert.equal(res.statusCode, 400, res.body)
  })
})
