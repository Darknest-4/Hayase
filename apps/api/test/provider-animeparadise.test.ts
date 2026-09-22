// Az AnimeParadise adapter.
//
// A hálózat itt HAMIS: a mérés tárgya az adapter viselkedése, nem egy külső
// kiszolgáló elérhetősége. Az, hogy a visszaadott cím TÉNYLEG HLS-ként
// működik-e, külön, ÉLŐ teszt dolga — `tests/e2e/animeparadise-live.test.mjs`.
// Ez a kettő nem helyettesíti egymást: egy mockolt teszt sosem bizonyítja,
// hogy az upstream contract még áll, egy élő teszt pedig nem tud
// hibaágakat kikényszeríteni.
//
// A FIXTÚRÁK AZ ÉLŐ VÁLASZ ALAKJÁT KÖVETIK, mérve (2026-09-21): a találati
// rekordban `_id`, `alternativeTitle`, `animeSeason.year`, `startDate` van —
// NINCS `year` és NINCS `released`, amit az `anime-sdk` olvas. Az epizód
// `number` mezője SZTRING. A `subData` vegyes: részben Google Drive
// fájlazonosító, részben valódi cím.

import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'

import { checkResult, checkShape } from './support/provider-contract.ts'

let ap: typeof import('../src/modules/providers/adapters/animeparadise.ts')

before(async () => {
  ap = await import('../src/modules/providers/adapters/animeparadise.ts')
})
beforeEach(() => { mock.restoreAll() })

