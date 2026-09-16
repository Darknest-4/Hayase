// A feladatsor ébresztése: olcsó üresjárat ÉS gyors felvétel.
//
// A MÉRÉS, AMIBŐL EZ LETT. A lekérdező hurok másodpercenként 22,2-szer kérdezte
// meg, van-e munka, miközben három perc alatt 8 feladat futott le. Üresjárati
// visszalépéssel ez 3,4/mp-re esett — de a felvétel elromlott: húsz másodperc
// alatt egyetlen feladatot sem vettek fel, mert a sávok a visszalépés tetején
// aludtak.
//
// Ezért a visszalépés MELLÉ ébresztés kell. A `LISTEN`/`NOTIFY` a PostgreSQL
// saját eszköze — nem új infrastruktúra —, és a kettő együtt adja meg mindkettőt:
// az üresjárat nem kerül semmibe, a felvétel mégis ezredmásodperces.
//
// Ez a suite a MECHANIZMUST méri, nem az időzítést: hogy egy alvó sáv
// felébred-e, és hogy egy elveszett értesítés nem ragasztja-e be örökre.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { sleepUntilWork, wakeAll } from '../src/infrastructure/queue/wake.ts'

describe('az alvó sáv ébreszthető', () => {
  test('az ébresztés azonnal visszatér, nem várja ki az időt', async () => {
    const started = Date.now()
    const sleeping = sleepUntilWork(10_000)

    // Egy tick, hogy a sáv tényleg elaludjon, aztán ébresztés.
    await new Promise(resolve => setImmediate(resolve))
    wakeAll()

    await sleeping
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1_000,
      `az ébresztés után ${elapsed} ms-ig aludt — a jelzés nem ért célba`)
  })

  test('ébresztés nélkül kivárja az időt', async () => {
    const started = Date.now()
    await sleepUntilWork(120)
    assert.ok(Date.now() - started >= 100,
      'korábban tért vissza, mint a megadott idő')
  })

  /*
   * A BIZTONSÁGI HÁLÓ. Ha egy értesítés elveszik — szakadt kapcsolat, másik
   * példány —, a sáv nem ragadhat be: az időzítő akkor is lejár. Enélkül egy
   * elveszett `NOTIFY` a sort csendben leállítaná.
   */
  test('egy elveszett értesítés nem ragasztja be a sávot', async () => {
    const started = Date.now()
    await sleepUntilWork(150) // senki nem ébreszt
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 140 && elapsed < 3_000,
      `${elapsed} ms — az időzítőnek akkor is le kell járnia, ha értesítés nem jön`)
  })

  test('több alvó sávot egyszerre ébreszt', async () => {
    const started = Date.now()
    const all = Promise.all([sleepUntilWork(10_000), sleepUntilWork(10_000), sleepUntilWork(10_000)])
    await new Promise(resolve => setImmediate(resolve))
    wakeAll()
    await all
    assert.ok(Date.now() - started < 1_000, 'nem mindegyik sáv ébredt fel')
  })

  test('a felesleges ébresztés ártalmatlan', () => {
    assert.doesNotThrow(() => { wakeAll(); wakeAll(); wakeAll() },
      'ébresztés alvó nélkül kivételt dobott')
  })
})
