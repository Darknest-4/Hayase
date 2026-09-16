// A hét látogatótípus.
//
// Egy átlagos felhasználó nem létezik. Van, aki két perc alatt tíz címet nyit
// meg és egyikbe sem néz bele, és van, aki egy címet választ és negyven percig
// nem kér semmit. A kettő terhelése teljesen másképp néz ki, és egy mérés,
// ami csak az átlagot járja, egyikről sem mond semmit.
//
// Az arányok a vegyes futásban (main.js) állnak, nem itt.

import { sleep } from 'k6'

import { THINK, journeys } from './config.js'
import {
  addToLibrary, boot, browse, continueWatching, details, favorite, favorites,
  home, library, pick, schedule, search, sources, watch
} from './flows.js'

const think = (min, max) => sleep((min + Math.random() * (max - min)) * THINK)

/**
 * Névtelen látogató.
 *
 * A legnagyobb csoport egy nyilvános oldalon, és a legolcsóbb: nem ír, nincs
 * profilja, a válaszai gyorsíthatók. Ha EZ lassú, minden lassú.
 */
export function anonymous (ds) {
  boot()
  home()
  think(3, 9)
  browse(ds)
  think(4, 12)
  const a = pick(ds.anime)
  const eps = details(a.id)
  think(6, 18)
  if (eps.length) sources(pick(eps).id ?? pick(ds.episodes).id)
  journeys.add(1, { profile: 'anonymous' })
}

/**
 * Bejelentkezett, hétköznapi néző.
 *
 * Megnézi, hol tartott, folytatja, és közben ír. Ez a folyamat érinti a
 * legtöbb táblát egy menetben.
 */
export function viewer (ds, user) {
  boot()
  home()
  continueWatching(user)
  think(2, 6)
  const a = pick(ds.anime)
  const eps = details(a.id)
  think(4, 10)
  const ep = eps.length ? pick(eps) : pick(ds.episodes)
  sources(ep.id)
  addToLibrary(user, a.id)
  // Két perc nézés, fél percenként egy haladásíróssal — ez a termék valódi
  // írási üteme. Nem hosszabb: egy menetnek be kell férnie egy fokozatba,
  // különben a futás végén félbehagyott menetek maradnak, és azokból nem
  // lesz mérési pont.
  watch(user, ep, 2)
  library(user)
  journeys.add(1, { profile: 'viewer' })
}

/**
 * Sokat néző.
 *
 * Egymás után több epizód, alig nézelődéssel. A haladásírás és a
 * „következő epizód" út terhelése rajta látszik.
 */
export function heavyViewer (ds, user) {
  boot()
  continueWatching(user)
  const a = pick(ds.anime)
  const eps = details(a.id)
  const list = eps.length ? eps : ds.episodes.filter(e => e.animeId === a.id)
  // Két epizód egymás után, alig szünettel. Ez a profil az írási terhelésért
  // van, nem a hosszért: a lényeg, hogy a haladás sorai gyorsan követik
  // egymást ugyanarra a profilra.
  for (let i = 0; i < 2; i++) {
    const ep = list.length ? list[Math.min(i, list.length - 1)] : pick(ds.episodes)
    sources(ep.id)
    watch(user, ep, 1.5)
    think(1, 3)
  }
  favorite(user, a.id)
  journeys.add(1, { profile: 'heavy' })
}

/**
 * Keresgélő.
 *
 * Négy keresés egymás után, alig megnyitott találattal. A legdrágább profil
 * kérésenként: a keresés rangsorol, a javaslat trigramot használhat.
 */
export function searcher (ds) {
  boot()
  for (let i = 0; i < 4; i++) {
    const hits = search(ds)
    think(2, 5)
    if (hits.length && Math.random() < 0.5) {
      details(hits[0].id ?? pick(ds.anime).id)
      think(3, 8)
    }
  }
  journeys.add(1, { profile: 'searcher' })
}

/** Vegyes: nézelődik, keres, néz is egy keveset. A leghétköznapibb menet. */
export function mixed (ds, user) {
  boot()
  home()
  think(2, 5)
  search(ds)
  think(2, 6)
  browse(ds)
  const a = pick(ds.anime)
  const eps = details(a.id)
  think(3, 9)
  const ep = eps.length ? pick(eps) : pick(ds.episodes)
  sources(ep.id)
  if (user) {
    watch(user, ep, 1)
    favorites(user)
  }
  schedule()
  journeys.add(1, { profile: 'mixed' })
}

/** Csak olvasó, bejelentkezett: a saját oldalai, írás nélkül. */
export function lurker (ds, user) {
  boot()
  library(user)
  favorites(user)
  continueWatching(user)
  think(4, 10)
  details(pick(ds.anime).id)
  journeys.add(1, { profile: 'lurker' })
}
