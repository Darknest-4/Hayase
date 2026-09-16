// A megőrzés: a nyers sorok elmennek, az összesítők maradnak.
//
// Ez a rendszer legkevésbé látható része, és a legkönnyebben elromló: a
// takarítás naponta egyszer fut, csendben, és ha nem csinál semmit, arról
// pontosan addig nem szerez tudomást senki, amíg valaki rá nem kérdez, miért
// van kétmillió sor egy táblában — vagy amíg egy adatkérésre kiderül, hogy
// másfél éve minden oldalletöltés megvan.
//
// Ezért kötjük ki, hogy TÉNYLEG töröl, és azt is, hogy MIT NEM töröl:
//
//   * az összesítők maradnak, mert nincs bennük személyes adat — számok egy
//     napra, nem sorok egy emberről. Ettől marad megválaszolható, hogy
//     „mennyien jártak itt tavaly" anélkül, hogy bárkiről tárolnánk bármit;
//   * a keresőkifejezésnél nem SOR tűnik el, csak a nyers szöveg: a
//     normalizált alak marad, tehát a „mire kerestek" kérdés megmarad, a „ki
//     mit gépelt be szó szerint" pedig elmúlik.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'retention-secret-long-enough-0123456789'

/*
 * Rövid megőrzés erre a futásra.
 *
 * A `rollup.ts` a környezetet a betöltésekor olvassa, tehát ezt az importok
 * ELŐTT kell beállítani. Azért kell egyáltalán, mert a nyers táblák havonta
 * particionáltak: egy 200 napos sort nem lehet beszúrni, mert nincs hozzá
 * partíció — a teszt tehát nem a valós 90 napot próbálja ki, hanem magát a
 * mechanizmust, egy két napos ablakkal.
 */
process.env.ANALYTICS_RAW_RETENTION_DAYS = '2'
process.env.ANALYTICS_SESSION_RETENTION_DAYS = '2'
process.env.ANALYTICS_SEARCH_RAW_DAYS = '2'

