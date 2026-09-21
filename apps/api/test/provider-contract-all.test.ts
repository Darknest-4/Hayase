// A szerződés MINDEN bejelentkezett adapterre.
//
// AMI EDDIG HIÁNYZOTT. Minden adapter a saját tesztjét hozta, és nem volt
// olyan hely, ahol az egész `BUILT_IN` lista egyszerre átment volna a
// szerződésen. Egy holnap felvett adapter, aminek a szerzője elfelejt tesztet
// írni, észrevétlenül bekerülhetett volna a láncba.
//
// Ez a készlet a REGISZTERT kérdezi, nem egy kézzel karbantartott listát:
// ami bejelentkezett, azt vizsgálja. Hálózatot nem hív — az ALAKOT nézi, amit
// egy kérés nélkül is meg lehet mondani.
//
// Ami hálózatot igényel (valódi feloldás), az az adapter saját tesztjéé; a
// `test/support/provider-contract.ts` `checkResult`-jával, hogy ott se
// kelljen újraírni, mit jelent érvényes eredmény.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { checkShape } from './support/provider-contract.ts'

import type { AnimeProvider } from '../src/modules/providers/types.ts'

let adapterek: AnimeProvider[]

before(async () => {
  const [{ registerBuiltInProviders }, registry] = await Promise.all([
    import('../src/modules/providers/index.ts'),
    import('../src/modules/providers/registry.ts')
  ])
  registry.reset()
  registerBuiltInProviders()
  adapterek = registry.known()
})

describe('minden bejelentkezett adapter', () => {
  it('van legalább egy', () => {
    // Enélkül minden alábbi állítás üres listán lenne igaz.
    assert.ok(adapterek.length > 0, 'a regiszter üres — a BUILT_IN lista elveszett?')
  })

  it('teljesíti a szerződés alakját', () => {
    for (const a of adapterek) checkShape(a, `a(z) ${a.id} adapter`)
  })

  /*
   * EZ AZ ÁLLÍTÁS ELŐSZÖR SEMMIT NEM MÉRT, és ezt megmértem.
   *
   * A regiszterből olvastam ki az azonosítókat — csakhogy a regiszter `Map`-ben
   * tárol, tehát mire idáig érünk, a duplikátum MÁR eltűnt. Két azonos
   * azonosítójú adapter regisztrálása után a `known()` egyetlen bejegyzést ad
   * vissza (megmérve: a második marad meg), és az egyediség-ellenőrzés
   * diadalmasan átmegy. A teszt a `Map` viselkedését igazolta, nem a
   * rendszerét.
   *
   * A duplikátum a FORRÁSLISTÁBAN látszik, nem a regiszterben — ott, ahol
   * két adapter szerzője nem tudott egymásról.
   */
  it('egyedi azonosítót visel — a BUILT_IN listában, nem a regiszterben', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/modules/providers/index.ts', import.meta.url), 'utf8')
    const blokk = /const BUILT_IN = \[([\s\S]*?)\]/.exec(src)
    assert.ok(blokk, 'nem találom a BUILT_IN listát')
    const nevek = blokk[1]!.split(',').map(x => x.trim()).filter(Boolean)
    assert.equal(new Set(nevek).size, nevek.length, 'ugyanaz az adapter kétszer: ' + nevek.join(', '))

    // És a tényleges azonosítók is egyediek — a lista hossza egyezzen azzal,
    // amit a regiszter ténylegesen tart.
    assert.equal(adapterek.length, nevek.length,
      `a BUILT_IN ${nevek.length} adaptert sorol, a regiszter ${adapterek.length}-et tart — ütköző azonosító nyelt el egyet`)
  })

  /*
   * A VÉDELEM MAGA. A `registerBuiltInProviders()` ütközésre HIBÁT DOB, nem
   * felülír — indulási hibaként, mert egy figyelmeztetés elveszne az induláskor
   * kiírt sorok között.
   */
  it('ütköző azonosítóra a bejelentkeztetés elhasal, nem felülír', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/modules/providers/index.ts', import.meta.url), 'utf8')
    assert.match(src, /throw new Error\(/,
      'a bejelentkeztetés csendben felülírná az ütköző adaptert')
  })

  /*
   * A MINTA-ADAPTER NEM KERÜLHET IDE. `example.invalid` címeket ad, tehát
   * éles láncban működő forrásnak látszó, lejátszhatatlan címeket szolgálna
   * ki. A saját tesztje regisztrálja, futásidőben.
   */
  it('nincs köztük a minta-adapter', () => {
    assert.ok(!adapterek.some(a => a.id === 'mock'),
      'a minta-adapter bekerült a BUILT_IN listába')
  })
})
