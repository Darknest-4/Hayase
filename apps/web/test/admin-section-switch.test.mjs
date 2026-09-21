// Az adminpanel szekcióváltása — a visszatérő kezdőlap ellen.
//
// A BEJELENTETT TÜNET: az üzemeltető az Áttekintésen áll, átvált egy másik
// adminoldalra, és „egy idő után" ismét az Áttekintés felülete jelenik meg,
// pedig már máshol jár. A lap frissítése átmenetileg helyreteszi.
//
// A GYÖKÉROK. Három szekció — Áttekintés, Metaadatok, Infrastruktúra —
// `setInterval`-lal frissíti magát, és így védekezik a navigáció ellen:
//
//     if (!document.body.contains(content)) { clearInterval(state.timer); return }
//
// Az őr azt feltételezi, hogy a tartó a szekcióváltáskor kikerül a
// dokumentumból. A `select()` viszont MINDEN szekciónak ugyanazt az élő
// `body` elemet adta, és csak a gyerekeit cserélte — a `body` sosem került ki,
// tehát a feltétel soha nem lett igaz. Az időzítő ment tovább, és
// öt/harminc/`DASH_REFRESH_MS` másodpercenként rárajzolta a RÉGI szekció
// felületét arra, amit az üzemeltető épp nézett.
//
// A javítás: minden szekció saját tartót kap, tehát a váltás valódi
// leválasztás. Ez a suite azt méri, hogy a két feltevés — az őré és a
// `select()`-é — nem tud megint széttartani.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'pages', 'admin.js'), 'utf8')

describe('az adminpanel szekcióváltása', () => {
  /*
   * A `select()` nem adhatja át ugyanazt az elemet minden szekciónak: attól
   * lett az őr hatástalan.
   */
  it('minden szekció friss tartót kap, nem a közös törzset', () => {
    const select = source.slice(source.indexOf('const select = s =>'), source.indexOf('    select(state.section)'))
    assert.match(select, /body\.replaceChildren\(pane\)/,
      'a törzs tartalmát cserélni kevés — a tartónak kell kicserélődnie')
    assert.match(select, /this\[s\.render\]\(pane\)/,
      'a renderelő még mindig a közös törzset kapja')
    assert.doesNotMatch(select, /this\[s\.render\]\(body\)/)
  })

  /*
   * Az őr és a tartó együtt működik. Ha valaki később visszaírja a közös
   * törzset, ez a vizsgálat megmondja, MIÉRT nem szabad.
   */
  it('a magukat frissítő szekciók a tartójuk eltűnésére állítják le magukat', () => {
    /*
     * KOMMENTEK NÉLKÜL SZÁMOLUNK. A szabályt a kód mellett le is írjuk, és az
     * első változat a SAJÁT magyarázó kommentjét is őrnek számolta — négy őrt
     * talált három időzítőhöz, és emiatt bukott meg. Egy vizsgálat, ami arra
     * pirosodik, hogy leírtuk, mit csinálunk, használhatatlan.
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    const guards = code.match(/document\.body\.contains\(content\)/g) ?? []
    assert.ok(guards.length >= 3,
      `csak ${guards.length} szekció figyeli, hogy elnavigáltak-e róla`)

    // Minden `setInterval`-hoz tartozzon ilyen őr: egy időzítő, ami nem tudja,
    // mikor kell megállnia, örökre rárajzol a következő szekcióra.
    const timers = code.match(/setInterval\(/g) ?? []
    assert.equal(timers.length, guards.length,
      'van olyan időzítő a panelen, amelyik nem áll le navigációkor')
  })

  it('a tartónak van stílusa, tehát nem véletlenül került oda', () => {
    const css = readFileSync(join(here, '..', 'css', 'admin.css'), 'utf8')
    assert.match(css, /\.admin-pane\s*\{/)
  })
})
