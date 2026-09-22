// AnimeParadise — ÉLŐ ellenőrzés a valódi API-n.
//
// MIÉRT NEM ELÉG A MOCKOLT TESZT. A `provider-animeparadise.test.ts` azt
// méri, hogy az adapter helyesen viselkedik — hamis hálózattal, mert a
// hibaágakat (429, 5xx, hibás alak) másképp nem lehet kikényszeríteni. Amit
// az viszont SOHA nem bizonyít: hogy az upstream contract még áll, és hogy a
// visszaadott cím TÉNYLEG lejátszható.
//
// Ez a fájl pont azt méri. Nem azt nézi, hogy `kind === 'hls'` — azt a
// másik teszt is tudja —, hanem hogy a cím mögött valódi HLS manifeszt van,
// szegmensekkel, és hogy a böngésző CORS-ból is elérné.
//
// HARMADIK FÉLTŐL FÜGG. Ha a szolgáltató leáll vagy megváltoztatja az
// API-ját, ez a teszt elbukik — és ez a SZÁNDÉK: pontosan ezt kell
// megtudnunk, mielőtt a nézők tudják meg helyettünk.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

const CIM = 'Sousou no Frieren'
const ANILIST = 154587

let provider

describe('AnimeParadise élő szolgáltató', () => {
  before(async () => {
    ;({ animeparadiseProvider: provider } = await import(
      '../../apps/api/src/modules/providers/adapters/animeparadise.ts'
    ))
  })

  it('keres, és a találat a szolgáltató saját azonosítóját hozza', async () => {
    const r = await provider.search(CIM, { anilistId: ANILIST, year: 2023 })
    assert.ok(r.length > 0, 'nincs találat — az upstream keresés megváltozott')
    assert.equal(typeof r[0].id, 'string')
    assert.ok(r[0].id.length > 0)
    // Az API nem ad AniList-azonosítót, és nem találunk ki egyet.
    assert.equal(r[0].anilistId, null)
  })

  it('epizódlistát ad, valódi azonosítókkal és SZÁM sorszámmal', async () => {
    const [talalat] = await provider.search(CIM, { anilistId: ANILIST })
    const eps = await provider.episodes(talalat.id)
    assert.ok(eps.length > 0, 'nincs epizód — az upstream epizódvégpont megváltozott')
    assert.equal(typeof eps[0].number, 'number', 'a sorszám nem szám — a sztring→szám átalakítás elromlott')
    assert.ok(eps.some(e => e.number === 1), 'nincs első rész')
  })

  /**
   * A LÉNYEG: a visszaadott cím TÉNYLEG HLS.
   *
   * Nem a `kind` mezőt hisszük el, hanem lekérjük a címet, és megnézzük,
   * hogy a válasz `#EXTM3U`-val kezdődik, van benne rendition vagy
   * szegmens, és a típusa playlist.
   */
  it('a visszaadott cím valódi, betölthető HLS manifeszt', async () => {
    const r = await provider.resolve({
      anilistId: ANILIST,
      malId: null,
      kitsuId: null,
      anidbId: null,
      title: CIM,
      year: 2023,
      number: 1,
      variant: 'sub'
    })

    assert.equal(r.sources.length, 1, 'nem jött forrás az élő API-ból')
    const forras = r.sources[0]
    assert.equal(forras.kind, 'hls')
    assert.equal(forras.variant, 'sub')

    const res = await fetch(forras.url, { signal: AbortSignal.timeout(25_000) })
    assert.equal(res.status, 200, `a manifeszt nem tölthető: HTTP ${res.status}`)

    const tipus = String(res.headers.get('content-type') ?? '').toLowerCase()
    assert.ok(/mpegurl|octet-stream|text\/plain/.test(tipus), `nem playlist típus: ${tipus}`)

    const szoveg = await res.text()
    assert.ok(szoveg.startsWith('#EXTM3U'), `nem HLS manifeszt: ${szoveg.slice(0, 60)}`)
    assert.ok(/#EXT-X-STREAM-INF|#EXTINF/.test(szoveg),
      'a manifesztben se rendition, se szegmens — üres playlist')
  })

  /**
   * A BÖNGÉSZŐ IS ELÉRI. A lejátszás a néző böngészőjéből megy, `hls.js`-szel:
   * ha a CORS nem engedélyezett, a manifeszt kérése ott hasal el, nálunk
   * pedig végig minden rendben látszik.
   */
  it('a manifeszt CORS-ból is elérhető', async () => {
    const r = await provider.resolve({
      anilistId: ANILIST,
      malId: null,
      kitsuId: null,
      anidbId: null,
      title: CIM,
      year: 2023,
      number: 1,
      variant: 'sub'
    })
    const res = await fetch(r.sources[0].url, {
      headers: { origin: 'https://animehub.hu' },
      signal: AbortSignal.timeout(25_000)
    })
    assert.equal(res.headers.get('access-control-allow-origin'), '*',
      'a manifeszt nem engedi a cross-origin kérést — böngészőből nem játszható')
  })

  /**
   * A LÁNC VÉGIG JÁRHATÓ: master → variáns → szegmens.
   *
   * Egy master playlist önmagában még nem lejátszható videó. Ha a variáns
   * vagy a szegmens elhasal, a néző fekete képet kap, miközben a manifeszt
   * kérése 200-at adott.
   */
  it('a master playlisttől a szegmensig végigjárható', async () => {
    const r = await provider.resolve({
      anilistId: ANILIST,
      malId: null,
      kitsuId: null,
      anidbId: null,
      title: CIM,
      year: 2023,
      number: 1,
      variant: 'sub'
    })
    const masterUrl = new URL(r.sources[0].url)
    const master = await (await fetch(masterUrl, { signal: AbortSignal.timeout(25_000) })).text()

    const variansSor = master.split('\n').find(s => s.trim() && !s.startsWith('#'))
    assert.ok(variansSor, 'a master playlistben nincs variáns')

    const variansUrl = new URL(variansSor.trim(), masterUrl)
    const varians = await fetch(variansUrl, { signal: AbortSignal.timeout(25_000) })
    assert.equal(varians.status, 200, `a variáns playlist nem tölthető: HTTP ${varians.status}`)
    const variansSzoveg = await varians.text()
    assert.ok(variansSzoveg.startsWith('#EXTM3U'))
    assert.match(variansSzoveg, /#EXTINF/, 'a variánsban nincs szegmens')

    const szegmensSor = variansSzoveg.split('\n').find(s => s.trim() && !s.startsWith('#'))
    assert.ok(szegmensSor, 'nincs szegmens a variáns playlistben')
    const szegmens = await fetch(new URL(szegmensSor.trim(), variansUrl), {
      method: 'GET', signal: AbortSignal.timeout(30_000)
    })
    assert.equal(szegmens.status, 200, `a szegmens nem tölthető: HTTP ${szegmens.status}`)
    const meret = (await szegmens.arrayBuffer()).byteLength
    assert.ok(meret > 10_000, `a szegmens gyanúsan kicsi: ${meret} bájt`)
  })

  it('feliratsávokat ad, valódi VTT tartalommal', async () => {
    const r = await provider.resolve({
      anilistId: ANILIST,
      malId: null,
      kitsuId: null,
      anidbId: null,
      title: CIM,
      year: 2023,
      number: 1,
      variant: 'sub'
    })
    assert.ok(r.subtitles.length > 0, 'nincs feliratsáv')
    const sav = r.subtitles[0]
    assert.equal(sav.format, 'vtt')
    const res = await fetch(sav.url, { signal: AbortSignal.timeout(25_000) })
    assert.equal(res.status, 200)
    const szoveg = await res.text()
    assert.ok(szoveg.trimStart().startsWith('WEBVTT'), `nem WebVTT: ${szoveg.slice(0, 40)}`)
  })

  it('dub és raw kérésre továbbra is üres — nincs csendes helyettesítés', async () => {
    for (const variant of ['dub', 'raw']) {
      const r = await provider.resolve({
        anilistId: ANILIST,
        malId: null,
        kitsuId: null,
        anidbId: null,
        title: CIM,
        year: 2023,
        number: 1,
        variant
      })
      assert.deepEqual(r.sources, [], `${variant} kérésre forrást adott`)
    }
  })
})
