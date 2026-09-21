// A leképezők ÉLŐ ellenőrzése — valódi hálózattal.
//
// KÜLÖN FÁJL, ÉS KIHAGYHATÓ. Külső, ingyenes szolgáltatásoktól függ, amik
// bármikor lassulhatnak vagy leállhatnak; egy ilyen teszt nem buktathat el
// egy telepítést. Futtatás:
//
//     YUME_LIVE=1 node --experimental-strip-types --test test/mapping-live.test.ts
//
// AMIT MÉR, és amit a hamis válaszokkal dolgozó `mapping-resolver.test.ts`
// nem tud: hogy az endpointok MA is élnek, és hogy a válaszuk alakja
// megegyezik azzal, amire az adaptereket írtuk.
//
// ÉVADOK. A Shingeki no Kyojin azért jó próba, mert több évada van, és a
// címük majdnem azonos. Ha a leképezés évadonként KÜLÖNBÖZŐ azonosítót ad,
// akkor egy adapter nem fog rossz évadot lejátszani.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

const LIVE = process.env.YUME_LIVE === '1'

let arm: typeof import('../src/modules/providers/mapping/upstreams/arm.ts')
let malsync: typeof import('../src/modules/providers/mapping/upstreams/malsync.ts')
let types: typeof import('../src/modules/providers/mapping/types.ts')

before(async () => {
  arm = await import('../src/modules/providers/mapping/upstreams/arm.ts')
  malsync = await import('../src/modules/providers/mapping/upstreams/malsync.ts')
  types = await import('../src/modules/providers/mapping/types.ts')
})

/** Egy jelzés, hogy a hívás ne lógjon örökké. */
const jel = (ms = 15_000): AbortSignal => AbortSignal.timeout(ms)

describe('élő leképezés', { skip: LIVE ? false : 'YUME_LIVE=1 nélkül kihagyva' }, () => {
  it('az `arm` mind a négy azonosítót adja egy ismert címre', async () => {
    // Shingeki no Kyojin, 1. évad — AniList 16498.
    const r = await arm.armUpstream.lookup({ ...types.noIds(), anilistId: 16498 }, jel())
    assert.equal(r.anilistId, 16498)
    assert.equal(typeof r.malId, 'number')
    assert.equal(typeof r.kitsuId, 'number')
    assert.equal(typeof r.anidbId, 'number')
  })

  it('MAL-azonosítóból is megtalálja ugyanazt', async () => {
    const r = await arm.armUpstream.lookup({ ...types.noIds(), malId: 16498 }, jel())
    assert.equal(r.anilistId, 16498)
  })

  /*
   * EZ A LÉNYEG. Két évad, majdnem azonos címmel — ha a leképezés ugyanazt
   * adná, egy adapter rossz évadot játszana le, és senki nem venné észre.
   */
  it('a két évad KÜLÖNBÖZŐ azonosítót kap', async () => {
    const [elso, harmadik] = await Promise.all([
      arm.armUpstream.lookup({ ...types.noIds(), anilistId: 16498 }, jel()),
      arm.armUpstream.lookup({ ...types.noIds(), anilistId: 99147 }, jel())
    ])
    assert.notEqual(elso.anidbId, harmadik.anidbId, 'a két évad ugyanazt az AniDB-azonosítót kapta')
    assert.notEqual(elso.kitsuId, harmadik.kitsuId, 'a két évad ugyanazt a Kitsu-azonosítót kapta')
  })

  it('ismeretlen azonosítóra üres eredmény, nem kivétel', async () => {
    const r = await arm.armUpstream.lookup({ ...types.noIds(), anilistId: 999_999_999 }, jel())
    assert.deepEqual(r, types.noIds())
  })

  it('a `malsync` AniDB-azonosítót ad egy MAL-azonosítóra', async () => {
    const r = await malsync.malsyncUpstream.lookup({ ...types.noIds(), malId: 16498 }, jel())
    assert.equal(typeof r.anidbId, 'number')
  })

  it('a `malsync` ismeretlen azonosítóra üreset ad', async () => {
    const r = await malsync.malsyncUpstream.lookup({ ...types.noIds(), malId: 999_999_999 }, jel())
    assert.deepEqual(r, types.noIds())
  })
})
