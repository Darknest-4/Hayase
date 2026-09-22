// Jogosult token a statisztikai terhelésméréshez.
//
//   node scripts/load/admin-token.mjs [--base http://127.0.0.1:4100]
//
// MIÉRT KELL KÜLÖN. Az adatállomány mérőfiókjai közönséges felhasználók: a
// statisztikai végpontokra 403-at kapnának, és a mérés a jogosultság-
// ellenőrzés sebességét mérné, nem a kimutatásokét.
//
// EZ A MÉRŐVEREM ADATBÁZISÁBA ÍR, NEM AZ ÉLESBE. A cím alapból a mérőverem
// (`127.0.0.1:4100`), és a szerepkört közvetlenül a mérőverem adatbázisán
// adjuk meg — ehhez a `LOAD_DATABASE_URL` kell. Éles adatbázison ez a script
// szándékosan nem fut le.

import pg from 'pg'

const arg = (nev, alap) => {
  const i = process.argv.indexOf('--' + nev)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : alap
}

const BASE = arg('base', process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:4100')
const DB = process.env.LOAD_DATABASE_URL

if (!DB) {
  console.error('Nincs LOAD_DATABASE_URL. Példa:')
  console.error('  LOAD_DATABASE_URL=postgres://yume:<jelszó>@127.0.0.1:15433/yume node scripts/load/admin-token.mjs')
  process.exit(2)
}

/*
 * AZ ÉLES ADATBÁZIS KIZÁRVA. Egy elgépelt cím különben admin szerepkört adna
 * egy mérőfióknak az éles rendszerben — és ez a script pont azt csinálja,
 * amit egy ilyen hiba a legdrágábbá tesz.
 *
 * A mérőverem adatbázisa a 15433-as porton ül (lásd docker-compose.load.yml);
 * ami nem ott van, az gyanús, és inkább megállunk.
 */
if (!/:15433\//.test(DB)) {
  console.error('Ez nem a mérőverem adatbázisa. A mérőverem portja 15433 — ellenőrizd a címet.')
  process.exit(2)
}

const felhasznalo = 'load_admin_' + Math.random().toString(36).slice(2, 8)
const jelszo = 'load-test-admin-password-9x'

const res = await fetch(`${BASE}/v1/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(process.env.LOAD_TEST_KEY ? { 'x-yume-load-test': process.env.LOAD_TEST_KEY } : {}) },
  body: JSON.stringify({ email: `${felhasznalo}@load.invalid`, username: felhasznalo, password: jelszo })
})
if (!res.ok) {
  console.error('A regisztráció nem sikerült:', res.status, (await res.text()).slice(0, 200))
  process.exit(1)
}
const { accessToken } = await res.json()

const pool = new pg.Pool({ connectionString: DB, max: 2 })
await pool.query(
  `INSERT INTO user_roles (user_id, role_id)
   SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
   ON CONFLICT DO NOTHING`, [felhasznalo])
await pool.end()

/*
 * A SZEREPKÖR GYORSÍTÓTÁRA. A kiszolgáló a jogosultságokat gyorsítótárazza;
 * egy frissen adott szerepkör a régi tokennel nem érvényesülne azonnal. A
 * mérés előtt ezért újra bejelentkezünk — az új token már a szerepkörrel jön.
 */
const ujra = await fetch(`${BASE}/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(process.env.LOAD_TEST_KEY ? { 'x-yume-load-test': process.env.LOAD_TEST_KEY } : {}) },
  body: JSON.stringify({ email: `${felhasznalo}@load.invalid`, password: jelszo })
})
const veglegesToken = ujra.ok ? (await ujra.json()).accessToken : accessToken

// Csak a token megy a kimenetre: a futtató ezt adja tovább a k6-nak.
process.stdout.write(veglegesToken)