describe('retention actually removes things', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let rollup: typeof import('../src/modules/analytics/rollup.ts')
  const key = 'ret' + randomBytes(10).toString('hex')
  // Öt nap: túl a kétnapos ablakon, de a mostani hónap partíciójában.
  const oldDay = new Date(Date.now() - 5 * 86_400_000)

  before(async () => {
    const [db, r] = await Promise.all([
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/analytics/rollup.ts')
    ])
    pool = db.pool
    rollup = r
  })

  after(async () => {
    try {
      await pool.query('DELETE FROM page_views WHERE session_key LIKE $1', [key + '%'])
      await pool.query('DELETE FROM analytics_sessions WHERE visitor_key = $1', [key])
      await pool.query('DELETE FROM search_stats WHERE normalized = $1', [key])
      await pool.query('DELETE FROM analytics_daily WHERE day = $1', [oldDay.toISOString().slice(0, 10)])
    } finally {
      await pool.end()
    }
  })

  test('old raw rows go, and the rollup for the same day stays', async () => {
    const day = oldDay.toISOString().slice(0, 10)

    // Egy régi látogatás, nyersen és összesítve.
    await pool.query(
      `INSERT INTO analytics_sessions (session_key, visitor_key, started_at, last_seen_at, page_views)
       VALUES ($1, $2, $3, $3, 1)`,
      [key + ':1', key, oldDay])
    await pool.query(
      `INSERT INTO page_views (session_key, route, created_at) VALUES ($1, '/teszt', $2)`,
      [key + ':1', oldDay])
    await pool.query(
      `INSERT INTO analytics_daily (day, sessions, visitors, page_views)
       VALUES ($1, 1, 1, 1) ON CONFLICT (day) DO UPDATE SET sessions = 1`,
      [day])

    const removed = await rollup.pruneAnalytics()

    // A nyers sorok elmentek…
    const views = await pool.query('SELECT 1 FROM page_views WHERE session_key = $1', [key + ':1'])
    assert.equal(views.rowCount, 0, 'a megőrzési ablakon túli oldalletöltés megmaradt')
    const sessions = await pool.query('SELECT 1 FROM analytics_sessions WHERE visitor_key = $1', [key])
    assert.equal(sessions.rowCount, 0, 'a megőrzési ablakon túli munkamenet megmaradt')

    // …az összesítő viszont maradt. Ez a lényeg: a „mennyien jártak itt
    // tavaly" kérdés megválaszolható marad, miközben senkiről nem tárolunk
    // semmit egy éve.
    const daily = await pool.query('SELECT sessions FROM analytics_daily WHERE day = $1', [day])
    assert.equal(daily.rowCount, 1, 'a napi összesítőt is elvitte a takarítás')

    // És megmondja, mennyit vitt el — egy takarítás, ami csendben nem csinál
    // semmit, ugyanúgy néz ki, mint egy, ami dolgozik.
    assert.ok(Number(removed.page_views) >= 1, JSON.stringify(removed))
    assert.ok(Number(removed.analytics_sessions) >= 1, JSON.stringify(removed))
  })

  test('an old search keeps its shape and loses its wording', async () => {
    // A nyers keresőkifejezés személyes adat lehet: valaki a saját nevére
    // keres, vagy véletlenül beilleszti a vágólapját.
    await pool.query(
      `INSERT INTO search_stats (query, normalized, result_count, created_at)
       VALUES ($1, $2, 3, $3)`,
      ['Valaki Teljes Neve', key, new Date(Date.now() - 5 * 86_400_000)])

    await rollup.pruneAnalytics()

    const { rows } = await pool.query<{ query: string, normalized: string }>(
      'SELECT query, normalized FROM search_stats WHERE normalized = $1', [key])
    assert.equal(rows.length, 1, 'a sor eltűnt — a „mire kerestek" kérdés is vele')
    assert.equal(rows[0]!.query, '', 'a nyers keresőkifejezés megmaradt')
    assert.equal(rows[0]!.normalized, key, 'a normalizált alaknak maradnia kell')
  })

  test('a fresh row is not touched', async () => {
    // A másik oldal: a takarítás nem a táblát üríti, hanem a régi sorokat
    // viszi. Egy mai oldalletöltésnek maradnia kell.
    const fresh = key + ':ma'
    await pool.query(
      `INSERT INTO analytics_sessions (session_key, visitor_key, started_at, last_seen_at, page_views)
       VALUES ($1, $2, now(), now(), 1)`, [fresh, key])
    await pool.query(
      `INSERT INTO page_views (session_key, route, created_at) VALUES ($1, '/teszt', now())`, [fresh])

    await rollup.pruneAnalytics()

    const views = await pool.query('SELECT 1 FROM page_views WHERE session_key = $1', [fresh])
    assert.equal(views.rowCount, 1, 'a takarítás a mai sort is elvitte')
    await pool.query('DELETE FROM page_views WHERE session_key = $1', [fresh])
    await pool.query('DELETE FROM analytics_sessions WHERE session_key = $1', [fresh])
  })

  test('yesterday’s salt is gone, so yesterday’s key cannot be recomputed', async () => {
    // Ez az, amitől a látogatói kulcs visszafejthetetlen: a só két nap után
    // eltűnik. Ha megmaradna, a kulcs újraszámolható lenne egy adott címre, és
    // a pszeudonimizálás megszűnne.
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)
    await pool.query(
      "INSERT INTO analytics_salt (day, salt) VALUES ($1, 'regi-so') ON CONFLICT (day) DO NOTHING", [old])

    await rollup.pruneAnalytics()

    const { rows } = await pool.query('SELECT 1 FROM analytics_salt WHERE day = $1', [old])
    assert.equal(rows.length, 0, 'a tíz napos só megmaradt — a kulcs újraszámolható lenne')
  })
})
