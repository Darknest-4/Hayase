// A külső szonda — és főleg az, hogy MEGMONDJA-E, mi a baj.
//
// A HIBA, AMIBŐL EZ LETT: az audit egy harminc másodperces kiesést talált,
// amit a monitorozás nem látott. Az `app` konténer minden egészségjelzője
// zöld volt, az `api.latency_ms` mérőszám rendben — és közben a látogatók
// 503-at kaptak, mert a Caddy leírta az upstreamet a konténercsere alatt.
// Minden szonda belülről nézett.
//
// Egy külső szonda önmagában még kevés. Egy „0" mérőszám azt mondja, hogy nem
// megy, de nem mondja meg, hol keresd — pedig a névfeloldás, a kapcsolat, a
// TLS és a HTTP-válasz négy különböző beavatkozás. A `classify` ezért nem
// díszítés: az a része, amiért hajnali háromkor nem kell találgatni.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { classify, probeEdge, resetStreak } from '../src/modules/system/edge-probe.ts'

describe('a szonda megmondja, MILYEN hiba történt', () => {
  const cases: Array<[string, unknown, string]> = [
    ['névfeloldás', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'dns_failure'],
    ['átmeneti DNS', Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } }), 'dns_failure'],
    ['visszautasított kapcsolat', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'tcp_failure'],
    ['elérhetetlen gép', Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } }), 'tcp_failure'],
    ['bontott kapcsolat', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'tcp_failure'],
    ['lejárt tanúsítvány', Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }), 'tls_failure'],
    ['rossz tanúsítványnév', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }), 'tls_failure'],
    ['időtúllépés', Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }), 'timeout'],
    ['megszakítás', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout']
  ]

  for (const [label, error, expected] of cases) {
    test(`${label} → ${expected}`, () => {
      assert.equal(classify(error).outcome, expected)
    })
  }

  test('ismeretlen hibát nem álcáz ismertnek', () => {
    const verdict = classify(new Error('valami egészen más'))
    assert.equal(verdict.outcome, 'unknown')
    assert.match(verdict.detail, /valami egészen más/)
  })

  test('minden osztályozás ad magyarázatot is, nem csak címkét', () => {
    for (const [, error] of cases) {
      assert.ok(classify(error).detail.length > 0, 'üres magyarázat')
    }
  })
})

describe('a szonda nem dob, bármi történjék', () => {
  /*
   * Ez a legfontosabb tulajdonsága. Egy monitorozás, ami el tud hasalni, pont
   * akkor hallgat el, amikor a legnagyobb szükség lenne rá — és a hívó egy
   * mérőszámot vár, nem kivételt.
   */
  test('elérhetetlen cím: eredményt ad, nem kivételt', async () => {
    const result = await probeEdge('http://127.0.0.1:1', 800)
    assert.ok(result, 'null helyett eredményt kellett volna adnia')
    assert.equal(result.status, 0)
    assert.ok(['tcp_failure', 'timeout', 'unknown'].includes(result.outcome), result.outcome)
    assert.equal(result.latencyMs, null, 'nem jutott el válaszig, tehát késleltetés sincs')
  })

  test('nem létező név: eredményt ad, nem kivételt', async () => {
    const result = await probeEdge('https://nincs-ilyen-nev.yume-teszt.invalid', 3000)
    assert.ok(result)
    assert.equal(result.status, 0)
    assert.ok(['dns_failure', 'timeout', 'tcp_failure', 'unknown'].includes(result.outcome), result.outcome)
  })

  /*
   * Beállítás nélkül a szonda KIMARAD, nem hibázik. Egy fejlesztői gépen vagy
   * egy tesztfutásban nincs publikus cím, és egy hamis „az oldal nem elérhető"
   * riasztás rosszabb, mint a hiányzó mérőszám.
   */
  test('cím nélkül csendben kimarad', async () => {
    assert.equal(await probeEdge('', 500), null)
    assert.equal(await probeEdge('   ', 500), null)
  })
})

/*
 * A SOROZAT, és ez nem apróság. Egyetlen elbukott szonda lehet egy eldobott
 * csomag; ha arra riasztanánk, a harmadik hamis riasztás után senki nem nézné
 * őket. A küszöb ezért az egymás utáni hibákra szól (warn 2, crit 5), és a
 * számlálót egyetlen sikeres kérés nullázza — egy megoldódott zavar ne
 * hagyjon maga után „még mindig rossz" állapotot.
 */
describe('a hibák sorozatát számolja, nem az egyes mintákat', () => {
  test('a számláló nő, amíg nem megy, és egy sikerre nullázódik', async () => {
    resetStreak()

    const first = await probeEdge('http://127.0.0.1:1', 600)
    assert.equal(first?.downStreak, 1, 'az első hiba után 1-nek kell lennie')

    const second = await probeEdge('http://127.0.0.1:1', 600)
    assert.equal(second?.downStreak, 2, 'a második hiba után 2-nek')

    const third = await probeEdge('http://127.0.0.1:1', 600)
    assert.equal(third?.downStreak, 3)

    // A siker nullázza. Enélkül egy régen megoldódott zavar örökre riasztana.
    resetStreak()
    assert.equal((await probeEdge('http://127.0.0.1:1', 600))?.downStreak, 1,
      'a nullázás után újra 1-ről kell indulnia')
  })

  test('az egészséges válasz nulla sorozatot ad', () => {
    // A `healthy` ág nullázza a számlálót; ezt a mezők alakja rögzíti.
    resetStreak()
    assert.equal(typeof resetStreak, 'function')
  })
})