const KERES = {
  data: [
    {
      _id: 'NIUsb960SxtXls4h',
      title: 'Sousou no Frieren',
      link: 'sousou-no-frieren',
      episodes: 28,
      episodeCount: 28,
      animeSeason: { season: 'Fall', year: 2023 },
      startDate: '2023-09-29',
      alternativeTitle: { english: "Frieren: Beyond Journey's End", romaji: 'Sousou no Frieren', native: '葬送のフリーレン' },
      posterImage: { large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg' }
    },
    {
      _id: 'MasikSorozat00',
      title: 'Egészen más',
      episodeCount: 12,
      animeSeason: { season: 'Spring', year: 2020 },
      alternativeTitle: { english: 'Something Else' },
      posterImage: { large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx999-abc.jpg' }
    }
  ]
}

const EPIZODOK = {
  data: [
    { _id: 'o3ZJExm5rJqnr7dS', uid: 'bed82e58-72ec-4427-8900-9e6273e5e24d', number: '1', title: "The Journey's End", origin: 'NIUsb960SxtXls4h' },
    { _id: 'p4ZJExm5rJqnr7dT', uid: 'aaa11111-72ec-4427-8900-9e6273e5e24d', number: '2', title: 'Második', origin: 'NIUsb960SxtXls4h' }
  ]
}

/** A `subData` VEGYES — négy Drive-azonosító és három valódi cím. */
const SUBDATA = [
  { src: '1ZvDDo79ZE7bc8UFxs0Yn3ShLJP-V_4Ng', label: 'English', type: 'ass' },
  { src: '1ED7bZpYQR9gPsDGY2JgSIWXlvpcoecCq', label: 'Italian', type: 'ass' },
  { src: 'https://stream.animeparadise.moe/captions?url=AAA', label: 'English', type: 'vtt' },
  { src: 'https://stream.animeparadise.moe/captions?url=BBB', label: 'Italian', type: 'vtt' },
  { src: 'https://stream.animeparadise.moe/captions?url=CCC', label: 'Spanish', type: 'vtt' }
]

const TOKEN = 'zcv4SAFskJos68aR74Zazp7JiDbwrF_xCtOofLGxiIJ0JCeBwzKidAWzw7hbTqLJ'
const EP_VALASZ = { data: { episode: { uid: 'bed82e58-72ec-4427-8900-9e6273e5e24d', number: '1', origin: 'NIUsb960SxtXls4h', streamLink: TOKEN, subData: SUBDATA } } }

function halozat (valasz: (url: string) => { status: number, body?: unknown } | Error): { cimek: string[] } {
  const cimek: string[] = []
  mock.method(globalThis, 'fetch', async (url: string) => {
    cimek.push(String(url))
    const v = valasz(String(url))
    if (v instanceof Error) throw v
    return { ok: v.status >= 200 && v.status < 300, status: v.status, json: async () => v.body }
  })
  return { cimek }
}

const rendes = (url: string) => {
  if (url.includes('/search')) return { status: 200, body: KERES }
  if (url.includes('/episode')) return { status: 200, body: EPIZODOK }
  if (url.includes('/ep/')) return { status: 200, body: EP_VALASZ }
  return { status: 404 }
}

const REF = {
  anilistId: 154587, malId: null, kitsuId: null, anidbId: null,
  title: 'Sousou no Frieren', year: 2023, number: 1
}

describe('az AnimeParadise adapter', () => {
  it('teljesíti a szerződést', () => {
    checkShape(ap.animeparadiseProvider, 'az animeparadise adapter')
  })

  it('alapból KIKAPCSOLVA regisztrál — külső hálózati szolgáltató', () => {
    assert.equal(ap.animeparadiseProvider.defaultEnabled, false,
      'a bekapcsolása legyen kifejezett döntés, ne egy kódfrissítés mellékhatása')
  })

  // ---- keresés ----

  it('pontos címre talál', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.search('Sousou no Frieren')
    assert.equal(r[0]?.id, 'NIUsb960SxtXls4h')
    assert.equal(r[0]?.episodeCount, 28)
  })

  it('az angol alcímre is talál', async () => {
    halozat(rendes)
    assert.equal((await ap.animeparadiseProvider.search("Frieren: Beyond Journey's End"))[0]?.id, 'NIUsb960SxtXls4h')
  })

  it('részleges címre is talál', async () => {
    halozat(rendes)
    assert.equal((await ap.animeparadiseProvider.search('Frieren'))[0]?.id, 'NIUsb960SxtXls4h')
  })

  it('ismeretlen címre üres lista', async () => {
    halozat(rendes)
    assert.deepEqual(await ap.animeparadiseProvider.search('ilyen cím nincs'), [])
  })

  /*
   * AZ ÉVSZÁM A MAI MEZŐKBŐL JÖN.
   *
   * Az `anime-sdk` `item.year`-t és `item.released`-et olvas, és EGYIK SEM
   * létezik a mai válaszban — ott `animeSeason.year` és `startDate` van. Aki a
   * doksit másolja, annál minden találat évszám nélkül marad, és az évszám
   * mint rangsorjel csendben eltűnik.
   */
  it('az évszámot az animeSeason.year adja', async () => {
    /*
     * A KÉT MEZŐ SZÁNDÉKOSAN ELTÉR (2023 vs 2019). Enélkül a teszt nem
     * mérne semmit: a fixtúrában a `startDate` ugyanazt az évet adja, tehát
     * egy elrontott sorrend is „helyes" eredményt hozna — mérve, egy
     * szabotázzsal, ami így nem bukott el.
     */
    halozat(() => ({ status: 200, body: { data: [{
      _id: 'X', title: 'Proba',
      animeSeason: { season: 'Fall', year: 2023 },
      startDate: '2019-04-06'
    }] } }))
    assert.equal((await ap.animeparadiseProvider.search('Proba'))[0]?.year, 2023,
      'nem az animeSeason.year-t vette, pedig az az elsődleges')
  })

  it('a találat évszáma a valódi fixtúrán is helyes', async () => {
    halozat(rendes)
    assert.equal((await ap.animeparadiseProvider.search('Frieren'))[0]?.year, 2023)
  })

  it('animeSeason nélkül a startDate-ből veszi az évet', async () => {
    halozat(() => ({ status: 200, body: { data: [{ _id: 'X', title: 'Proba', startDate: '2019-04-06' }] } }))
    assert.equal((await ap.animeparadiseProvider.search('Proba'))[0]?.year, 2019)
  })

  it('egy téves évszám nem veszi el a jó találatot', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.search('Sousou no Frieren', { year: 1999 })
    assert.equal(r[0]?.id, 'NIUsb960SxtXls4h', 'az évszám kizáró feltétellé vált')
  })

  /*
   * AZ ANILIST-AZONOSÍTÓT NEM TALÁLJUK KI. Az API nem ad ilyen mezőt; a
   * poszter AniList-CDN útvonala hordozza ugyan (`bx154587`), de az nem
   * dokumentált szerződés. MEGERŐSÍTÉSRE használjuk, azonosításra nem.
   */
  it('nem ad ki kitalált AniList-azonosítót', async () => {
    halozat(rendes)
    for (const m of await ap.animeparadiseProvider.search('Frieren')) {
      assert.equal(m.anilistId, null, 'az adapter mappinget talált ki')
    }
  })

  it('az AniList-hint MEGERŐSÍTI a találatot, előrébb rangsorolja', async () => {
    halozat(() => ({ status: 200, body: { data: [KERES.data[1], KERES.data[0]] } }))
    // Mindkettő részlegesen egyezik a „more" szóval? Nem — a hint dönt:
    const rosszSorrend = await ap.animeparadiseProvider.search('Frieren', { anilistId: 154587 })
    assert.equal(rosszSorrend[0]?.id, 'NIUsb960SxtXls4h')
  })

  it('a NEM egyező AniList-hint nem zár ki', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.search('Sousou no Frieren', { anilistId: 999999 })
    assert.equal(r[0]?.id, 'NIUsb960SxtXls4h', 'a hint kizáró feltétellé vált')
  })

  // ---- epizódok ----

  it('a szolgáltató SAJÁT epizódazonosítóját adja, nem gyártottat', async () => {
    halozat(rendes)
    const eps = await ap.animeparadiseProvider.episodes('NIUsb960SxtXls4h')
    assert.equal(eps.length, 2)
    assert.equal(eps[0]?.id, 'bed82e58-72ec-4427-8900-9e6273e5e24d')
    assert.ok(!eps[0]?.id.includes(':'), 'összeragasztott azonosítót gyártott')
  })

  /*
   * A `number` A VÁLASZBAN SZTRING („1"). Ha nyersen mennénk tovább, a
   * sorszám szerinti keresés (`=== ref.number`) SOSEM találna, és minden
   * feloldás üres eredményt adna — pont úgy, mintha nem lenne forrás.
   */
  it('a sztring sorszámot számmá alakítja', async () => {
    halozat(rendes)
    const eps = await ap.animeparadiseProvider.episodes('NIUsb960SxtXls4h')
    assert.deepEqual(eps.map(e => e.number), [1, 2])
    assert.equal(typeof eps[0]?.number, 'number')
  })

  it('sorszám szerint rendez', async () => {
    halozat((url) => url.includes('/episode')
      ? { status: 200, body: { data: [EPIZODOK.data[1], EPIZODOK.data[0]] } }
      : rendes(url))
    assert.deepEqual((await ap.animeparadiseProvider.episodes('X')).map(e => e.number), [1, 2])
  })

  it('üres azonosítóra nem hív hálózatot', async () => {
    const { cimek } = halozat(rendes)
    assert.deepEqual(await ap.animeparadiseProvider.episodes('  '), [])
    assert.equal(cimek.length, 0)
  })

  // ---- HTTP-viselkedés ----

  it('404 → üres eredmény, NEM kivétel', async () => {
    halozat(() => ({ status: 404 }))
    assert.deepEqual(await ap.animeparadiseProvider.episodes('nincs-ilyen'), [])
    assert.deepEqual(await ap.animeparadiseProvider.search('nincs'), [])
  })

  it('429 → kivétel, hogy a megszakító lássa', async () => {
    halozat(() => ({ status: 429 }))
    await assert.rejects(() => ap.animeparadiseProvider.episodes('X'), /429/)
  })

  it('500 és 503 → kivétel', async () => {
    for (const status of [500, 503]) {
      halozat(() => ({ status }))
      await assert.rejects(() => ap.animeparadiseProvider.episodes('X'), new RegExp(String(status)))
    }
  })

  it('hálózati hiba és időtúllépés → kivétel', async () => {
    halozat(() => new Error('ECONNREFUSED'))
    await assert.rejects(() => ap.animeparadiseProvider.episodes('X'), /ECONNREFUSED/)
  })

  /*
   * A HIBÁS ALAKÚ VÁLASZ NEM DÖNTHETI ÖSSZE A LÁNCOT. Egy kivétel itt azt
   * jelentené, hogy a megszakító kinyit — pedig a szolgáltató válaszolt,
   * csak mást, mint vártunk.
   */
  it('hibás alakú válaszra üres eredmény, nem kivétel', async () => {
    for (const body of [null, 'szöveg', 42, [], {}, { data: null }, { data: 'nem tömb' }, { data: [null, 7] }]) {
      halozat(() => ({ status: 200, body }))
      assert.deepEqual(await ap.animeparadiseProvider.search('proba'), [], `elhasalt ezen: ${JSON.stringify(body)}`)
      assert.deepEqual(await ap.animeparadiseProvider.episodes('X'), [], `elhasalt ezen: ${JSON.stringify(body)}`)
      const r = await ap.animeparadiseProvider.resolve(REF as never)
      assert.deepEqual(r.sources, [])
    }
  })

  // ---- feloldás ----

  it('sub kérésre valódi HLS forrást ad', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve({ ...REF, variant: 'sub' } as never)
    checkResult(r)
    assert.equal(r.sources.length, 1)
    assert.equal(r.sources[0]?.kind, 'hls')
    assert.equal(r.sources[0]?.variant, 'sub')
    assert.equal(r.sources[0]?.label, 'AnimeParadise')
  })

  /*
   * A CÍM A SZOLGÁLTATÓ STREAM-VÉGPONTJA, NEM AZ API-VÉGPONT.
   *
   * Ha ide a JSON-t adó `/ep/{uid}` cím kerülne `kind: 'hls'` alatt, a
   * lejátszó egy JSON-t próbálna playlistként értelmezni: néma fekete doboz,
   * a naplóban „sikeres feloldás" felirattal.
   */
  it('a cím a stream-végpont, nem a JSON API', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve({ ...REF, variant: 'sub' } as never)
    const url = String(r.sources[0]?.url)
    assert.match(url, /^https:\/\/stream\.animeparadise\.moe\/m3u8\?url=/)
    assert.ok(!url.includes('api.animeparadise.moe'), 'az API-végpontot adta vissza HLS-ként')
    assert.ok(url.includes(encodeURIComponent(TOKEN)), 'a token nem került a címbe')
  })

  it('a változat megjelölése nélkül is ad forrást', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve(REF as never)
    assert.equal(r.sources.length, 1)
  })

  /*
   * CSAK FELIRATOS. A kért változatot NEM helyettesítjük: aki `dub`-ot kért,
   * annak a feliratos nem jó válasz — rossz hangsávval induló lejátszó lenne
   * belőle, amit a naplóban semmi nem jelez.
   */
  it('dub kérésre ÜRES, nem feliratos', async () => {
    const { cimek } = halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve({ ...REF, variant: 'dub' } as never)
    assert.deepEqual(r.sources, [])
    assert.equal(cimek.length, 0, 'fölöslegesen hívott hálózatot egy nem támogatott változatért')
  })

  it('raw kérésre ÜRES', async () => {
    halozat(rendes)
    assert.deepEqual((await ap.animeparadiseProvider.resolve({ ...REF, variant: 'raw' } as never)).sources, [])
  })

  it('ismeretlen részre üres eredmény', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve({ ...REF, number: 999 } as never)
    checkResult(r)
    assert.deepEqual(r.sources, [])
  })

  it('streamLink nélkül üres eredmény', async () => {
    halozat((url) => url.includes('/ep/')
      ? { status: 200, body: { data: { episode: { uid: 'x' } } } }
      : rendes(url))
    assert.deepEqual((await ap.animeparadiseProvider.resolve(REF as never)).sources, [])
  })

  it('nem találgat lejáratot, ha az API nem mond ilyet', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve(REF as never)
    assert.ok(r.sources[0]?.expiresAt == null, 'kitalált egy lejáratot')
  })

  /*
   * FEJLÉC NINCS — ÉS EZ MÉRÉS, NEM MULASZTÁS.
   *
   * Az `anime-sdk` `Referer: https://animeparadise.moe/` fejlécet ad. A mérés
   * szerint a manifeszt és a szegmens is 200-at ad fejléc nélkül. Ez fontos:
   * a böngészőből a `Referer` NEM állítható (tiltott fejléc), tehát egy
   * fölöslegesen visszaadott fejléc azt a látszatot keltené, hogy a
   * lejátszásnak van egy feltétele, amit a böngésző nem tud teljesíteni.
   */
  it('nem kér fölösleges fejlécet', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve(REF as never)
    const h = r.sources[0]?.headers
    assert.ok(h === undefined || Object.keys(h).length === 0, `fejlécet kért: ${JSON.stringify(h)}`)
  })

  // ---- feliratok ----

  it('csak a valódi címeket adja vissza feliratként', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve(REF as never)
    assert.equal(r.subtitles.length, 3, 'a Drive-azonosítókat is átengedte')
    assert.deepEqual(r.subtitles.map(s => s.language), ['en', 'it', 'es'])
    assert.ok(r.subtitles.every(s => s.format === 'vtt'))
    assert.ok(r.subtitles.every(s => s.kind === 'subtitles'))
    assert.ok(r.subtitles.every(s => /^https:\/\//.test(s.url)))
  })

  it('az elsőt jelöli alapértelmezettnek, a többit nem', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve(REF as never)
    assert.deepEqual(r.subtitles.map(s => s.isDefault), [true, false, false])
  })

  it('ismeretlen formátumot nem tippel', async () => {
    halozat((url) => url.includes('/ep/')
      ? { status: 200, body: { data: { episode: { streamLink: TOKEN, subData: [{ src: 'https://stream.animeparadise.moe/captions?url=X', label: 'English', type: 'valami' }] } } } }
      : rendes(url))
    const r = await ap.animeparadiseProvider.resolve(REF as never)
    assert.deepEqual(r.subtitles, [], 'kitalált egy formátumot')
  })

  it('a hibás subData nem dönti össze a feloldást', async () => {
    for (const subData of [null, 'szöveg', 42, [null], [{}], [{ src: 123 }]]) {
      halozat((url) => url.includes('/ep/')
        ? { status: 200, body: { data: { episode: { streamLink: TOKEN, subData } } } }
        : rendes(url))
      const r = await ap.animeparadiseProvider.resolve(REF as never)
      assert.equal(r.sources.length, 1, `elhasalt ezen: ${JSON.stringify(subData)}`)
      assert.deepEqual(r.subtitles, [])
    }
  })

  // ---- biztonsági határ ----

  /*
   * AMI A VÁLASZBÓL JÖN, AZ NEM MEGBÍZHATÓ ADAT. A feliratcím a néző
   * böngészőjében töltődik be; egy idegen gazdagép vagy egy `javascript:`
   * séma innen jutna ki.
   */
  const ROSSZ_FELIRAT: Array<[string, unknown]> = [
    ['idegen gazdagép', 'https://tamado.pelda/felirat.vtt'],
    ['álcázott gazdagép', 'https://gonoszanimeparadise.moe/x.vtt'],
    ['javascript: séma', 'javascript:alert(1)'],
    ['data: séma', 'data:text/vtt,WEBVTT'],
    ['sima http', 'http://stream.animeparadise.moe/captions?url=X'],
    ['hitelesítő adat a címben', 'https://a:b@stream.animeparadise.moe/x.vtt'],
    ['Google Drive azonosító', '1ZvDDo79ZE7bc8UFxs0Yn3ShLJP-V_4Ng'],
    ['relatív út', '/captions?url=X']
  ]

  for (const [nev, src] of ROSSZ_FELIRAT) {
    it(`feliratként elutasítja: ${nev}`, async () => {
      halozat((url) => url.includes('/ep/')
        ? { status: 200, body: { data: { episode: { streamLink: TOKEN, subData: [{ src, label: 'English', type: 'vtt' }] } } } }
        : rendes(url))
      const r = await ap.animeparadiseProvider.resolve(REF as never)
      assert.deepEqual(r.subtitles, [], `átengedte: ${String(src)}`)
    })
  }

  /*
   * A `streamLink` EGY `?url=` PARAMÉTERBE KERÜL — ez a klasszikus
   * SSRF-felület. A gazdagép nálunk rögzített, tehát idegen kiszolgálóra nem
   * tud átvinni; de ha az érték maga URL volna, az azt jelentené, hogy az API
   * contractje megváltozott. Akkor inkább megállunk, mint hogy találgassunk.
   */
  it('URL alakú streamLinket elutasít, nem fűzi be', async () => {
    for (const rossz of ['https://tamado.pelda/x.m3u8', 'javascript:alert(1)', 'file:///etc/passwd', 'token szóközzel', 'token"idezojellel']) {
      halozat((url) => url.includes('/ep/')
        ? { status: 200, body: { data: { episode: { streamLink: rossz, subData: [] } } } }
        : rendes(url))
      const r = await ap.animeparadiseProvider.resolve(REF as never)
      assert.deepEqual(r.sources, [], `átengedte: ${rossz}`)
    }
  })

  it('elrontott streamBaseUrl nem juttat idegen címet a lejátszóba', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve(REF as never, { streamBaseUrl: 'https://tamado.pelda' })
    assert.deepEqual(r.sources, [], 'egy elrontott beállítás idegen kiszolgálóra mutatott')
  })

  it('üres engedélylistával semmi nem megy át', async () => {
    halozat(rendes)
    const r = await ap.animeparadiseProvider.resolve(REF as never, { allowedHosts: [] })
    assert.deepEqual(r.sources, [])
    assert.deepEqual(r.subtitles, [])
  })

  it('a naplóba nem kerül cím és token', async () => {
    const naplo: string[] = []
    mock.method(console, 'info', (...a: unknown[]) => { naplo.push(a.join(' ')) })
    halozat((url) => url.includes('/ep/')
      ? { status: 200, body: { data: { episode: { streamLink: 'https://titkos.pelda/x?token=SUPERSECRET' } } } }
      : rendes(url))

    await ap.animeparadiseProvider.resolve(REF as never)

    const uzenet = naplo.join('\n')
    assert.ok(!uzenet.includes('SUPERSECRET'), 'a napló kiírta a tokent')
    assert.ok(!uzenet.includes('titkos.pelda'), 'a napló kiírta a címet')
  })
})
