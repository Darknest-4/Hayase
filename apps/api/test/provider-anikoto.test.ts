// Az Anikoto adapter.
//
// A KÖZPONTI ÁLLÍTÁS, amit ez a készlet őriz: a szolgáltató API-ja nem ad
// `.m3u8`/`.mpd`/`.mp4` címet — az epizódnál `embed_url.sub` / `embed_url.dub`
// áll, egy harmadik fél LEJÁTSZÓ LAPJA. Ezt beágyazzuk, ahogy a szolgáltató
// szánta, és `kind: 'embed'`-nek nevezzük.
//
// A NÉV NEM FORMASÁG. Ha a beágyazó cím bármelyik folyam-fajta nevén jönne
// vissza, a lejátszó egy HTML-lapot próbálna videóként dekódolni — néma
// fekete doboz, a naplóban „sikeres feloldás" felirattal. A készlet erre
// külön rámegy, a visszaadott adatra, nem a kódra.
//
// A hálózat hamis: a mérés tárgya az adapter viselkedése, nem egy külső
// szolgáltatás elérhetősége. Az élő ellenőrzés külön fájlban van.

import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'

import { checkResult, checkShape } from './support/provider-contract.ts'

let anikoto: typeof import('../src/modules/providers/adapters/anikoto.ts')
let index: typeof import('../src/modules/providers/adapters/anikoto-index.ts')

before(async () => {
  anikoto = await import('../src/modules/providers/adapters/anikoto.ts')
  index = await import('../src/modules/providers/adapters/anikoto-index.ts')
})

/*
 * AZ INDEX MODULSZINTŰ ÁLLAPOT, tehát a tesztek KÖZÖTT IS megmaradna.
 * Enélkül a második teszt az elsőnek épített indexét látná, és a saját
 * hálózati fixtúrája néma lenne — a mérés nem azt mérné, amit állít.
 */
beforeEach(() => {
  mock.restoreAll()
  index.clearIndex()
})

/** Egy katalógusrekord az ÉLŐ válasz alakjában: `id` szám, `ani_id` sztring. */
const KATALOGUS = {
  ok: true,
  data: [
    { id: 8717, title: 'Liar Game', alternative: 'Liar Game', titles: 'LIAR GAME; Liar Game', year: 2026, ani_id: '197754', episodes: '26' },
    { id: 1234, title: 'Másik cím', year: 2020, ani_id: '999', episodes: '12' }
  ]
}

/** Egy sorozat epizódokkal. A 25. részhez csak `sub` van — ez szándékos. */
const SOROZAT = {
  ok: true,
  data: {
    anime: { id: 8717, title: 'Liar Game' },
    episodes: [
      { id: 131868, number: 1, title: 'Episode 1', episode_embed_id: '169846', embed_url: { sub: 'https://beagyazo.pelda/stream/169846/sub', dub: 'https://beagyazo.pelda/stream/169846/dub' } },
      { id: 135471, number: 25, title: 'Episode 25', episode_embed_id: '337825', embed_url: { sub: 'https://beagyazo.pelda/stream/337825/sub' } }
    ]
  }
}

/** A `fetch` lecserélése útvonal szerint. */
function halozat (valasz: (url: string) => { status: number, body?: unknown } | Error): { cimek: string[] } {
  const cimek: string[] = []
  mock.method(globalThis, 'fetch', async (url: string) => {
    cimek.push(String(url))
    const v = valasz(String(url))
    if (v instanceof Error) throw v
    return {
      ok: v.status >= 200 && v.status < 300,
      status: v.status,
      json: async () => v.body
    }
  })
  return { cimek }
}

/**
 * A VALÓDI API LAPOZÁSÁT UTÁNOZZA.
 *
 * Az első lap adja a katalógust, a többi ÜRES — a bejárás ebből tudja, hogy
 * a végére ért. Ha minden lap ugyanazt adná (ahogy egy hanyag csonk tenné),
 * az index négyszáz lapig menne, és a teszt azt mérné, hogy mennyi ideig
 * bírja a ciklus.
 */
