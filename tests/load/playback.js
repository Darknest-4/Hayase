// A lejátszás mérése — külön, és szándékosan nem tölt le videót.
//
//   k6 run tests/load/playback.js -e VUS=100 -e DURATION=2m -e LOAD_TEST_KEY=...
//
// A leggyakoribb hiba ebben a mérésben az, hogy ezer VU elkezd letölteni egy
// videót, és az eredmény a hálózat sávszélessége lesz, nem az alkalmazásé. Ez
// két különböző szám, két különböző költséggel és két különböző megoldással:
//
//   ALKALMAZÁS-KAPACITÁS   hány néző indítását bírja el a kiszolgáló:
//                          forrásfeloldás, epizódadat, feliratok, fejezetek,
//                          haladásírás. Ez CPU és adatbázis.
//
//   VIDEÓ-SÁVSZÉLESSÉG     hány néző adatfolyamát bírja el a vezeték. Ez a
//                          hálózat, és ezen a telepítésen NEM is a miénk: a
//                          források külső szolgáltatóknál vannak, a videó nem
//                          ezen a gépen megy át.
//
// Ez a fájl az elsőt méri. A másodikat nem lehet innen megmérni, és úgy tenni,
// mintha lehetne, rosszabb, mint nem mérni.
//
// FONTOS, ÉS A JELENTÉSBE IS BEKERÜL: ezen a példányon jelenleg NULLA
// videóforrás van. A forrásfeloldás tehát üres listát ad — a lekérdezés
// költsége valódi és mérhető, a szolgáltatói válaszidő viszont nem létezik,
// mert nincs szolgáltató. A szkript ezt észreveszi és kiírja, nem pótolja
// kitalált számmal.

import { check, sleep } from 'k6'
import { SharedArray } from 'k6/data'
import { Counter, Trend } from 'k6/metrics'

import { DURATION, RAMP, THINK, VUS, summaryTrendStats } from './lib/config.js'
import { call, data } from './lib/http.js'
import { summaryTo } from './lib/summary.js'

const dataset = new SharedArray('dataset', () => [JSON.parse(open('./data/dataset.json'))])[0]

const resolve = new Trend('play_source_resolve_ms', true)
const subtitles = new Trend('play_subtitles_ms', true)
const skips = new Trend('play_skips_ms', true)
const startup = new Trend('play_startup_ms', true)
const progress = new Trend('play_progress_ms', true)

const withSource = new Counter('play_sources_found')
const withoutSource = new Counter('play_sources_empty')
const startFailures = new Counter('play_start_failed')

export const options = {
  scenarios: {
    viewers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '15s', target: 0 }
      ],
      gracefulRampDown: '20s'
    }
  },
  thresholds: {
    // A lejátszás indítása az a pillanat, amikor a néző a fekete képet nézi.
    play_startup_ms: ['p(95)<1500'],
    play_source_resolve_ms: ['p(95)<800'],
    yume_5xx: ['count<1'],
    yume_rate_limited: ['count<1']
  },
  summaryTrendStats
}

export default function () {
  const user = dataset.accounts[(__VU - 1) % dataset.accounts.length]
  const ep = dataset.episodes[Math.floor(Math.random() * dataset.episodes.length)]

  // ---- a lejátszás indítása ----
  // Ez négy hívás, és a néző mind a négyet megvárja, mielőtt kép lenne.
  const t0 = Date.now()

  const epRes = call({
    method: 'GET', path: `/v1/anime/${ep.animeId}/episodes?limit=50`,
    trend: startup, name: 'GET episodes (playback)'
  })

  const srcRes = call({
    method: 'GET', path: `/v1/anime/episodes/${ep.id}/sources`,
    trend: resolve, name: 'GET sources'
  })
  const sources = data(srcRes)
  if (sources.length) withSource.add(1); else withoutSource.add(1)

  call({
    method: 'GET', path: `/v1/anime/episodes/${ep.id}/subtitles`,
    trend: subtitles, name: 'GET subtitles', expect: [200, 204, 404]
  })
  call({
    method: 'GET', path: `/v1/anime/episodes/${ep.id}/skips`,
    trend: skips, name: 'GET skips', expect: [200, 204, 404]
  })

  startup.add(Date.now() - t0)
  const started = epRes.status === 200 && srcRes.status === 200
  if (!started) startFailures.add(1)
  check(null, { 'a lejátszás elindulhatott volna': () => started })

  // ---- nézés ----
  // Haladásírás fél percenként, ahogy a lejátszó küldi. NEM másodpercenként:
  // az olyan írási terhelést mérne, ami a termékben nem létezik.
  if (user?.profileId) {
    for (let i = 1; i <= 3; i++) {
      call({
        method: 'PATCH', path: `/v1/me/progress/${ep.id}`,
        trend: progress, user, name: 'PATCH progress (playback)',
        body: { positionSec: i * 30, durationSec: 1440 },
        expect: [200, 204]
      })
      sleep(30 * THINK)
    }
  } else {
    sleep(10 * THINK)
  }
}

export function handleSummary (result) {
  const found = result.metrics.play_sources_found?.values?.count ?? 0
  const empty = result.metrics.play_sources_empty?.values?.count ?? 0
  const note = found === 0
    ? 'MEGJEGYZÉS: egyetlen kért epizódhoz sem volt videóforrás (' + empty + ' üres feloldás).\n' +
      'A fenti számok az ALKALMAZÁS lejátszásindítási költségét mérik. A szolgáltatói\n' +
      'válaszidő és a videó sávszélessége NEM szerepel bennük, mert ezen a példányon\n' +
      'nincs forrás. Amint lesz, ezt a mérést meg kell ismételni.'
    : found + ' feloldás talált forrást, ' + empty + ' nem.'
  return summaryTo(result, note)
}
