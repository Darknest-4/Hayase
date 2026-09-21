// Szolgáltatótól kapott címek ellenőrzése.
//
// EZ EGY BIZTONSÁGI HATÁR, és önállóan mérhető — hálózat nélkül. Amit ez a
// függvény átenged, azt a böngésző egy `iframe` `src`-jébe teszi: onnantól
// idegen kód fut a felhasználó lapján.
//
// A készlet a MŰKÖDŐ eseteket is méri, nem csak az elutasításokat. Egy
// ellenőrzés, ami mindent elutasít, hibátlanul teljesítene minden
// „utasítsa el" tesztet, és közben használhatatlan lenne.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { checkUpstreamUrl, safeUpstreamUrl } from '../src/modules/providers/upstream-url.ts'

const HOSTOK = ['megaplay.buzz', 'pelda.hu']

describe('a beágyazó cím ellenőrzése', () => {
  it('átengedi az engedélyezett gazdagépet https-en', () => {
    const cim = 'https://megaplay.buzz/stream/s-2/169846/sub'
    assert.equal(safeUpstreamUrl(cim, HOSTOK), cim)
  })

  it('átengedi az altartományt', () => {
    assert.ok(safeUpstreamUrl('https://cdn.megaplay.buzz/x', HOSTOK))
  })

  it('a lekérdezés és a horgony megmarad', () => {
    // Az idegen lejátszó ezekben hordozhatja a beállításait; egy
    // „megtisztított" cím néma hibát okozna.
    const cim = 'https://megaplay.buzz/stream/1?autoplay=1#t=30'
    assert.equal(safeUpstreamUrl(cim, HOSTOK), cim)
  })

  it('a gazdagép kis-nagybetűtől független', () => {
    assert.ok(safeUpstreamUrl('https://MegaPlay.Buzz/x', HOSTOK))
    assert.ok(safeUpstreamUrl('https://megaplay.buzz/x', ['MEGAPLAY.BUZZ']))
  })

  /*
   * A ZÁRÓ PONT („.") ÉRVÉNYES DNS-ALAK: a `megaplay.buzz.` ugyanaz a
   * gazdagép, de sztringként nem egyezik. Ha nem normalizálnánk, egy
   * működő cím elutasítást kapna — vagy fordítva, egy szűrő megkerülhető
   * lenne ezzel az egy karakterrel.
   */
  it('a záró pontot normalizálja', () => {
    assert.ok(safeUpstreamUrl('https://megaplay.buzz./x', HOSTOK))
  })

  describe('elutasítja', () => {
    const ROSSZ: Array<[string, unknown]> = [
      ['a javascript: sémát', 'javascript:alert(1)'],
      ['a data: sémát', 'data:text/html,<script>alert(1)</script>'],
      ['a blob: sémát', 'blob:https://megaplay.buzz/abc'],
      ['a file: sémát', 'file:///etc/passwd'],
      ['a sima http-t', 'http://megaplay.buzz/x'],
      ['a protokoll-relatív címet', '//megaplay.buzz/x'],
      ['a relatív utat', '/stream/1'],
      ['az idegen gazdagépet', 'https://tamado.hu/x'],
      ['az álcázott gazdagépet', 'https://gonoszmegaplay.buzz/x'],
      ['a gazdagép elé fűzött álcát', 'https://megaplay.buzz.tamado.hu/x'],
      ['a hitelesítő adatot a címben', 'https://a:b@megaplay.buzz/x'],
      ['a csak felhasználónevet', 'https://a@megaplay.buzz/x'],
      ['az üres sztringet', ''],
      ['a csupa szóközt', '   '],
      ['a nem sztringet', 12345],
      ['a null-t', null],
      ['az undefined-ot', undefined],
      ['az objektumot', { url: 'https://megaplay.buzz/x' }]
    ]

    for (const [nev, ertek] of ROSSZ) {
      it(nev, () => {
        assert.equal(safeUpstreamUrl(ertek, HOSTOK), null, `átengedte: ${String(ertek)}`)
      })
    }
  })

  it('üres engedélylistával semmit nem enged át', () => {
    assert.equal(safeUpstreamUrl('https://megaplay.buzz/x', []), null)
  })

  it('az üres és a hibás listaelemeket kihagyja, nem engedi át tőlük', () => {
    // Egy elgépelt beállítás (`"megaplay.buzz,,"`) ne váljon átjáróvá.
    assert.equal(safeUpstreamUrl('https://barmi.hu/x', ['', '  ', '.']), null)
  })

  it('a pontokkal kezdődő listaelem is működik (".pelda.hu")', () => {
    assert.ok(safeUpstreamUrl('https://a.pelda.hu/x', ['.pelda.hu']))
  })

  it('megmondja az elutasítás okát — a naplónak, nem a válasznak', () => {
    assert.match(String(checkUpstreamUrl('http://megaplay.buzz/x', HOSTOK).reason), /https/)
    assert.match(String(checkUpstreamUrl('https://tamado.hu/x', HOSTOK).reason), /gazdagép/)
    assert.equal(checkUpstreamUrl('https://megaplay.buzz/x', HOSTOK).reason, null)
  })
})
