// A kérés, ahogy ez a mérés küldi.
//
// Minden HTTP-hívás ezen megy át, egy okból: a mérőszámok csak akkor
// összehasonlíthatók, ha ugyanaz a kéz írja mindet. Ez a burkoló
//
//   * ráteszi a mérés kulcsát (sebességkorlát-mentesség),
//   * eldönti, hogy a válasz hiba-e, és melyik fajta,
//   * a lépés saját trendjébe teszi az időt,
//   * és NEM dob. Egy elhasalt lépés a mérés adata, nem a mérés vége.

import { check } from 'k6'
import http from 'k6/http'

import { BASE, KEY, PASSWORD, failures, limited, statusClass, timeouts } from './config.js'

/*
 * Élő hozzáférési tokenek, VU-nként.
 *
 * A vetett token 15 percig él. Egy nyolc fokozatos mérés fél óránál hosszabb,
 * tehát a futás közepétől minden bejelentkezett kérés 401 lenne — és az a
 * jelentésben 10% hibaaránynak látszik 25 felhasználónál, mintha a kiszolgáló
 * hasalna el. Az első éles futás pontosan ezt mérte.
 *
 * Ezért: 401-re egyszer frissítünk és megismételjük. Ez az, amit egy valódi
 * kliens is csinál, tehát a frissítés terhelése is a mérés része — nem
 * kerüljük meg, hanem beleszámoljuk.
 */
const live = new Map()
const rotated = new Map()

/*
 * A frissítő token FOROG: minden csere újat ad, és a régit érvényteleníti. Az
 * újat viszont nem írhatjuk vissza a vetett adatállományba — a k6
 * SharedArray-ből minden VU befagyasztott másolatot lát, és az írás vagy
 * eldobódik, vagy hibát dob. Ezért itt tartjuk, VU-n belül.
 */
const refreshOf = (user) => rotated.get(user.username) ?? user.refresh

const base = (user) => ({
  ...(KEY ? { 'x-yume-load-test': KEY } : {}),
  ...(user?.token ? { authorization: `Bearer ${live.get(user.username) ?? user.token}` } : {}),
  ...(user?.profileId ? { 'x-profile-id': user.profileId } : {})
})

/**
 * Egy hívás.
 *
 * @param {object} o
 * @param {string} o.method   GET/POST/PATCH/PUT/DELETE
 * @param {string} o.path     /v1/… — a BASE elé kerül
 * @param {import('k6/metrics').Trend} o.trend  melyik lépés trendjébe menjen
 * @param {string} [o.name]   k6 URL-címke: az azonosítós utak egy sorban
 * @param {object} [o.user]   { token, profileId }
 * @param {object} [o.body]   JSON törzs
 * @param {number[]} [o.expect] elfogadott állapotkódok (alapból 200/204)
 */
export function call (o) {
  const params = {
    // A content-type CSAK akkor megy, ha van törzs. Fastify a beállított
    // JSON-fejlécet ígéretnek veszi: üres törzzsel 400-at ad, és a mérés
    // egy egész írási útra hibát írna oda, ahol a termék rendben van.
    headers: {
      ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...base(o.user)
    },
    // A k6 címkéje nélkül minden /v1/anime/<uuid> külön sor lenne az
    // összegzésben, és az összegzés használhatatlan.
    tags: { name: o.name || o.path },
    timeout: '30s'
  }
  const url = BASE + o.path
  let res = o.body === undefined
    ? http.request(o.method, url, null, params)
    : http.request(o.method, url, JSON.stringify(o.body), params)

  if (res.status === 401 && o.user) {
    const fresh = refreshToken(o.user) ?? signIn(o.user)
    if (fresh) {
      params.headers.authorization = `Bearer ${fresh}`
      res = o.body === undefined
        ? http.request(o.method, url, null, params)
        : http.request(o.method, url, JSON.stringify(o.body), params)
    }
  }

  if (o.trend) o.trend.add(res.timings.duration)

  const s = res.status
  if (s === 0) { statusClass.c0.add(1); timeouts.add(1) } else if (s < 300) statusClass.c2xx.add(1)
  else if (s < 400) statusClass.c3xx.add(1)
  else if (s < 500) { statusClass.c4xx.add(1); if (s === 429) limited.add(1) } else statusClass.c5xx.add(1)

  const ok = (o.expect || [200, 204]).includes(s)
  failures.add(!ok)
  check(res, { [`${o.name || o.path} rendben`]: () => ok })
  return res
}

/**
 * Új hozzáférési token a frissítővel.
 *
 * A frissítő token forog: minden csere újat ad, és a régi érvénytelen lesz.
 * Ezért a választ is el kell tenni, különben a második frissítés már egy
 * visszavont tokennel próbálkozna.
 */
function refreshToken (user) {
  const res = http.post(`${BASE}/v1/auth/refresh`, JSON.stringify({ refreshToken: refreshOf(user) }), {
    headers: { 'content-type': 'application/json', ...(KEY ? { 'x-yume-load-test': KEY } : {}) },
    tags: { name: 'POST /v1/auth/refresh' },
    timeout: '30s'
  })
  if (res.status !== 200) return null
  try {
    const body = res.json()
    if (body.refreshToken) rotated.set(user.username, body.refreshToken)
    live.set(user.username, body.accessToken)
    return body.accessToken
  } catch { return null }
}

/**
 * Újra bejelentkezés, ha a frissítő token is halott.
 *
 * Miért kell egyáltalán: a frissítő token FOROG, és minden k6-futás új
 * folyamat — a vetett token az előző fokozat után már érvénytelen. Enélkül a
 * második fokozattól minden bejelentkezett kérés 401, és a jelentés úgy néz
 * ki, mintha a kiszolgáló hasalna el.
 *
 * A belépés drága (scrypt), és ez rendben van: fiókonként legfeljebb egyszer
 * történik futásonként, és pont annyi terhelést jelent, amennyit egy valódi,
 * lejárt munkamenetű felhasználó okozna. Nem kivétel a mérés alól, hanem
 * része.
 */
function signIn (user) {
  if (!user.password && !PASSWORD) return null
  const res = http.post(`${BASE}/v1/auth/login`,
    JSON.stringify({ identifier: user.username, password: user.password ?? PASSWORD }), {
      headers: { 'content-type': 'application/json', ...(KEY ? { 'x-yume-load-test': KEY } : {}) },
      tags: { name: 'POST /v1/auth/login (re-auth)' },
      timeout: '30s'
    })
  if (res.status !== 200) return null
  try {
    const body = res.json()
    if (body.refreshToken) rotated.set(user.username, body.refreshToken)
    live.set(user.username, body.accessToken)
    return body.accessToken
  } catch { return null }
}

/** Egy JSON válasz `data` mezője, vagy üres tömb, ha bármi félresikerült. */
export function data (res) {
  if (res.status < 200 || res.status >= 300) return []
  try {
    const body = res.json()
    return Array.isArray(body) ? body : (body.data ?? [])
  } catch { return [] }
}
