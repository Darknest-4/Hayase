// Egy ismeretlen cím MINDEN lapon ugyanazt mondja.
//
// A BEJELENTETT TÜNET: egy elrontott `#/watch/…` címre a látogató ezt kapta
// üzenetként:
//
//     Cannot read properties of null (reading 'episodes')
//
// Éles oldalon lemérve. Egy elavult könyvjelző, egy törölt cím vagy egy
// elgépelt link mind ide fut.
//
// A GYÖKÉROK: a `Catalogue.media()` egy ismeretlen azonosítóra `null`-t AD
// VISSZA, nem dob — a forrásában ki is van mondva, hogy „a uuid-nek nincs
// hová mennie". A lapok `try/catch`-e tehát nem fogja meg, és a következő sor
// a `null`-on dolgozik tovább.
//
// A RÉSZLETOLDAL EZT MÁR TUDTA: ugyanez a hívás, ugyanez a `null`, és ott áll
// mellette egy `if (!media)`. A lejátszóoldalon nem. Ugyanaz a kérdés, két
// külön válasz — pontosan az a fajta széttartás, ami miatt ez a készlet van.
//
// A FORRÁST nézi, nem a futást: mindkét lap hosszú, aszinkron és sok
// hálózatot hív, a kérdés viszont statikusan is eldönthető — van-e őr a hívás
// és a használat KÖZÖTT.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/**
 * A lap forrása, MEGJEGYZÉSEK NÉLKÜL.
 *
 * Enélkül a saját magyarázó megjegyzésem is találat volt: leírtam benne, hogy
 * „a részletoldalon ott áll mellette egy `if (!media)`", és a statikus
 * kereséstől ez éppolyan `if (!media)`-nak látszott, mint a valódi őr. A teszt
 * ettől zölden jelentett egy kivett védelmet.
 */
const forras = nev => readFileSync(join(here, '../src/pages/', nev), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** Minden lap, ami a katalógusból kér egy címet. */
const LAPOK = ['anime.js', 'watch.js']

describe('egy ismeretlen cím', () => {
  it('a vizsgált lapok tényleg hívják a katalógust', () => {
    // Enélkül a lenti állítások egy nem létező hívásra lennének igazak.
    for (const lap of LAPOK) {
      assert.match(forras(lap), /Catalogue\.media\(/, `${lap} nem hívja a katalógust — elavult a lista?`)
    }
  })

  it('minden lapon van őr a hívás és a használat között', () => {
    for (const lap of LAPOK) {
      const s = forras(lap)
      const hivas = s.indexOf('Catalogue.media(')
      const or = s.indexOf('if (!media)')
      assert.ok(or > 0, `${lap}: nincs null-őr a katalógushívás után`)
      assert.ok(or > hivas, `${lap}: az őr a hívás ELŐTT áll`)
    }
  })

  it('mindkét lap ugyanazt mondja', () => {
    for (const lap of LAPOK) {
      assert.match(forras(lap), /Anime not found\./,
        `${lap} más szöveggel felel ugyanarra a helyzetre`)
    }
  })
})
