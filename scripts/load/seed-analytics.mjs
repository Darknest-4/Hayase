// Összesítő sorok a MÉRŐVEREM adatbázisába — a statisztikai terheléshez.
//
//   LOAD_DATABASE_URL=postgres://yume:<jelszó>@127.0.0.1:15433/yume \
//     node scripts/load/seed-analytics.mjs --days 365
//
// MIÉRT KELL. Az adminfelület minden lekérdezése ÖSSZESÍTŐ táblákon dolgozik.
// Üres összesítőn mérve minden végpont néhány ezredmásodperc, és a mérés
// annyit mondana: „gyors" — miközben semmit nem olvasott. Ami számít, az az,
// hogy egy 365 napos kimutatás mennyi ideig fut, amikor tényleg van 365 nap.
//
// EZ SZINTETIKUS ADAT, ÉS CSAK A MÉRŐVEREMBE MEGY. Nem éles szám, nem kerül
// jelentésbe, és a script kifejezetten megtagadja a futást bármilyen más
// adatbázison: a mérőverem portja 15433, és ami nem ott van, azt nem írjuk.
// Az éles rendszer összesítőit a worker tölti, valódi eseményekből.

import pg from 'pg'

const arg = (nev, alap) => {
  const i = process.argv.indexOf('--' + nev)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : alap
}

const DB = process.env.LOAD_DATABASE_URL
const NAPOK = Number(arg('days', '365'))
const CIMEK = Number(arg('anime', '400'))

if (!DB) {
  console.error('Nincs LOAD_DATABASE_URL.')
  process.exit(2)
}
if (!/:15433\//.test(DB)) {
  console.error('Ez nem a mérőverem adatbázisa. A mérőverem portja 15433 — ellenőrizd a címet.')
  process.exit(2)
}

const pool = new pg.Pool({ connectionString: DB, max: 4 })

/** Ismételhető álvéletlen: ugyanaz a vetés ugyanazt az adatot adja. */
let mag = 1234567
const rnd = () => {
  mag = (mag * 1103515245 + 12345) % 2147483648
  return mag / 2147483648
}
const kozott = (a, b) => Math.floor(a + rnd() * (b - a))

const napok = []
for (let i = NAPOK - 1; i >= 0; i--) {
  napok.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10))
}

console.log(`${NAPOK} nap, ${CIMEK} cím — a mérőverem adatbázisába`)

// ---- analytics_daily --------------------------------------------------------
{
  const ertekek = napok.map(nap => {
    const sessions = kozott(200, 3000)
    const visitors = Math.floor(sessions * 0.7)
    return [
      nap, sessions, visitors, Math.floor(sessions * 0.4), sessions - Math.floor(sessions * 0.4),
      Math.floor(visitors * 0.3), Math.floor(visitors * 0.7), sessions * kozott(3, 9),
      kozott(60, 900), Math.floor(sessions * 0.3), kozott(0, 40), kozott(50, 900),
      kozott(0, 30), kozott(100, 2000), kozott(0, 200), kozott(50, 800),
      kozott(20, 500), kozott(1000, 90000), kozott(0, 50), kozott(0, 30)
    ]
  })
  await pool.query(
    `INSERT INTO analytics_daily (day, sessions, visitors, authed_sessions, anon_sessions,
       new_visitors, returning_visitors, page_views, avg_duration_sec, bounce_sessions,
       registrations, logins, failed_logins, searches, zero_result_searches,
       episode_starts, episode_completions, watch_seconds, errors, not_found)
     SELECT * FROM unnest(
       $1::date[], $2::int[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[],
       $8::int[], $9::int[], $10::int[], $11::int[], $12::int[], $13::int[], $14::int[],
       $15::int[], $16::int[], $17::int[], $18::bigint[], $19::int[], $20::int[])
     ON CONFLICT (day) DO UPDATE SET sessions = excluded.sessions, visitors = excluded.visitors,
       page_views = excluded.page_views, searches = excluded.searches`,
    Array.from({ length: 20 }, (_, o) => ertekek.map(sor => sor[o])))
  console.log(`  analytics_daily: ${ertekek.length} sor`)
}

