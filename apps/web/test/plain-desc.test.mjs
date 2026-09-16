// A leírásból szöveg lesz, nem kód.
//
// `U.plainDesc` egy `div.innerHTML = leiras`-sal tisztított, aztán
// `textContent`-et olvasott. Leváló elem, tehát ártalmatlannak látszott.
//
// Nem az: egy leváló elembe illesztett `<img src=x onerror=…>` mindhárom
// böngészőmotorban lefut — Chromiumban, WebKitben és Firefoxban is
// megmértem —, mert a kép betöltése az elem létrejöttéhez kötődik, nem a
// dokumentumhoz.
//
// A leírás pedig nem a miénk: az importból jön, és az adminfelületen
// szerkeszthető. Egy katalógusmező tartalma tehát minden látogató
// böngészőjében futott volna: a főoldali kiemelésen, az adatlapon és a
// gyorsnézeten.
//
// Ez a fájl a szövegtisztítás *eredményét* rögzíti. Hogy a nyelő inert-e, azt
// böngészőben kell megmérni — lásd tests/e2e/xss.test.mjs.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { install } from './support/browser.mjs'

install()
const { U } = await import('../src/shared/lib/dom.js')

describe('plainDesc', () => {
  it('keeps the text', () => {
    assert.equal(U.plainDesc('Egy <b>leírás</b>.'), 'Egy leírás.')
  })

  it('turns a line break into a line break', () => {
    assert.equal(U.plainDesc('Első<br>Második'), 'Első\nMásodik')
    assert.equal(U.plainDesc('Első<br/>Második'), 'Első\nMásodik')
    assert.equal(U.plainDesc('Első<br />Második'), 'Első\nMásodik')
  })

  it('drops a script tag and its content entirely', () => {
    const out = U.plainDesc('Előtte<script>alert(1)</script>Utána')
    assert.ok(!out.includes('<'), out)
    assert.ok(!out.includes('alert'), 'a script body is markup, not prose: ' + out)
  })

  it('leaves no tag and no attribute behind', () => {
    const out = U.plainDesc('<img src=x onerror="alert(1)"><a href="javascript:alert(2)">link</a>')
    assert.ok(!/onerror|javascript:|<img|<a /i.test(out), out)
  })

  it('survives nothing at all', () => {
    assert.equal(U.plainDesc(null), '')
    assert.equal(U.plainDesc(undefined), '')
    assert.equal(U.plainDesc(''), '')
  })

  it('does not choke on a number or an object', () => {
    assert.equal(typeof U.plainDesc(42), 'string')
    assert.equal(typeof U.plainDesc({}), 'string')
  })
})
