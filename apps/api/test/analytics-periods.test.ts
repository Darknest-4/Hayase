// Heti/havi összesítő, percentilis és adatminőség.
//
// A KÉSZLET LEGFONTOSABB ÁLLÍTÁSA NEM EGY SZÁM, HANEM EGY NÉV. A heti
// „egyedi látogató" ebben a rendszerben NEM LÉTEZIK: a látogató kulcsa napi
// sóval képzett hash, tehát ugyanaz az ember holnap más kulcsot kap. Aki
// ilyenkor összeadja a napi egyedieket és „heti egyedi látogatónak" hívja,
// az a hízelgő irányba téved — és pont ezért nem veszi észre senki. Az
// oszlop neve ezért `visitor_days`, és ez a készlet ezt őrzi.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'analytics-periods-secret-long-enough-0123456789'

let rollup: typeof import('../src/modules/analytics/rollup.ts')
let metrics: typeof import('../src/modules/providers/metrics.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

/** Egy hétfő a múltban, hogy a hét- és hónaphatár kiszámítható legyen. */
const HETFO = '2026-03-02'
const SLUG = 'teszt-prov-' + randomBytes(3).toString('hex')

describe('a heti és havi összesítő', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    rollup = await import('../src/modules/analytics/rollup.ts')
    metrics = await import('../src/modules/providers/metrics.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })

  beforeEach(async () => {
    await db.query("DELETE FROM analytics_daily WHERE day BETWEEN '2026-03-01' AND '2026-03-31'")
    await db.query("DELETE FROM analytics_periods WHERE period_start BETWEEN '2026-02-01' AND '2026-03-31'")
    /*
     * MINDKÉT TÁBLA. A `flush()` a `provider_metrics_daily`-be IS ír, nem
     * csak az eloszlásba — és az ottmaradt sorok egy MÁSIK készlet
     * kérésszámát növelték meg (a szolgáltatói fül 187 helyett 190-et
     * mutatott). Ez a fajta szennyezés csak együttes futásnál jelentkezik,
     * és ott is csak néha.
     */
    await db.query('DELETE FROM provider_latency_daily WHERE slug = $1', [SLUG])
    await db.query('DELETE FROM provider_metrics_daily WHERE slug = $1', [SLUG])
    metrics.reset()
  })

  after(async () => {
    await db.query("DELETE FROM analytics_daily WHERE day BETWEEN '2026-03-01' AND '2026-03-31'")
    await db.query("DELETE FROM analytics_periods WHERE period_start BETWEEN '2026-02-01' AND '2026-03-31'")
    await db.query('DELETE FROM provider_latency_daily WHERE slug = $1', [SLUG])
    await db.query('DELETE FROM provider_metrics_daily WHERE slug = $1', [SLUG])
  })

  const nap = async (day: string, sessions: number, visitors: number, pageViews = 0) => {
    await db.query(
      `INSERT INTO analytics_daily (day, sessions, visitors, page_views)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (day) DO UPDATE SET sessions = excluded.sessions,
              visitors = excluded.visitors, page_views = excluded.page_views`,
      [day, sessions, visitors, pageViews])
  }

  const hetiSor = async () => await db.queryOne<{
    sessions: string, visitor_days: string, page_views: string, days_counted: number
  }>("SELECT * FROM analytics_periods WHERE period = 'week' AND period_start = $1", [HETFO])

  it('a hét hétfővel kezdődik, és csak a saját napjait veszi', async () => {
    // A HÉT HÉTFŐTŐL VASÁRNAPIG TART. Ezt először elrontottam a tesztben:
    // 2026-03-08 VASÁRNAP, tehát még EBBEN a hétben van, nem a következőben.
    // A kód jól számolt; az elvárás volt hibás.
    await nap('2026-03-01', 100, 100)   // vasárnap — az ELŐZŐ hét vége
    await nap(HETFO, 10, 7)             // hétfő — ez a hét kezdete
    await nap('2026-03-03', 5, 4)
    await nap('2026-03-08', 2, 2)       // vasárnap — még EZ a hét
    await nap('2026-03-09', 999, 999)   // a KÖVETKEZŐ hét hétfője
    await rollup.rollupPeriods('2026-03-04')

    const sor = await hetiSor()
    assert.equal(Number(sor?.sessions), 17, 'más hét napjai is beleszámítottak')
    assert.equal(sor?.days_counted, 3)
  })

  /*
   * A NEVE MONDJA MEG, MI. A napi egyediek összege jól definiált mérőszám
   * („látogatói napok"); ugyanez „heti egyedi látogató" címkével hazugság.
   */
  it('a látogatói napok a napi egyediek ÖSSZEGE', async () => {
    await nap(HETFO, 10, 7)
    await nap('2026-03-03', 5, 4)
    await rollup.rollupPeriods(HETFO)
    assert.equal(Number((await hetiSor())?.visitor_days), 11)
  })

  it('az oszlop neve nem ígér heti egyedi látogatót', async () => {
    const oszlopok = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'analytics_periods'")
    const nevek = oszlopok.map(o => o.column_name)
    assert.ok(nevek.includes('visitor_days'), 'nincs visitor_days oszlop')
    assert.ok(!nevek.includes('visitors'),
      'van egy „visitors" oszlop — a napi sóval képzett kulcsból heti egyedi látogató nem áll elő')
  })

  /*
   * IDEMPOTENS. Egy összesítő, amit kétszer futtatva mást ad, használhatatlan:
   * egy félbeszakadt futás után soha nem lehetne helyreállítani.
   */
  it('kétszer lefuttatva ugyanazt adja', async () => {
    await nap(HETFO, 10, 7, 40)
    await rollup.rollupPeriods(HETFO)
    const elso = await hetiSor()
    await rollup.rollupPeriods(HETFO)
    const masodik = await hetiSor()
    assert.deepEqual(
      { s: elso?.sessions, v: elso?.visitor_days, p: elso?.page_views },
      { s: masodik?.sessions, v: masodik?.visitor_days, p: masodik?.page_views },
      'a második futás megváltoztatta a számokat — nem idempotens')
  })

  it('a havi sor a teljes hónapot fogja', async () => {
    await nap('2026-03-01', 3, 3)
    await nap('2026-03-15', 4, 4)
    await nap('2026-03-31', 5, 5)
    await rollup.rollupPeriods('2026-03-15')
    const sor = await db.queryOne<{ sessions: string, days_counted: number }>(
      "SELECT * FROM analytics_periods WHERE period = 'month' AND period_start = '2026-03-01'")
    assert.equal(Number(sor?.sessions), 12)
    assert.equal(sor?.days_counted, 3)
  })

  /*
   * A `days_counted` NÉLKÜL EGY FOLYAMATBAN LÉVŐ HÉT VISSZAESÉSNEK LÁTSZIK.
   * A grafikon utolsó oszlopa mindig alacsonyabb — nem azért, mert kevesebben
   * jöttek, hanem mert még nincs vége a hétnek.
   */
  it('megmondja, hány napból állt össze', async () => {
    await nap(HETFO, 10, 7)
    await rollup.rollupPeriods(HETFO)
    assert.equal((await hetiSor())?.days_counted, 1)
  })
})

describe('a szolgáltatói percentilis', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    metrics = await import('../src/modules/providers/metrics.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })

  const vodor = (ms: number, count: number) => ({ bucket_ms: ms, count })

  it('a mediánt a vödör FELSŐ határaként adja', () => {
    // 100 mérés: 50 a 10 ms-os vödörben, 50 az 1000-esben.
    const b = [vodor(10, 50), vodor(1000, 50)]
    assert.equal(metrics.percentileFrom(b, 50), 10)
    assert.equal(metrics.percentileFrom(b, 51), 1000)
  })

  /*
   * A PERCENTILIS LÉNYEGE: a hosszú farok látszódjon. Ez az az eset, amit az
   * átlag elrejt — 99 gyors kérés és egy tízmásodperces ugyanazt az átlagot
   * adja, mint a közepesen lassú egyenletes.
   */
  it('a ritka lassú kérést a p99 megmutatja, az átlag nem', () => {
    const b = [vodor(100, 99), vodor(10_000, 1)]
    assert.equal(metrics.percentileFrom(b, 50), 100)
    assert.equal(metrics.percentileFrom(b, 95), 100)
    assert.equal(metrics.percentileFrom(b, 99), 100)
    assert.equal(metrics.percentileFrom(b, 100), 10_000)
  })

  it('mérés nélkül nem talál ki számot', () => {
    assert.equal(metrics.percentileFrom([], 95), null)
    assert.equal(metrics.percentileFrom([vodor(10, 0)], 95), null)
  })

  it('a vödrök sorrendje nem számít', () => {
    assert.equal(metrics.percentileFrom([vodor(1000, 50), vodor(10, 50)], 50), 10)
  })

  /*
   * A KIHAGYOTT KÍSÉRLET NEM MÉRÉS. A `skipped` azt jelenti, hogy meg sem
   * szólítottuk a szolgáltatót — a nulla ezredmásodperce nem a
   * gyorsaságáról szól, és a mediánt hazuggá tenné.
   */
  it('a kihagyott kísérlet nem kerül az eloszlásba', async () => {
    metrics.reset()
    metrics.recordAttempts([
      { provider: SLUG, outcome: 'skipped', ms: 0, sources: 0 },
      { provider: SLUG, outcome: 'ok', ms: 120, sources: 1 }
    ] as never)
    await metrics.flush()

    const sorok = await db.query<{ bucket_ms: number, count: string }>(
      'SELECT bucket_ms, count FROM provider_latency_daily WHERE slug = $1 ORDER BY bucket_ms', [SLUG])
    assert.equal(sorok.length, 1, `a kihagyott is bekerült: ${JSON.stringify(sorok)}`)
    assert.equal(sorok[0]!.bucket_ms, 250, 'rossz vödörbe került')
    assert.equal(Number(sorok[0]!.count), 1)
  })

  it('az ismételt kiírás összeadódik, nem felülír', async () => {
    metrics.reset()
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', ms: 30, sources: 1 }] as never)
    await metrics.flush()
    metrics.recordAttempts([{ provider: SLUG, outcome: 'ok', ms: 30, sources: 1 }] as never)
    await metrics.flush()
    const sor = await db.queryOne<{ count: string }>(
      'SELECT count FROM provider_latency_daily WHERE slug = $1 AND bucket_ms = 50', [SLUG])
    assert.equal(Number(sor?.count), 2)
  })

  after(async () => {
    metrics.reset()
    await db.query('DELETE FROM provider_latency_daily WHERE slug = $1', [SLUG])
    await db.query('DELETE FROM provider_metrics_daily WHERE slug = $1', [SLUG])
  })
})