// ---- anime_stats_daily ------------------------------------------------------
{
  const { rows } = await pool.query('SELECT id FROM anime ORDER BY created_at LIMIT $1', [CIMEK])
  if (!rows.length) {
    console.log('  anime_stats_daily: nincs cím az adatbázisban, kihagyva')
  } else {
    let osszes = 0
    // Kötegenként egy nap: 365 × 400 sor egyetlen utasításban a paraméter-
    // korlátba futna.
    for (const nap of napok) {
      const ids = []; const views = []; const uniq = []; const starts = []
      const comp = []; const sec = []; const lib = []; const fav = []; const imp = []
      for (const r of rows) {
        const v = kozott(0, 400)
        ids.push(r.id); views.push(v); uniq.push(Math.floor(v * 0.6))
        starts.push(Math.floor(v * 0.4)); comp.push(Math.floor(v * 0.2))
        sec.push(v * kozott(60, 1400)); lib.push(kozott(0, 20)); fav.push(kozott(0, 10))
        imp.push(kozott(0, 100))
      }
      await pool.query(
        `INSERT INTO anime_stats_daily (day, anime_id, views, unique_viewers, episode_starts,
           episode_completions, watch_seconds, library_adds, favorites_added, search_impressions)
         SELECT $1::date, * FROM unnest($2::uuid[], $3::int[], $4::int[], $5::int[], $6::int[],
           $7::bigint[], $8::int[], $9::int[], $10::int[])
         ON CONFLICT (day, anime_id) DO UPDATE SET views = excluded.views`,
        [nap, ids, views, uniq, starts, comp, sec, lib, fav, imp])
      osszes += ids.length
    }
    console.log(`  anime_stats_daily: ${osszes} sor`)
  }
}

// ---- analytics_breakdown ----------------------------------------------------
{
  /*
   * A DIMENZIÓK NEVÉT A TÁBLA `CHECK` KÉNYSZERE ZÁRJA LE — és ezt megmérni
   * kellett, nem kitalálni: `device`, nem `device_class`; `referrer`, nem
   * `referrer_host`. Az első változatom mindkettőt elrontotta.
   */
  const dimenziok = [
    ['device', ['mobile', 'desktop', 'tablet', 'tv']],
    ['browser', ['Chrome', 'Safari', 'Firefox', 'Edge', 'Samsung Internet']],
    ['os', ['Android', 'iOS', 'Windows', 'macOS', 'Linux']],
    ['referrer', ['google.com', 'discord.com', 'reddit.com', '(közvetlen)']],
    ['entry_route', ['/', '/anime/:id', '/search', '/watch/:id']],
    ['country', ['HU', 'DE', 'AT', 'RO', 'SK', 'GB', 'US']]
  ]
  let osszes = 0
  for (const nap of napok) {
    for (const [dim, ertekek] of dimenziok) {
      // A tábla oszlopai: day, dimension, value, sessions, page_views.
      // „Látogató" oszlop NINCS benne — megmérve, nem feltételezve.
      const d = []; const k = []; const s = []; const p = []
      for (const ertek of ertekek) {
        d.push(dim); k.push(ertek); s.push(kozott(10, 900)); p.push(kozott(20, 4000))
      }
      await pool.query(
        `INSERT INTO analytics_breakdown (day, dimension, value, sessions, page_views)
         SELECT $1::date, * FROM unnest($2::text[], $3::text[], $4::int[], $5::int[])
         ON CONFLICT (day, dimension, value) DO UPDATE SET sessions = excluded.sessions`,
        [nap, d, k, s, p])
      osszes += d.length
    }
  }
  console.log(`  analytics_breakdown: ${osszes} sor`)
}

// ---- heti/havi --------------------------------------------------------------
{
  /*
   * A KÖRNYEZET ELŐBB, AZ IMPORT UTÁNA. Az adatbázis-kliens a BETÖLTÉSKOR
   * olvassa a `DATABASE_URL`-t; fordított sorrendben az alapértelmezett
   * (éles) címre próbálna csatlakozni — mérve: `ECONNREFUSED 127.0.0.1:5432`.
   */
  process.env.DATABASE_URL = DB
  const { rollupPeriods } = await import('../../apps/api/src/modules/analytics/rollup.ts')
  let n = 0
  for (const nap of napok) {
    // Hetente/havonta elég egyszer — de olcsóbb minden napra lefuttatni, mint
    // a határokat kiszámolni, és idempotens.
    if (n % 7 === 0) await rollupPeriods(nap)
    n++
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM analytics_periods')
  console.log(`  analytics_periods: ${rows[0].n} sor`)
}

await pool.end()
console.log('kész')