function katalogusLap (url: string) {
  const page = Number(new URL(url, 'https://x.invalid').searchParams.get('page') ?? '1')
  return { status: 200, body: page <= 1 ? KATALOGUS : { ok: true, data: [] } }
}

const rendes = (url: string) =>
  url.includes('/series/') ? { status: 200, body: SOROZAT } : katalogusLap(url)

/**
 * A FIXTÚRA GAZDAGÉPE ENGEDÉLYEZVE.
 *
 * Nem kényelmi beállítás: ettől mérhető, hogy az engedélyezés TÉNYLEG
 * kapuként működik — az alapértelmezett listával ugyanez a fixtúra elbukna,
 * és erre külön teszt megy rá lentebb.
 */
const CFG = { embedHosts: ['beagyazo.pelda'] }

const REF = {
  anilistId: 197754, malId: null, kitsuId: null, anidbId: null,
  title: 'Liar Game', year: 2026, number: 1
}

describe('az Anikoto adapter', () => {
  it('teljesíti a szerződést', () => {
    checkShape(anikoto.anikotoProvider, 'az anikoto adapter')
  })

  // ---- katalógus és párosítás ----

  it('SZÁM alakú azonosítót is elfogad — ez volt az eredeti hiba', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.search('Liar Game', { anilistId: 197754, year: 2026 })
    assert.equal(r.length, 1)
    assert.equal(r[0]?.id, '8717', 'a szám azonosító elveszett')
    assert.equal(typeof r[0]?.id, 'string', 'a szerződés sztringet vár')
  })

  it('AniList-azonosítóra akkor is talál, ha a cím nem stimmel', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.search('egészen más', { anilistId: 197754 })
    assert.equal(r[0]?.id, '8717')
  })

  it('cím szerint hint nélkül is talál, részlegesen is', async () => {
    halozat(rendes)
    assert.equal((await anikoto.anikotoProvider.search('Liar Game'))[0]?.id, '8717')
    assert.equal((await anikoto.anikotoProvider.search('liar'))[0]?.id, '8717')
  })

  it('az évszám nem zár ki jó találatot', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.search('Liar Game', { year: 1999 })
    assert.equal(r[0]?.id, '8717', 'egy téves évszám elvette a jó találatot')
  })

  /*
   * EZ A KÉSZLET LEGFONTOSABB TESZTJE — EGY MÉRT, ÉLES HIBA.
   *
   * Az adapter egyetlen lapot kért le, és abban keresett. A szolgáltató
   * katalógusa 180 lap: a Shingeki no Kyojin, a Kimetsu no Yaiba és a Death
   * Note BENNE VAN, csak nem az első ötvenben. A nézőnek ez „ezt a részt
   * egyik forrásból sem sikerült lejátszani"-ként jelent meg — vagyis a hiba
   * pont úgy nézett ki, mint egy hiányzó cím.
   */
  it('a HARMADIK lapon lévő címet is megtalálja', async () => {
    const melyKatalogus = (url: string) => {
      const page = Number(new URL(url, 'https://x.invalid').searchParams.get('page') ?? '1')
      if (page === 3) {
        return { status: 200, body: { ok: true, data: [{ id: 3303, title: 'Shingeki no Kyojin', ani_id: '16498', year: 2013, episodes: '25' }] } }
      }
      if (page <= 4) return { status: 200, body: KATALOGUS }
      return { status: 200, body: { ok: true, data: [] } }
    }
    halozat((url) => url.includes('/series/') ? { status: 200, body: SOROZAT } : melyKatalogus(url))

    const r = await anikoto.anikotoProvider.search('Shingeki no Kyojin', { anilistId: 16498 })
    assert.equal(r[0]?.id, '3303', 'csak az első lapot nézte — ez volt az éles hiba')
  })

  it('a mélyebb lapon lévő címre a feloldás is talál forrást', async () => {
    const melyKatalogus = (url: string) => {
      const page = Number(new URL(url, 'https://x.invalid').searchParams.get('page') ?? '1')
      if (page === 3) {
        return { status: 200, body: { ok: true, data: [{ id: 8717, title: 'Shingeki no Kyojin', ani_id: '16498', year: 2013, episodes: '25' }] } }
      }
      if (page <= 4) return { status: 200, body: KATALOGUS }
      return { status: 200, body: { ok: true, data: [] } }
    }
    halozat((url) => url.includes('/series/') ? { status: 200, body: SOROZAT } : melyKatalogus(url))

    const r = await anikoto.anikotoProvider.resolve({
      ...REF, title: 'Shingeki no Kyojin', anilistId: 16498, year: 2013, variant: 'sub'
    }, CFG)
    assert.equal(r.sources.length, 1, 'a mélyebb lapon lévő címhez nem talált forrást')
    assert.equal(r.sources[0]?.kind, 'embed')
  })

  it('MAL-azonosító szerint is párosít', async () => {
    const lap = (url: string) => {
      const page = Number(new URL(url, 'https://x.invalid').searchParams.get('page') ?? '1')
      return { status: 200, body: page <= 1
        ? { ok: true, data: [{ id: 4242, title: 'Egészen más cím', mal_id: '62331', year: 2026, episodes: '26' }] }
        : { ok: true, data: [] } }
    }
    halozat((url) => url.includes('/series/') ? { status: 200, body: SOROZAT } : lap(url))

    const r = await anikoto.anikotoProvider.search('semmi köze', { malId: 62331 } as never)
    assert.equal(r[0]?.id, '4242', 'a MAL-azonosítót nem használta párosításra')
  })

  it('ismeretlen címre üres lista', async () => {
    halozat(rendes)
    assert.deepEqual(await anikoto.anikotoProvider.search('ilyen cím nincs'), [])
  })

  // ---- epizódok ----

  it('az epizód azonosítója a SZOLGÁLTATÓÉ, és sorszám szerint rendezett', async () => {
    halozat(rendes)
    const eps = await anikoto.anikotoProvider.episodes('8717')
    assert.equal(eps.length, 2)
    assert.deepEqual(eps.map(e => e.id), ['169846', '337825'])
    assert.deepEqual(eps.map(e => e.number), [1, 25])
  })

  // ---- HTTP-viselkedés ----

  it('404 → üres eredmény, NEM kivétel', async () => {
    halozat(() => ({ status: 404 }))
    assert.deepEqual(await anikoto.anikotoProvider.episodes('99999999'), [])
  })

  it('429 → kivétel, hogy a megszakító lássa', async () => {
    halozat(() => ({ status: 429 }))
    await assert.rejects(() => anikoto.anikotoProvider.episodes('8717'), /429/)
  })

  it('500 és 503 → kivétel', async () => {
    for (const status of [500, 503]) {
      halozat(() => ({ status }))
      await assert.rejects(() => anikoto.anikotoProvider.episodes('8717'), new RegExp(String(status)))
    }
  })

  it('hálózati hiba → kivétel', async () => {
    halozat(() => new Error('ECONNREFUSED'))
    await assert.rejects(() => anikoto.anikotoProvider.episodes('8717'), /ECONNREFUSED/)
  })

  // ---- a lényeg: a resolve NEM hazudik forrást ----

  it('sub kérésre beágyazó forrást ad', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'sub' }, CFG)
    checkResult(r)
    assert.equal(r.sources.length, 1)
    assert.equal(r.sources[0]?.kind, 'embed', 'nem embed fajtával jött')
    assert.equal(r.sources[0]?.variant, 'sub')
    assert.equal(r.sources[0]?.url, 'https://beagyazo.pelda/stream/169846/sub')
    assert.equal(r.sources[0]?.label, 'Anikoto')
  })

  it('dub kérésre a DUB címet adja, nem a subot', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'dub' }, CFG)
    assert.equal(r.sources.length, 1)
    assert.equal(r.sources[0]?.kind, 'embed')
    assert.equal(r.sources[0]?.variant, 'dub')
    assert.match(String(r.sources[0]?.url), /\/dub$/, 'a dub kérésre a sub címe jött')
  })

  it('változat megjelölése nélkül mindkettőt felkínálja', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve(REF, CFG)
    assert.deepEqual(r.sources.map(s => s.variant).sort(), ['dub', 'sub'])
    assert.ok(r.sources.every(s => s.kind === 'embed'))
  })

  /*
   * A FELBONTÁS `null`, ÉS EZ ÁLLÍTÁS, NEM MULASZTÁS. A minőséget az idegen
   * lejátszó dönti el; egy kitalált `1080p` a forrásválasztóban olyan
   * ígéret lenne, amit semmi nem vált be.
   */
  it('nem talál ki felbontást a beágyazáshoz', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'sub' }, CFG)
    assert.equal(r.sources[0]?.quality, null)
  })

  /*
   * A HIÁNYZÓ VÁLTOZATOT NEM HELYETTESÍTJÜK. A 25. részhez csak `sub` van;
   * aki `dub`-ot kért, annak a feliratos NEM jó válasz — rossz hangsávval
   * induló lejátszó lenne belőle.
   */
  it('hiányzó dub esetén nem csúsztat be subot', async () => {
    const naplo: string[] = []
    mock.method(console, 'info', (...a: unknown[]) => { naplo.push(a.join(' ')) })
    halozat(rendes)

    const r = await anikoto.anikotoProvider.resolve({ ...REF, number: 25, variant: 'dub' }, CFG)

    assert.deepEqual(r.sources, [])
    assert.match(naplo.join('\n'), /dub/, 'a napló nem mondja meg, mi hiányzott')
  })

  it('raw kérésre nem ad sub/dub forrást', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'raw' }, CFG)
    assert.deepEqual(r.sources, [])
  })

  it('ismeretlen részre üres eredmény', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, number: 999 }, CFG)
    checkResult(r)
    assert.deepEqual(r.sources, [])
  })

  /*
   * A LEGFONTOSABB ÁLLÍTÁS. Egy beágyazó lap címe `mp4`/`hls`/`dash` néven
   * azt jelentené, hogy a lejátszó HTML-t próbál videóként dekódolni: néma
   * fekete doboz, a naplóban sikerrel. A teszt a VISSZAADOTT ADATRA megy rá.
   */
  it('beágyazó cím SOHA nem kap folyam-fajtát', async () => {
    halozat(rendes)
    for (const variant of ['sub', 'dub', 'raw', undefined] as const) {
      const r = await anikoto.anikotoProvider.resolve(
        variant ? { ...REF, variant } : REF, CFG)
      for (const forras of r.sources) {
        assert.equal(forras.kind, 'embed',
          `a(z) „${variant ?? 'változat nélküli'}" kérés ${forras.kind} fajtát adott egy beágyazó címre`)
      }
    }
  })

  // ---- a beágyazó cím mint biztonsági határ ----

  /**
   * Egy sorozat, aminek az epizódja a megadott címet hordozza.
   * Így egyetlen teszt egyetlen rossz címet mér, keveredés nélkül.
   */
  function sorozatCimmel (sub: unknown) {
    return {
      ok: true,
      data: {
        anime: { id: 8717, title: 'Liar Game' },
        episodes: [{ id: 131868, number: 1, title: 'Episode 1', episode_embed_id: '169846', embed_url: { sub } }]
      }
    }
  }

  /*
   * AMI IDE BEKERÜL, AZ A NÉZŐ LAPJÁN `iframe`-BEN FUT. A szolgáltató válasza
   * innentől nem megbízható adat: minden egyes alak elutasítást kell kapjon,
   * és nem azért, mert „furcsán néz ki", hanem mert mindegyik VALAMIT tudna.
   */
  const ROSSZ_CIMEK: Array<[string, unknown]> = [
    ['javascript: séma — a MI eredetünkön futna le', 'javascript:alert(1)'],
    ['data: séma — tetszőleges HTML a lapunkba', 'data:text/html,<script>alert(1)</script>'],
    ['blob: séma', 'blob:https://beagyazo.pelda/abc'],
    ['sima http — kevert tartalom', 'http://beagyazo.pelda/stream/1/sub'],
    ['protokoll-relatív cím', '//beagyazo.pelda/stream/1/sub'],
    ['relatív út — a SAJÁT lapunkat ágyazná be', '/stream/1/sub'],
    ['idegen gazdagép', 'https://tamado.pelda/stream/1/sub'],
    ['ÁLCÁZOTT gazdagép: a végződés egyezik, a tartomány más', 'https://gonoszbeagyazo.pelda/stream/1/sub'],
    ['hitelesítő adat a címben', 'https://user:pass@beagyazo.pelda/stream/1/sub'],
    ['üres', ''],
    ['nem sztring', 12345],
    ['hiányzik', null]
  ]

  for (const [nev, cim] of ROSSZ_CIMEK) {
    it(`elutasítja: ${nev}`, async () => {
      halozat((url) => url.includes('/series/')
        ? { status: 200, body: sorozatCimmel(cim) }
        : katalogusLap(url))

      const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'sub' }, CFG)
      assert.deepEqual(r.sources, [], `átengedte: ${String(cim)}`)
    })
  }

  /*
   * AZ ÁLCÁZOTT GAZDAGÉP KÜLÖN IS, mert ez a hiba a legkönnyebben
   * beírható: egy `host.endsWith('beagyazo.pelda')` átengedné a
   * `gonoszbeagyazo.pelda`-t, ami egy teljesen más, tetszőleges kézben lévő
   * tartomány. Az altartomány viszont MENJEN át.
   */
  it('az altartomány átmegy, az álcázott tartomány nem', async () => {
    halozat((url) => url.includes('/series/')
      ? { status: 200, body: sorozatCimmel('https://cdn.beagyazo.pelda/stream/1/sub') }
      : katalogusLap(url))
    const jo = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'sub' }, CFG)
    assert.equal(jo.sources.length, 1, 'az altartományt elutasította')
  })

  it('üres engedélylistával semmi nem megy át', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'sub' }, { embedHosts: [] })
    assert.deepEqual(r.sources, [])
  })

  /*
   * A FIXTÚRA GAZDAGÉPE AZ ALAPÉRTELMEZETT LISTÁN NINCS RAJTA. Ez bizonyítja,
   * hogy a `CFG` a fenti tesztekben nem díszítés: nélküle ugyanez elbukna,
   * vagyis a kapu tényleg zár.
   */
  it('az alapértelmezett listával a fixtúra címe nem megy át', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'sub' })
    assert.deepEqual(r.sources, [], 'az engedélylista nem zár — bármelyik gazdagép átmegy')
  })

  it('az elutasított címet NEM írja a naplóba', async () => {
    const naplo: string[] = []
    mock.method(console, 'info', (...a: unknown[]) => { naplo.push(a.join(' ')) })
    halozat((url) => url.includes('/series/')
      ? { status: 200, body: sorozatCimmel('https://tamado.pelda/titkos/utvonal?token=abc123') }
      : katalogusLap(url))

    await anikoto.anikotoProvider.resolve({ ...REF, variant: 'sub' }, CFG)

    const uzenet = naplo.join('\n')
    assert.ok(!uzenet.includes('abc123'), 'a napló kiírta az elutasított cím tartalmát')
    assert.ok(!uzenet.includes('/titkos/utvonal'), 'a napló kiírta az elutasított cím útvonalát')
  })

  it('a feloldás eljut a sorozatig — nem a számazonosítón hasal el', async () => {
    const { cimek } = halozat(rendes)
    await anikoto.anikotoProvider.resolve(REF, CFG)
    assert.ok(cimek.some(u => u.includes('/series/8717')),
      'a sorozatot meg sem kérdezte — a szám alakú azonosító elveszett: ' + JSON.stringify(cimek))
  })

  it('a diagnosztika megmondja, miért nincs forrás', async () => {
    const naplo: string[] = []
    mock.method(console, 'info', (...a: unknown[]) => { naplo.push(a.join(' ')) })
    halozat(rendes)

    await anikoto.anikotoProvider.resolve(REF, CFG)

    const uzenet = naplo.join('\n')
    assert.match(uzenet, /\[anikoto\]/)
    assert.match(uzenet, /beágyazás/, 'a napló nem mondja meg, mi lett a beágyazásokkal')
  })
})
