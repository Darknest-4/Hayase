// Nulla forrás ≠ „egyik sem sikerült".
//
// A BEJELENTETT TÜNET: „Ezt a részt egyik elérhető forrásból sem sikerült
// lejátszani." — miközben a lejátszó EGYETLEN forrást sem kapott, tehát
// eggyel sem próbálkozott.
//
// A GYÖKÉROK: a `source-manager` UGYANAZT az eseményt küldi mindkét
// helyzetre —
//
//     if (!entries.length) { bus.emit(EV.SOURCES_EXHAUSTED, new PlayerError('NO_SOURCE')) }
//     …
//     bus.emit(EV.SOURCES_EXHAUSTED, err)        // mindegyik elbukott
//
// —, és az `episode-player` a hibát ELDOBTA, fix mondatot írva ki. A
// megkülönböztetéshez szükséges adat végig ott volt a `code` mezőben.
//
// MIÉRT SZÁMÍT. A két helyzetnek két oka van, és két külön hely, ahol keresni
// kell: egy lejátszási hiba a forrásnál van, a nulla forrás a katalógusnál
// vagy a szolgáltatóláncnál. Egy rossz mondat órákig küldi rossz irányba azt,
// aki a hibát keresi — ez pontosan meg is történt.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const forras = nev => readFileSync(join(here, '../src/features/player2/', nev), 'utf8')

const player = forras('watch/episode-player.js')
const manager = forras('engine/source-manager.js')
const hu = readFileSync(join(here, '../src/shared/i18n/hu.js'), 'utf8')

describe('a lejátszó hibaüzenete', () => {
  it('a nulla jelölt tényleg külön hibakódot kap', () => {
    // Ha ez megszűnne, a megkülönböztetésnek nem lenne mire épülnie.
    assert.match(manager, /if \(!entries\.length\)[\s\S]{0,120}PlayerError\('NO_SOURCE'\)/,
      'a `source-manager` már nem jelöli külön a nulla jelöltet')
  })

  it('a kezelő MEGNÉZI a hibakódot, nem dobja el', () => {
    const blokk = player.match(/SOURCES_EXHAUSTED[\s\S]{0,700}?\}\)\)/)
    assert.ok(blokk, 'nincs SOURCES_EXHAUSTED kezelő')
    assert.match(blokk[0], /NO_SOURCE/,
      'a kezelő fix mondatot ír ki, a hibakódtól függetlenül')
  })

  it('két különböző mondat van, nem egy', () => {
    const blokk = player.match(/SOURCES_EXHAUSTED[\s\S]{0,700}?\}\)\)/)[0]
    const uzenetek = [...blokk.matchAll(/T\('([^']+)'\)/g)].map(m => m[1])
    assert.equal(new Set(uzenetek).size, 2,
      'nem két külön üzenet: ' + JSON.stringify(uzenetek))
  })

  it('mindkét mondat le van fordítva magyarra', () => {
    const blokk = player.match(/SOURCES_EXHAUSTED[\s\S]{0,700}?\}\)\)/)[0]
    for (const [, kulcs] of blokk.matchAll(/T\('([^']+)'\)/g)) {
      assert.ok(hu.includes(`'${kulcs}'`),
        `nincs magyar fordítása: ${kulcs} — a néző angolul kapná`)
    }
  })

  /*
   * A nulla forrás üzenete NEM állíthatja, hogy próbálkoztunk. Ez a teszt a
   * SZÖVEGRE megy rá, mert pont a szöveg volt a hiba.
   */
  it('a nulla forrás üzenete nem beszél sikertelen próbálkozásról', () => {
    const magyar = hu.match(/'No playable source is available for this episode yet\.':\s*\n?\s*'([^']+)'/)
    assert.ok(magyar, 'nincs meg a nulla forrás magyar mondata')
    assert.doesNotMatch(magyar[1], /sikerült|próbál/i,
      'a mondat sikertelen lejátszást sugall, pedig egy próbálkozás sem volt: ' + magyar[1])
  })
})
