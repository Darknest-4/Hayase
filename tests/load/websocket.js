// WebSocket-kapacitás — külön futás, külön kérdés.
//
//   k6 run tests/load/websocket.js -e VUS=250 -e DURATION=3m -e LOAD_TEST_KEY=...
//
// Miért nem a vegyes futás része: egy HTTP-kérés megszületik és meghal, egy
// socket ÉL. A HTTP-terhelést a kérés/mp írja le, a socketeket az egyidejű
// kapcsolatok száma — és ez a kettő teljesen más erőforrást fogyaszt. Egy
// nyitott socket alig CPU-t eszik, viszont memóriát és fájlleírót foglal,
// ameddig nyitva van. Együtt mérve a kettő elfedi egymást.
//
// Amit mérünk:
//   * a jegy megszerzésének ideje (ez sima HTTP, és adatbázisba ír),
//   * a kézfogás ideje (a kiszolgáló a felcsatlakozás UTÁN ellenőriz),
//   * hány kapcsolat épül fel egyáltalán,
//   * egy ping–pong körbefordulása terhelés alatt,
//   * hány kapcsolatot dob el a kiszolgáló magától.

import { check, sleep } from 'k6'
import { SharedArray } from 'k6/data'
import { Counter, Rate, Trend } from 'k6/metrics'
import ws from 'k6/ws'

import { BASE, DURATION, KEY, RAMP, VUS, summaryTrendStats } from './lib/config.js'
import { call } from './lib/http.js'
import { summaryTo } from './lib/summary.js'

const dataset = new SharedArray('dataset', () => [JSON.parse(open('./data/dataset.json'))])[0]

const ticketTime = new Trend('ws_ticket_ms', true)
const handshake = new Trend('ws_handshake_ms', true)
const roundTrip = new Trend('ws_pong_ms', true)
const opened = new Counter('ws_opened')
const refused = new Counter('ws_refused')
const droppedEarly = new Counter('ws_dropped_early')
const healthy = new Rate('ws_healthy')

export const options = {
  scenarios: {
    sockets: {
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
    ws_handshake_ms: ['p(95)<1500'],
    ws_pong_ms: ['p(95)<500'],
    ws_healthy: ['rate>0.99']
  },
  summaryTrendStats
}

/** Mennyi ideig tartsa nyitva egy VU a kapcsolatot, mielőtt újranyitja. */
const HOLD_SEC = Number(__ENV.WS_HOLD || '60')

export default function () {
  const user = dataset.accounts[(__VU - 1) % dataset.accounts.length]
  if (!user?.token) { refused.add(1); healthy.add(false); return }

  // A jegy egyszer használatos és 30 másodpercig él, tehát kapcsolatonként
  // egy — ez a HTTP-fele a socketnek, és bele is számít a terhelésbe.
  //
  // A közös `call()`-on át megy, nem nyers http.post-tal: a hozzáférési token
  // 15 percig él, és egy hosszabb mérés közepén enélkül minden jegykérés 401
  // lenne. Ott a 401-re frissítés és egy ismétlés van.
  const res = call({
    method: 'POST', path: '/v1/auth/ws-ticket', trend: ticketTime, user, name: 'POST /v1/auth/ws-ticket'
  })
  if (res.status !== 200) { refused.add(1); healthy.add(false); sleep(1); return }

  const ticket = res.json('ticket')
  const url = `${BASE.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`

  const started = Date.now()
  let sawHello = false
  let pings = 0
  // Az utolsó ping ideje SAJÁT változóban, nem a socket objektumra akasztva.
  // A k6 socketje Go-oldali objektum: idegen mezőt ráírni kivételt dob, az
  // pedig a hívó függvényben (az intervallum visszahívásában) csendben
  // félbeszakítja az iterációt — így minden kapcsolat pontosan az első
  // szívverésnél halt meg, és a mérés 10 másodperces munkameneteket mutatott
  // egy percesek helyett. Ez a hiba egy órán át úgy nézett ki, mintha a
  // kiszolgáló bontaná a socketeket.
  let lastPing = 0

  const r = ws.connect(url, { headers: KEY ? { 'x-yume-load-test': KEY } : {} }, socket => {
    socket.on('open', () => {
      handshake.add(Date.now() - started)
      opened.add(1)
    })

    socket.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      // A kiszolgáló a felcsatlakozás UTÁN ellenőrzi a jegyet, tehát az
      // „open" még nem jelent sikert. A `hello` igen.
      if (msg.type === 'hello') sawHello = true
      if (msg.type === 'pong' && lastPing) roundTrip.add(Date.now() - lastPing)
    })

    // Szívverés, ahogy egy kliens küldi. Nem sűrűbben: a socketen van
    // üzenetenkénti korlát, és azt megsérteni nem mérés, hanem hibakeresés.
    socket.setInterval(() => {
      lastPing = Date.now()
      socket.send(JSON.stringify({ type: 'ping' }))
      pings++
    }, 10000)

    socket.setTimeout(() => socket.close(), HOLD_SEC * 1000)

    socket.on('error', () => { healthy.add(false) })
  })

  const ok = r && r.status === 101
  if (!ok) refused.add(1)
  if (ok && !sawHello) droppedEarly.add(1)
  healthy.add(Boolean(ok && sawHello))
  check(null, {
    'a kapcsolat felépült': () => ok,
    'a kiszolgáló elfogadta a jegyet': () => sawHello,
    'a szívverés ment': () => pings > 0 || HOLD_SEC < 10
  })
}

export function handleSummary (result) {
  return summaryTo(result)
}
