// AZ ADMINFELÜLET TERHELÉSMÉRÉSE — a statisztikai végpontok.
//
//   k6 run tests/load/analytics.js -e VUS=10 -e DURATION=1m \
//        -e ADMIN_TOKEN=... -e LOAD_TEST_KEY=...
//
// MIÉRT KÜLÖN FORGATÓKÖNYV. A `main.js` azt méri, amit a LÁTOGATÓK csinálnak:
// böngészés, keresés, lejátszás. Az adminfelület teljesen más alakú terhelés —
// kevés egyidejű felhasználó, de mindegyik kérése ÖSSZESÍTŐ lekérdezés több
// tízezer soron. Egy vegyes mérésben ez elveszne: tíz admin kérése a látogatók
// tízezre mellett statisztikai zaj, miközben pont az a kérdés, hogy egy
// 90 napos kimutatás mennyi ideig fut.
//
// AMIT EZ MÉR, ÉS AMIT NEM. Azt méri, hogy a panel lekérdezései az ADOTT
// adatmennyiségen mennyi ideig futnak. Nem méri, mi lesz egy évnyi adaton —
// azt csak egy évnyi adat mérné meg, és becslést nem írunk jelentésbe.

import { call } from './lib/http.js'
import { DURATION, RAMP, VUS, summaryTrendStats, thresholds } from './lib/config.js'
import { summaryTo } from './lib/summary.js'
import { Trend } from 'k6/metrics'

/**
 * A TOKEN KÖRNYEZETBŐL JÖN, nem az adatállományból.
 *
 * Az adatállomány mérőfiókjai közönséges felhasználók: a statisztikai
 * végpontokra 403-at kapnának, és a mérés a jogosultság-ellenőrzés sebességét
 * mérné, nem a kimutatásokét. A jogosult tokent a futtató állítja elő
 * (`scripts/load/admin-token.mjs`).
 */
const ADMIN = { token: __ENV.ADMIN_TOKEN || '', username: 'load-admin' }

const lepes = {
  summary: new Trend('adm_summary', true),
  visitors: new Trend('adm_visitors', true),
  timeseries: new Trend('adm_timeseries', true),
  providers: new Trend('adm_providers', true),
  anime: new Trend('adm_anime', true),
  search: new Trend('adm_search', true),
  performance: new Trend('adm_performance', true),
  users: new Trend('adm_users', true),
  quality: new Trend('adm_quality', true),
  health: new Trend('adm_health', true),
  realtime: new Trend('adm_realtime', true)
}

export const options = {
  scenarios: {
    admin: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 }
      ],
      gracefulRampDown: '20s'
    }
  },
  thresholds: {
    ...thresholds,
    /*
     * AZ ADMINFELÜLETNEK MÁS A KÜSZÖBE, és ez nem engedmény. Egy
     * összesítő lekérdezés több tízezer soron dolgozik; egy üzemeltető
     * másodperces válaszidőt elvisel ott, ahol egy látogató nem. A
     * nagyságrend viszont számít: ami 3 másodperc fölé megy, az már nem
     * panel, hanem jelentésgenerálás.
     */
    http_req_duration: ['p(95)<3000', 'p(99)<6000'],
    adm_summary: ['p(95)<2000'],
    adm_timeseries: ['p(95)<2000'],
    adm_quality: ['p(95)<3000']
  },
  summaryTrendStats,
  insecureSkipTLSVerify: true,
  discardResponseBodies: false
}

/** A tartományok, amiket egy üzemeltető tényleg váltogat. */
const TARTOMANYOK = ['today', '7d', '30d', '90d']
const METRIKAK = ['sessions', 'page_views', 'registrations', 'searches']
const BONTASOK = ['day', 'week', 'month']

function veletlen (lista) {
  return lista[Math.floor(Math.random() * lista.length)]
}

export function setup () {
  if (!ADMIN.token) {
    throw new Error('Nincs ADMIN_TOKEN. Állítsd elő: node scripts/load/admin-token.mjs')
  }
  return {}
}

export default function () {
  const range = veletlen(TARTOMANYOK)

  /*
   * EGY PANELNYITÁS, AHOGY TÉNYLEG TÖRTÉNIK. Az üzemeltető megnyitja az
   * Áttekintést, majd fülről fülre lép. Nem véletlenszerű kérések sorozata:
   * a fülváltás EGY kérés, és a tartomány ugyanaz marad.
   */
  call({ method: 'GET', path: `/v1/admin/analytics/summary?range=${range}`, trend: lepes.summary, user: ADMIN, name: '/summary' })
  call({ method: 'GET', path: `/v1/admin/analytics/visitors?range=${range}`, trend: lepes.visitors, user: ADMIN, name: '/visitors' })
  call({
    method: 'GET',
    path: `/v1/admin/analytics/timeseries?range=${range}&metric=${veletlen(METRIKAK)}&granularity=${veletlen(BONTASOK)}`,
    trend: lepes.timeseries,
    user: ADMIN,
    name: '/timeseries'
  })
  call({ method: 'GET', path: `/v1/admin/analytics/anime?range=${range}&limit=50`, trend: lepes.anime, user: ADMIN, name: '/anime' })
  call({ method: 'GET', path: `/v1/admin/analytics/search?range=${range}`, trend: lepes.search, user: ADMIN, name: '/search' })
  call({ method: 'GET', path: `/v1/admin/analytics/performance?range=${range}`, trend: lepes.performance, user: ADMIN, name: '/performance' })
  call({ method: 'GET', path: `/v1/admin/analytics/providers?range=${range}`, trend: lepes.providers, user: ADMIN, name: '/providers' })
  call({ method: 'GET', path: `/v1/admin/analytics/users?range=${range}`, trend: lepes.users, user: ADMIN, name: '/users' })
  call({ method: 'GET', path: '/v1/admin/analytics/data-quality', trend: lepes.quality, user: ADMIN, name: '/data-quality' })
  call({ method: 'GET', path: '/v1/admin/analytics/system-health', trend: lepes.health, user: ADMIN, name: '/system-health' })
  // AZ ÉLŐ NÉZET AZ EGYETLEN, AMI NYERS TÁBLÁT OLVAS — szándékosan az utolsó
  // öt percet. Ha valahol szakad a lánc, az itt fog.
  call({ method: 'GET', path: '/v1/admin/analytics/realtime', trend: lepes.realtime, user: ADMIN, name: '/realtime' })
}

export function handleSummary (data) {
  return summaryTo(data)
}
