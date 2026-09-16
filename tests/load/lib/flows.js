// A lépések, amikből egy látogatás áll.
//
// A cél nem az, hogy sok kérést küldjünk, hanem hogy azokat küldjük, amiket
// egy ember küldene, abban a sorrendben. Ez számít: a főoldal olcsó, a
// keresés drága, a részletek oldala hat külön hívás, a haladásírás pedig
// tranzakció. Egy „GET / ezerszer" mérés mindegyikről hallgat.
//
// A gondolkodási idők nem díszek. Nélkülük ugyanaz a VU-szám négyszer annyi
// kérést küld, és az eredmény a felhasználószámról mond valótlant.

import { sleep } from 'k6'

import { THINK, WRITES, journeys, step } from './config.js'
import { call, data } from './http.js'

const pick = arr => arr[Math.floor(Math.random() * arr.length)]
/** Gondolkodási idő: a megadott tartományból, a globális szorzóval. */
const think = (min, max) => sleep((min + Math.random() * (max - min)) * THINK)

// ---- olvasó lépések --------------------------------------------------------

/** Amit minden oldalbetöltés kér: a példány beállításai. */
export function boot () {
  call({ method: 'GET', path: '/v1/config', trend: step.config, name: 'GET /v1/config' })
}

/** A főoldal: kiemelt, felkapott, évad. Ez a legtöbb látogatás első képernyője. */
export function home () {
  call({ method: 'GET', path: '/v1/anime?sort=trending&limit=24', trend: step.home, name: 'GET /v1/anime (trending)' })
  call({ method: 'GET', path: '/v1/anime?sort=popularity&limit=24', trend: step.home, name: 'GET /v1/anime (popular)' })
}

/** Szűrt böngészés — a katalógus, ahogy valaki nézelődik benne. */
export function browse (ds) {
  const genre = pick(ds.genres)
  const sort = pick(['popularity', 'trending', 'score'])
  call({
    method: 'GET',
    path: `/v1/anime?genre=${encodeURIComponent(genre)}&sort=${sort}&limit=25`,
    trend: step.browse,
    name: 'GET /v1/anime (filtered)'
  })
}

/** Gépelés a keresőbe: két-három javaslatkérés, aztán a tényleges keresés. */
export function search (ds) {
  const term = pick(ds.terms)
  // A javaslat minden leütés után jön, de nem betűnként: a kliens késleltet.
  for (const len of [3, Math.max(4, Math.floor(term.length / 2)), term.length]) {
    call({
      method: 'GET',
      path: `/v1/anime/suggest?q=${encodeURIComponent(term.slice(0, len))}&limit=8`,
      trend: step.suggest,
      name: 'GET /v1/anime/suggest'
    })
    sleep(0.25 * THINK)
  }
  const res = call({
    method: 'GET',
    path: `/v1/anime/search?q=${encodeURIComponent(term)}&limit=25`,
    trend: step.search,
    name: 'GET /v1/anime/search'
  })
  return data(res)
}

/**
 * Egy cím oldala.
 *
 * Hat hívás, mert a kliens tényleg ennyit küld — a részletek, az epizódok, a
 * kapcsolatok, a szereplők, a stáb és az ajánlások külön végpontok. Aki ezt
 * egy hívásnak méri, a részletoldal terhelésének a hatodát méri.
 */
export function details (animeId) {
  call({ method: 'GET', path: `/v1/anime/${animeId}`, trend: step.details, name: 'GET /v1/anime/:id' })
  const eps = call({
    method: 'GET', path: `/v1/anime/${animeId}/episodes?limit=50`, trend: step.episodes, name: 'GET /v1/anime/:id/episodes'
  })
  call({ method: 'GET', path: `/v1/anime/${animeId}/relations`, trend: step.details, name: 'GET /v1/anime/:id/relations' })
  call({ method: 'GET', path: `/v1/anime/${animeId}/characters`, trend: step.details, name: 'GET /v1/anime/:id/characters' })
  call({ method: 'GET', path: `/v1/anime/${animeId}/recommendations`, trend: step.details, name: 'GET /v1/anime/:id/recommendations' })
  return data(eps)
}

/**
 * A lejátszás felől nézve: hol van forrás ehhez az epizódhoz?
 *
 * Ez az a hívás, ami eldönti, lesz-e egyáltalán kép. Ezen a példányon nulla
 * forrás van, tehát a válasz üres lista — de a LEKÉRDEZÉS ugyanannyiba kerül,
 * és épp azt mérjük.
 */
export function sources (episodeId) {
  return call({
    method: 'GET',
    path: `/v1/anime/episodes/${episodeId}/sources`,
    trend: step.sources,
    name: 'GET /v1/anime/episodes/:id/sources'
  })
}

/** A heti menetrend. */
export function schedule () {
  const from = new Date(Date.now() - 86400e3).toISOString()
  const to = new Date(Date.now() + 6 * 86400e3).toISOString()
  call({
    method: 'GET',
    path: `/v1/anime/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    trend: step.schedule,
    name: 'GET /v1/anime/schedule'
  })
}

// ---- bejelentkezett lépések ------------------------------------------------

export function library (user) {
  call({ method: 'GET', path: '/v1/me/library?limit=200', trend: step.library, user, name: 'GET /v1/me/library' })
}

export function favorites (user) {
  call({ method: 'GET', path: '/v1/me/favorites', trend: step.favorites, user, name: 'GET /v1/me/favorites' })
}

export function continueWatching (user) {
  call({
    method: 'GET', path: '/v1/me/continue-watching', trend: step.continueWatching, user, name: 'GET /v1/me/continue-watching'
  })
}

/**
 * Nézés — a haladás írása.
 *
 * Nem másodpercenként. A kliens is kötegel, és ezt a mérésnek is tartania
 * kell: egy másodpercenkénti ping olyan írási terhelést mérne, ami a
 * termékben nem létezik. Fél percenként egy PATCH, ahogy a lejátszó küldi.
 */
export function watch (user, episode, minutes) {
  if (!WRITES || !user.profileId) return
  const pings = Math.max(1, Math.round(minutes * 2))
  for (let i = 1; i <= pings; i++) {
    call({
      method: 'PATCH',
      path: `/v1/me/progress/${episode.id}`,
      trend: step.progress,
      user,
      name: 'PATCH /v1/me/progress/:id',
      body: { positionSec: i * 30, durationSec: 1440, completed: i === pings && minutes >= 20 },
      expect: [200, 204]
    })
    // Fél perc nézés, a szorzóval. Ez a mérés leghosszabb szünete, és
    // szándékosan az: nézés közben a felhasználó nem küld semmit.
    sleep(30 * THINK)
  }
}

export function addToLibrary (user, animeId) {
  if (!WRITES || !user.profileId) return
  call({
    method: 'PUT',
    path: `/v1/me/library/${animeId}`,
    trend: step.library,
    user,
    name: 'PUT /v1/me/library/:id',
    body: { status: 'WATCHING' },
    expect: [200, 201, 204]
  })
}

export function favorite (user, animeId) {
  if (!WRITES || !user.profileId) return
  call({
    method: 'PUT',
    path: `/v1/me/favorites/${animeId}`,
    trend: step.favorites,
    user,
    name: 'PUT /v1/me/favorites/:id',
    expect: [200, 201, 204]
  })
}

export { pick, think, journeys }
