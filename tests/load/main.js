// A vegyes terhelésmérés — ez a fő forgatókönyv.
//
//   k6 run tests/load/main.js -e VUS=100 -e DURATION=3m -e LOAD_TEST_KEY=...
//
// Egy futás EGY fokozat. A fokozatokat a scripts/load/run.sh futtatja végig
// (10 → 25 → 50 → 100 → 250 → 500 → 750 → 1000), mindegyiket külön, mert egy
// hosszú felfutásból nem derül ki, MELYIK szinten fordult meg valami: a
// percentilisek a teljes futásra összemosódnak.
//
// A küszöbök (lib/config.js) döntik el, hogy egy fokozat megfelelt-e. Nem
// megítéljük a számokat, hanem megmérjük — és a legmagasabb fokozat, ami
// ELBUKÁS NÉLKÜL végigment, az a mért kapacitás. Ami e fölött van, az becslés,
// és becslést nem írunk jelentésbe.

import { SharedArray } from 'k6/data'

import { DURATION, RAMP, VUS, summaryTrendStats, thresholds } from './lib/config.js'
import { summaryTo } from './lib/summary.js'
import { anonymous, heavyViewer, lurker, mixed, searcher, viewer } from './lib/profiles.js'

// Egyszer olvassuk be, és minden VU ugyanazt a memóriát látja. VU-nként
// beolvasva 1000 VU-nál a k6 maga lenne a szűk keresztmetszet.
const dataset = new SharedArray('dataset', () => [JSON.parse(open('./data/dataset.json'))])[0]

export const options = {
  scenarios: {
    mixed_traffic: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: DURATION, target: VUS },
        // Leszálló ág: enélkül a futás vége félbehagyott menetekkel zárul, és
        // azok hibaként látszanának.
        { duration: '15s', target: 0 }
      ],
      gracefulRampDown: '30s'
    }
  },
  thresholds,
  summaryTrendStats,
  // A mérőverem a hurokcímen ül, saját tanúsítvány nélkül.
  insecureSkipTLSVerify: true,
  // Egy VU egy böngésző: tartsa a kapcsolatot, ahogy az is tenné.
  noConnectionReuse: false,
  discardResponseBodies: false
}

/**
 * Az arányok.
 *
 * Nem találgatás: egy nyilvános katalógusoldalon a látogatók többsége nincs
 * bejelentkezve és nem is fog, a keresés a második leggyakoribb belépési pont,
 * és a sokat nézők kisebbség — de ők adják az írások javát. Ha a te
 * forgalmad más, ez az a hét szám, amit át kell írni.
 */
const MIX = [
  { weight: 40, run: (ds) => anonymous(ds), needsUser: false },
  { weight: 20, run: (ds, u) => viewer(ds, u), needsUser: true },
  { weight: 8, run: (ds, u) => heavyViewer(ds, u), needsUser: true },
  { weight: 15, run: (ds) => searcher(ds), needsUser: false },
  { weight: 12, run: (ds, u) => mixed(ds, u), needsUser: false },
  { weight: 5, run: (ds, u) => lurker(ds, u), needsUser: true }
]
const TOTAL = MIX.reduce((n, m) => n + m.weight, 0)

export function setup () {
  if (!dataset.accounts?.length) {
    throw new Error('Nincs vetett adatállomány. Futtasd: node scripts/load/seed-users.mjs')
  }
  return { accounts: dataset.accounts.length, anime: dataset.anime.length }
}

export default function () {
  // Minden VU a saját fiókját használja, körbeforgatva. Egy fiók több VU-n
  // osztozva ugyanazt a néhány sort írná, és a zárolási viselkedés nem a
  // termékét mutatná.
  const user = dataset.accounts[(__VU - 1) % dataset.accounts.length]

  let roll = Math.random() * TOTAL
  for (const entry of MIX) {
    roll -= entry.weight
    if (roll <= 0) {
      if (entry.needsUser && !user?.profileId) { anonymous(dataset); return }
      entry.run(dataset, user)
      return
    }
  }
  anonymous(dataset)
}

export function handleSummary (result) {
  return summaryTo(result)
}
