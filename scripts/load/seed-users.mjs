// A mérés adatállománya: valódi azonosítók és valódi fiókok.
//
// Két okból nem generált adat:
//
//   * egy nem létező azonosítóra kért oldal 404, és a 404 olcsó. Egy mérés,
//     ami a 404-es utat járja, gyorsabb számokat ad, mint a termék;
//   * a keresés tényleg keres. Véletlen betűsorra nincs találat, és a
//     találat nélküli keresés más utat jár be (a trigram-ág be sem indul),
//     mint az, amire a felhasználók rákeresnek.
//
// A fiókok a mérőverem adatbázisában jönnek létre, nem az élesben. A vetés
// idempotens: ha a fiók már megvan, bejelentkezik.
//
//   node scripts/load/seed-users.mjs [--users 200]

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'tests', 'load', 'data', 'dataset.json')

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const BASE = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:4100'
const DB = process.env.LOAD_DATABASE_URL ??
  `postgres://yume:${process.env.POSTGRES_PASSWORD ?? ''}@127.0.0.1:15433/yume`
const USERS = Number(arg('users', '200'))
const KEY = process.env.LOAD_TEST_KEY ?? ''

/**
 * A mérőfiókok jelszava.
 *
 * Bekerül az adatállományba, és ez szándékos: a frissítő token FOROG, tehát a
 * vetéskor kapott token egyetlen k6-futás után érvénytelen. A második
 * fokozattól kezdve minden bejelentkezett kérés 401 lenne, és az a
 * jelentésben úgy nézne ki, mintha a kiszolgáló hasalna el száz
 * felhasználónál. (Pontosan ez történt, kétszer.)
 *
 * Ezért a mérés újra be tud lépni — ahogy egy valódi felhasználó is tenné, ha
 * lejárt a munkamenete. A belépés drága (scrypt), és ez így is van rendjén:
 * az a terhelés a mérés része, nem kivétel alóla.
 *
 * Ez egy eldobható verem eldobható fiókjainak a jelszava. Az éles példányon
 * ilyen fiókok nincsenek.
 */
const PASSWORD = 'load-test-password-9x'

const headers = () => ({ 'content-type': 'application/json', ...(KEY ? { 'x-yume-load-test': KEY } : {}) })

async function main () {
  const pool = new pg.Pool({ connectionString: DB, max: 4 })

  console.log('== azonosítók az adatbázisból')

  // Címek, amiknek VAN epizódjuk: a folyamat epizódlistát és forrást is kér,
  // és egy epizód nélküli címen az a két lépés üres választ mér.
  const { rows: animeRows } = await pool.query(`
    SELECT a.id, a.canonical_title AS title, count(e.id) AS episodes
      FROM anime a JOIN episodes e ON e.anime_id = a.id AND e.visibility = 'public'
     WHERE a.visibility = 'public'
     GROUP BY a.id, a.canonical_title
     HAVING count(e.id) BETWEEN 1 AND 500
     ORDER BY a.popularity DESC NULLS LAST
     LIMIT 300`)

  // Epizódok ugyanezekhez, hogy a forrásfeloldás és a haladásírás valódi
  // sorokat érintsen.
  const { rows: epRows } = await pool.query(`
    SELECT e.id, e.anime_id, e.number
      FROM episodes e
     WHERE e.anime_id = ANY($1::uuid[]) AND e.visibility = 'public'
       AND e.number <= 3
     LIMIT 600`, [animeRows.map(r => r.id)])

  // Keresőkifejezések: valódi címek eleje. A felhasználó nem a teljes címet
  // gépeli be, hanem az első pár szót — és a rangsorolás épp ezen dolgozik.
  const { rows: termRows } = await pool.query(`
    SELECT canonical_title AS title FROM anime
     WHERE visibility = 'public' AND canonical_title IS NOT NULL AND length(canonical_title) > 6
     ORDER BY popularity DESC NULLS LAST LIMIT 120`)
  const terms = [...new Set(termRows.map(r => r.title.split(/[\s:]+/).slice(0, 2).join(' ')).filter(t => t.length >= 3))]

  // Műfajok a szűrt böngészéshez.
  // A böngészés a műfaj SLUG-jával szűr, nem a nevével.
  const { rows: genreRows } = await pool.query(`
    SELECT g.slug AS g FROM genres g
      JOIN anime_genres ag ON ag.genre_id = g.id
     GROUP BY g.slug HAVING count(*) > 50 LIMIT 40`)

  console.log(`   ${animeRows.length} cím · ${epRows.length} epizód · ${terms.length} keresés · ${genreRows.length} műfaj`)

  console.log(`== ${USERS} fiók a mérőveremben`)
  const accounts = []
  let made = 0
  let reused = 0
  for (let i = 0; i < USERS; i++) {
    const username = `lt_${String(i).padStart(4, '0')}`
    const body = { email: `${username}@load.invalid`, username, password: PASSWORD }

    let res = await fetch(`${BASE}/v1/auth/register`, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
    if (res.status === 409) {
      res = await fetch(`${BASE}/v1/auth/login`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ identifier: username, password: body.password })
      })
      reused++
    } else if (res.ok) made++

    if (!res.ok) {
      console.error(`   ${username}: ${res.status} ${(await res.text()).slice(0, 120)}`)
      continue
    }
    // A frissítő tokent is eltesszük. A hozzáférési token 15 percig él, egy
    // nyolc fokozatos mérés viszont fél óránál is hosszabb — enélkül a futás
    // közepén minden bejelentkezett kérés 401-et kapna, és az úgy nézne ki,
    // mintha a kiszolgáló hasalna el 25 felhasználónál. (Pontosan ez történt
    // az első éles futáskor.)
    const { accessToken, refreshToken } = await res.json()

    // A könyvtár, a kedvencek és a haladás profil nevében történnek, és a
    // profilazonosító fejlécben utazik — enélkül minden ilyen kérés 400.
    const me = await fetch(`${BASE}/v1/profiles/me`, { headers: { authorization: `Bearer ${accessToken}`, ...headers() } })
    if (!me.ok) { console.error(`   ${username}: profil ${me.status}`); continue }
    const profile = await me.json()
    accounts.push({
      username,
      token: accessToken,
      refresh: refreshToken ?? null,
      password: PASSWORD,
      profileId: profile.id ?? profile.data?.id
    })

    if ((i + 1) % 50 === 0) process.stdout.write(`   ${i + 1}/${USERS}\r`)
  }
  console.log(`   ${accounts.length} fiók kész (${made} új, ${reused} meglévő)`)

  const missing = accounts.filter(a => !a.profileId).length
  if (missing) console.error(`   FIGYELEM: ${missing} fióknak nincs profilazonosítója — az írási lépések el fognak hasalni`)

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    base: BASE,
    password: PASSWORD,
    anime: animeRows.map(r => ({ id: r.id, episodes: Number(r.episodes) })),
    episodes: epRows.map(r => ({ id: r.id, animeId: r.anime_id, number: Number(r.number) })),
    terms: terms.slice(0, 80),
    genres: genreRows.map(r => r.g).filter(Boolean),
    accounts
  }, null, 0))
  console.log(`== ${OUT}`)

  await pool.end()
}

await main()
