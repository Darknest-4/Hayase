// Szolgáltatói mérőszámok — gyűjtés és olvasás.
//
// A MÉRÉS NEM LEHET A LASSULÁS OKA. Ezért a gyűjtő memóriában gyűjt és
// kötegben ír; ez a készlet azt őrzi, hogy közben ne veszítsen és ne
// duplázzon — a kettő közül a duplázás a rosszabb, mert az hazudik.
//
// Az olvasó oldalon a tétel: a HIBAARÁNY ne vegye hibának azt, ami nem az.
// Az `empty` a lánc szerint SIKER (a szolgáltató felelt, csak nincs nála ez a
// cím), a `skipped` pedig azt jelenti, hogy meg sem kérdeztük.

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'provider-metrics-test-secret-long-enough-0123456789'

let metrics: typeof import('../src/modules/providers/metrics.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

/** Egy elkülönített nap, hogy a mérés ne keveredjen más tesztekével. */
const NAP = new Date('2019-03-07T12:00:00Z')
const SLUG = 'teszt-szolgaltato-' + Math.random().toString(36).slice(2, 8)

describe('a szolgáltatói mérőszámok', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    metrics = await import('../src/modules/providers/metrics.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })
  beforeEach(async () => {
    metrics.reset()
    await db.query('DELETE FROM provider_metrics_daily WHERE slug LIKE $1', ['teszt-szolgaltato-%'])
  })
  after(async () => {
    await db.query('DELETE FROM provider_metrics_daily WHERE slug LIKE $1', ['teszt-szolgaltato-%'])
  })

  const sor = async (outcome: string) => await db.queryOne<{
    attempts: number, sources: number, latency_ms_sum: string, latency_ms_max: number
  }>('SELECT attempts, sources, latency_ms_sum, latency_ms_max FROM provider_metrics_daily WHERE slug = $1 AND outcome = $2',
  [SLUG, outcome])

  it('nem ír azonnal — a felvétel nem adatbázis-művelet', async () => {
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 2, ms: 40 }], NAP)
    // A `queryOne` szerződése `Row | undefined` — nem `null`.
    assert.equal(await sor('ok'), undefined, 'a felvétel azonnal írt — ez a kérési úton lassítana')
    assert.equal(metrics.pending(), 1)
  })

  it('kiírás után megjelenik, összesítve', async () => {
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 2, ms: 40 }], NAP)
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 3, ms: 60 }], NAP)
    await metrics.flush()

    const r = await sor('ok')
    assert.equal(r?.attempts, 2)
    assert.equal(r?.sources, 5)
    assert.equal(Number(r?.latency_ms_sum), 100)
    assert.equal(r?.latency_ms_max, 60, 'a maximum nem összeadódik, hanem a nagyobb marad')
  })

  /*
   * A DUPLÁZÁS A ROSSZABB HIBA. A puffer a kiírás ELŐTT ürül ki: ha az írás
   * elhasal, a köteg elveszik — de nem íródik ki kétszer. Egy hiányzó köteg
   * csak pontatlan, egy duplázott hazudik.
   */
  it('a második kiírásnak nincs mit kiírnia', async () => {
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 1, ms: 10 }], NAP)
    assert.equal(await metrics.flush(), 1)
    assert.equal(await metrics.flush(), 0, 'kétszer írta ki ugyanazt a köteget')

    const r = await sor('ok')
    assert.equal(r?.attempts, 1, 'a számláló duplázódott')
  })

  /*
   * KÉT EGYIDEJŰ KIÍRÁS EGY KÖTEGET NEM ÍRHAT KI KÉTSZER.
   *
   * Ez az, amit a soros hívás NEM mér: ha a puffer a kiírás UTÁN ürülne, a
   * második hívás ugyanazt a köteget olvasná ki, amíg az első még az
   * adatbázisra vár — és a számláló duplázódna. Mérve: soros hívással a
   * hibás sorrend is „átment", ezért kell ez a teszt.
   */
  it('két egyidejű kiírás nem duplázza a köteget', async () => {
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 1, ms: 10 }], NAP)
    const [a, b] = await Promise.all([metrics.flush(), metrics.flush()])
    assert.equal(a + b, 1, `a köteg kétszer ment ki (${a} + ${b})`)

    const r = await sor('ok')
    assert.equal(r?.attempts, 1, 'a számláló duplázódott egyidejű kiírásnál')
  })

  it('a további kötegek HOZZÁADÓDNAK, nem felülírnak', async () => {
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 1, ms: 10 }], NAP)
    await metrics.flush()
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 1, ms: 30 }], NAP)
    await metrics.flush()

    const r = await sor('ok')
    assert.equal(r?.attempts, 2, 'a második köteg felülírta az elsőt')
    assert.equal(r?.latency_ms_max, 30)
  })

  it('a kimeneteket külön sorban tartja', async () => {
    metrics.recordAttempts([
      { provider: SLUG, outcome: 'ok', sources: 1, ms: 10 },
      { provider: SLUG, outcome: 'error', sources: 0, ms: 8000 },
      { provider: SLUG, outcome: 'skipped', sources: 0, ms: 0 }
    ], NAP)
    await metrics.flush()

    assert.equal((await sor('ok'))?.attempts, 1)
    assert.equal((await sor('error'))?.attempts, 1)
    assert.equal((await sor('skipped'))?.attempts, 1)
  })

  it('üres kísérletlistára nem csinál semmit', async () => {
    metrics.recordAttempts([], NAP)
    assert.equal(metrics.pending(), 0)
    assert.equal(await metrics.flush(), 0)
  })

  it('a hibás számokat nem engedi az adatbázisba', async () => {
    metrics.recordAttempts([
      { provider: SLUG, outcome: 'ok', sources: -5, ms: Number.NaN },
      { provider: SLUG, outcome: 'ok', sources: 2, ms: Number.POSITIVE_INFINITY }
    ], NAP)
    await metrics.flush()

    const r = await sor('ok')
    assert.equal(r?.attempts, 2)
    assert.equal(r?.sources, 2, 'negatív forrásszám bekerült')
    assert.equal(Number(r?.latency_ms_sum), 0, 'NaN/Infinity került a késleltetésbe')
  })

  it('a napokat elkülöníti', async () => {
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 1, ms: 10 }], new Date('2019-03-07T23:59:00Z'))
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 1, ms: 10 }], new Date('2019-03-08T00:01:00Z'))
    await metrics.flush()

    const napok = await db.query<{ day: Date }>(
      'SELECT day FROM provider_metrics_daily WHERE slug = $1 ORDER BY day', [SLUG])
    assert.equal(napok.length, 2, 'két különböző nap egy sorba került')
  })

  it('a reset eldobja a köteget, nem írja ki', async () => {
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', sources: 1, ms: 10 }], NAP)
    metrics.reset()
    assert.equal(metrics.pending(), 0)
    await metrics.flush()
    assert.equal(await sor('ok'), undefined)
  })
})

