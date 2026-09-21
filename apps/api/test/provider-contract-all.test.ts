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
   * KÉT ADAPTER NEM VISELHETI UGYANAZT AZ AZONOSÍTÓT. A regiszter `Map`-ben
   * tárol, tehát a második CSENDBEN felülírná az elsőt — a lista hosszabb
   * lenne, mint a tényleg meghívható adapterek száma.
   */
  it('egyedi azonosítót visel', () => {
    const idk = adapterek.map(a => a.id)
    assert.equal(new Set(idk).size, idk.length, 'ütköző azonosító: ' + idk.join(', '))
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
