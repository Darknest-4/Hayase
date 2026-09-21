// A kép-keresés kapcsolója — a gomb elrejtése önmagában NEM kikapcsolás.
//
// A funkció a BÖNGÉSZŐBŐL tölt fel egy külső szolgáltatásra
// (`api.trace.moe`), tehát nincs saját végpontunk, amit a kiszolgálón
// őrizhetnénk: itt a kliensoldali kapcsoló maga a kikapcsolás. Annál inkább
// számít, hogy tényleg kikapcsoljon MINDEN utat, ne csak a láthatót.
//
// A BEJELENTETT ÁLLAPOT: a `feature.image_search` alapból KI van kapcsolva az
// éles adatbázisban. A gomb ettől eltűnt — de a beillesztés- és
// ejtésfigyelők feltétel nélkül kerültek a dokumentumra, a kapcsoló pedig
// csak utánuk dőlt el. Aki a keresőlapon beillesztett egy képet a
// vágólapról, annak a képe attól még elment egy harmadik félhez.
//
// Ez a suite a FORRÁST nézi, nem a futást: a figyelők felkerülése és a
// kapcsoló sorrendje statikusan is eldönthető, és így a teszt nem függ attól,
// hogy egy csonkban működik-e a vágólap.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const forras = readFileSync(join(here, '../src/pages/search.js'), 'utf8')

describe('a kép-keresés kikapcsolása', () => {
  it('a kapcsoló a figyelők ELŐTT dől el', () => {
    const kapcsolo = forras.indexOf("featureOn('image_search')")
    const figyelo = forras.indexOf("addEventListener('paste'")
    assert.ok(kapcsolo > 0, 'a lap nem kérdezi meg a kapcsolót')
    assert.ok(figyelo > 0, 'nincs beillesztés-figyelő — elavult a teszt?')
    assert.ok(kapcsolo < figyelo,
      'a figyelők a kapcsoló eldőlése előtt kerülnek fel, tehát kikapcsolt funkció mellett is működnek')
  })

  it('a figyelők kapcsolóhoz kötve kerülnek fel', () => {
    // Az `if (imageOn) { ... }` blokkon belül kell lenniük — a nyers
    // `document.addEventListener('paste'` a blokkon kívül a hiba maga.
    const blokk = forras.match(/if \(imageOn\) \{([\s\S]*?)\n {4}\}/)
    assert.ok(blokk, 'nincs kapcsolóhoz kötött blokk a figyelők körül')
    for (const esemeny of ['paste', 'drop', 'dragover']) {
      assert.match(blokk[1], new RegExp(`addEventListener\\('${esemeny}'`),
        `a(z) ${esemeny} figyelő a kapcsolón kívül kerül fel`)
    }
  })

  /*
   * Egy névtelen `e => e.preventDefault()`-ot nem lehet leszedni: a
   * `removeEventListener` másik függvényt kapna. Minden keresőlap-látogatás
   * hagyott egyet a dokumentumon.
   */
  it('minden figyelő leszedhető, mert nevesítve van', () => {
    assert.doesNotMatch(forras, /addEventListener\('dragover', e => e\.preventDefault\(\)\)/,
      'névtelen dragover-figyelő — ezt sosem lehet leszedni')
    for (const esemeny of ['paste', 'drop', 'dragover']) {
      assert.match(forras, new RegExp(`removeEventListener\\('${esemeny}'`),
        `a(z) ${esemeny} figyelőt semmi nem szedi le`)
    }
  })
})
