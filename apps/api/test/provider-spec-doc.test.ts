// A specifikáció és a kód nem térhet szét.
//
// A `docs/architecture/provider-adapter-spec.md` konkrét SZÁMOKAT és
// MEZŐNEVEKET állít a Provider Core-ról: nyolc másodperces időkorlát, három
// hiba után kizárás, harminc másodperces türelmi idő, öt perces gyorsítótár,
// három szállítási forma, három változat.
//
// Egy dokumentáció, ami ezekben téved, rosszabb, mint a hiánya: az olvasó
// elhiszi. Ez a készlet a kódból olvassa ki ugyanezeket, és összeveti azzal,
// ami a dokumentumban áll.
//
// Amit NEM ellenőriz: a prózát. Ez nem helyettesíti az elolvasást — csak azt
// fogja meg, ha valaki átír egy konstanst, és a dokumentum ott marad.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const olvas = (ut: string): string =>
  readFileSync(new URL(ut, import.meta.url), 'utf8')

const doc = olvas('../../../docs/architecture/provider-adapter-spec.md')
const resolveSrc = olvas('../src/modules/providers/resolve.ts')
const healthSrc = olvas('../src/modules/providers/health.ts')
const typesSrc = olvas('../src/modules/providers/types.ts')
const indexSrc = olvas('../src/modules/providers/index.ts')

/**
 * Egy `const NEV = …` számértéke a forrásból.
 *
 * A SZORZATOT IS KI KELL SZÁMOLNI. Az első változatom csak `[0-9_]+`-ot
 * olvasott, és a `CACHE_MS = 5 * 60_000`-ből ötöt kapott, a
 * `MAX_COOLDOWN_MS = 10 * 60_000`-ből tízet — vagyis a teszt nem a kódot
 * mérte, hanem a leírásmódját. Aláhúzás ezresként megengedett.
 */
function konstans (src: string, nev: string): number {
  const m = new RegExp(`const ${nev} = ([0-9_]+)(?:\\s*\\*\\s*([0-9_]+))?`).exec(src)
  assert.ok(m, `nincs ilyen konstans a forrásban: ${nev}`)
  const szam = (v: string): number => Number(v.replace(/_/g, ''))
  return m[2] ? szam(m[1]!) * szam(m[2]) : szam(m[1]!)
}

describe('a provider-specifikáció', () => {
  it('a vizsgált fájlok megvannak', () => {
    // Enélkül minden alábbi állítás üres sztringen lenne igaz.
    assert.ok(doc.length > 3000, 'a dokumentum üres vagy elköltözött')
    assert.ok(resolveSrc.includes('resolveEpisode'))
  })

  it('a dokumentált időkorlát az, ami a kódban van', () => {
    const ms = konstans(resolveSrc, 'TIMEOUT_MS')
    assert.equal(ms, 8_000, 'a kód időkorlátja megváltozott')
    assert.match(doc, /8 másodperces korláttal|8 mp-en/,
      'a dokumentum nem a kódban lévő időkorlátot írja')
  })

  it('a dokumentált gyorsítótár-élettartam az, ami a kódban van', () => {
    assert.equal(konstans(resolveSrc, 'CACHE_MS'), 5 * 60_000)
    assert.match(doc, /\*\*5 perc\*\* \(`CACHE_MS`\)/)
  })

  it('a dokumentált megszakító-küszöbök azok, amik a kódban vannak', () => {
    assert.equal(konstans(healthSrc, 'TRIP_AFTER'), 3)
    assert.equal(konstans(healthSrc, 'BASE_COOLDOWN_MS'), 30_000)
    assert.equal(konstans(healthSrc, 'MAX_COOLDOWN_MS'), 10 * 60_000)
    assert.match(doc, /`TRIP_AFTER = 3`/)
    assert.match(doc, /`BASE_COOLDOWN_MS = 30_000`/)
    assert.match(doc, /`MAX_COOLDOWN_MS = 10 perc`/)
  })

  it('a szállítási formák és a változatok listája egyezik', () => {
    assert.match(typesSrc, /export type SourceKind = 'hls' \| 'dash' \| 'mp4'/)
    assert.match(typesSrc, /export type SourceVariant = 'sub' \| 'dub' \| 'raw'/)
    assert.match(doc, /\*\*három értéke létezik\*\*/)
  })

  /*
   * A dokumentum 0. pontja azt ÁLLÍTJA, hogy ezek a mezők NEM léteznek. Ha
   * valaki holnap bevezeti valamelyiket, a dokumentum ettől hazuggá válik —
   * és épp az a pont a legfontosabb benne, mert ott mondja meg, mire NE
   * építsen egy adapter.
   */
  it('amit a dokumentum hiányzónak mond, az tényleg hiányzik', () => {
    const nincsenek: Array<[string, RegExp]> = [
      ['ProviderCapabilities', /ProviderCapabilities/],
      ['healthCheck', /healthCheck\s*\(/],
      ['resolveSources', /resolveSources\s*\(/],
      ['referer mező', /^\s*referer\??:/m],
      ['origin mező', /^\s*origin\??:/m]
    ]
    for (const [nev, minta] of nincsenek) {
      assert.doesNotMatch(typesSrc, minta,
        `a(z) ${nev} megjelent a types.ts-ben — a specifikáció 0. pontja elavult`)
    }
  })

  it('a minta-adapter tényleg nincs a BUILT_IN listában', () => {
    // A dokumentum 17. pontja ezt ígéri; a minta `example.invalid` címeket ad.
    const tiszta = indexSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(tiszta, /mockProvider/)
  })

  it('a regisztrációhoz tényleg két fájl kell, ahogy a 15. pont írja', () => {
    // A `BUILT_IN` az egyetlen hely, ahol adapter bejelentkezik.
    assert.match(indexSrc, /const BUILT_IN = \[/)
    assert.match(doc, /Módosítandó fájlok egy új adapterhez — pontosan kettő/)
  })
})