describe('a szolgáltatói panel olvasása', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>
  let pool: typeof import('../src/infrastructure/database/index.ts')['pool']
  let token: string

  before(async () => {
    const [{ buildApp }, dbm] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    await app.ready()
    pool = dbm.pool

    const nev = 'provmetrics' + Math.random().toString(36).slice(2, 8)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${nev}@example.com`, username: nev, password: 'Correct-Horse-Battery-9' }
    })
    token = res.json().accessToken ?? res.json().token
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
       ON CONFLICT DO NOTHING`, [nev])
    const auth = await import('../src/middleware/auth.ts')
    auth.invalidatePermissions()

    await pool.query('DELETE FROM provider_metrics_daily WHERE slug = $1', ['panel-teszt'])
    await pool.query(
      `INSERT INTO provider_metrics_daily (day, slug, outcome, attempts, sources, latency_ms_sum, latency_ms_max)
       VALUES (current_date, 'panel-teszt', 'ok',      8, 16, 800, 150),
              (current_date, 'panel-teszt', 'empty',   4,  0, 200,  70),
              (current_date, 'panel-teszt', 'error',   2,  0, 100,  60),
              (current_date, 'panel-teszt', 'timeout', 1,  0, 8000, 8000),
              (current_date, 'panel-teszt', 'skipped', 5,  0,   0,    0)`)
  })
  after(async () => {
    await pool?.query('DELETE FROM provider_metrics_daily WHERE slug = $1', ['panel-teszt'])
    await app?.close()
  })

  const hivas = async (url: string, fejlec = true) => await app.inject({
    method: 'GET', url, ...(fejlec ? { headers: { authorization: `Bearer ${token}` } } : {})
  })

  it('jogosultság nélkül nem ad adatot', async () => {
    assert.equal((await hivas('/v1/admin/analytics/providers', false)).statusCode, 401)
    assert.equal((await hivas('/v1/admin/analytics/system-health', false)).statusCode, 401)
  })

  it('összesít szolgáltatónként', async () => {
    const body = (await hivas('/v1/admin/analytics/providers?range=7d')).json()
    const sor = body.totals.find((t: { slug: string }) => t.slug === 'panel-teszt')
    assert.ok(sor, 'nincs sor a próbaszolgáltatóra')
    assert.equal(sor.attempts, 20)
    assert.equal(sor.ok, 8)
    assert.equal(sor.empty, 4)
    assert.equal(sor.errors, 2)
    assert.equal(sor.timeouts, 1)
    assert.equal(sor.skipped, 5)
  })

  /*
   * AZ ÁTLAG AZ ÖSSZEGBŐL. Nem napi átlagok átlagából: az egy forgalmas napot
   * ugyanannyit számítana, mint egy üreset. És a `skipped` kimarad belőle —
   * egy meg sem kérdezett szolgáltató nulla ezredmásodperce lehúzná az
   * átlagot, és gyorsabbnak látszana, mint amilyen.
   */
  it('az átlagos válaszidő a kérdezett kísérletekből számol', async () => {
    const body = (await hivas('/v1/admin/analytics/providers?range=7d')).json()
    const sor = body.totals.find((t: { slug: string }) => t.slug === 'panel-teszt')
    // (800 + 200 + 100 + 8000) / (8 + 4 + 2 + 1) = 9100 / 15 = 606.67 → 607
    assert.equal(sor.latency_avg, 607, 'a skipped is beleszámított, vagy napi átlagok átlaga')
    assert.equal(sor.latency_max, 8000)
  })

  it('napi bontást is ad a grafikonhoz', async () => {
    const body = (await hivas('/v1/admin/analytics/providers?range=7d')).json()
    const nap = body.days.find((d: { slug: string }) => d.slug === 'panel-teszt')
    assert.ok(nap, 'nincs napi sor')
    assert.equal(nap.attempts, 20)
    assert.equal(nap.failures, 3, 'a hiba+időtúllépés összege nem stimmel')
  })

  it('a rendszerállapot a kiszolgáló ellenőrzéseiből jön', async () => {
    const body = (await hivas('/v1/admin/analytics/system-health')).json()
    assert.ok(Array.isArray(body.services))
    assert.ok(body.services.length > 0, 'egyetlen komponens sincs')
    for (const s of body.services) {
      assert.equal(typeof s.service, 'string')
      assert.equal(typeof s.status, 'string')
    }
    assert.ok(Array.isArray(body.stale))
    assert.equal(typeof body.checkedAt, 'string')
  })

  /*
   * A `not_configured` NEM HIBA. Négy komponens áll így (redis, rabbitmq,
   * opensearch, minio): ezek szándékosan nincsenek bekapcsolva. Pirosra
   * festve a panel folyamatosan hibát jelezne egy működő rendszerre, és
   * onnantól senki nem nézné.
   */
  it('a be nem kapcsolt komponenst nem hibaként adja vissza', async () => {
    const body = (await hivas('/v1/admin/analytics/system-health')).json()
    const redis = body.services.find((s: { service: string }) => s.service === 'redis')
    if (redis) {
      assert.equal(redis.status, 'not_configured',
        'a be nem kapcsolt Redis más állapotot kapott — a panel hibát jelezne')
    }
  })
})
