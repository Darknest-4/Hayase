// Az Anikoto adapter.
//
// A KÖZPONTI ÁLLÍTÁS, amit ez a készlet őriz: a szolgáltató API-ja NEM ad
// közvetlenül lejátszható címet. A saját dokumentációja két végpontot ismer
// (`/recent-anime`, `/series/{id}`), és az epizódnál `embed_url.sub` /
// `embed_url.dub` áll — egy HARMADIK FÉL beágyazó LAPJA, nem
// `.m3u8`/`.mpd`/`.mp4` fájl.
//
// Ezért a `resolve()` helyes válasza az ÜRES EREDMÉNY. Ha valaki egyszer
// `kind: 'mp4'`-ként adná vissza a beágyazó címet, a lejátszó egy HTML-lapot
// próbálna videóként dekódolni — néma fekete doboz, a naplóban „sikeres
// feloldás" felirattal. Ezt a készlet elbuktatja.
//
// A hálózat hamis: a mérés tárgya az adapter viselkedése, nem egy külső
// szolgáltatás elérhetősége. Az élő ellenőrzés külön fájlban van.

import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'

import { checkResult, checkShape } from './support/provider-contract.ts'

let anikoto: typeof import('../src/modules/providers/adapters/anikoto.ts')

before(async () => {
  anikoto = await import('../src/modules/providers/adapters/anikoto.ts')
})

beforeEach(() => { mock.restoreAll() })

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
      { id: 131868, number: 1, title: 'Episode 1', episode_embed_id: '169846', embed_url: { sub: 'https://harmadik.invalid/stream/169846/sub', dub: 'https://harmadik.invalid/stream/169846/dub' } },
      { id: 135471, number: 25, title: 'Episode 25', episode_embed_id: '337825', embed_url: { sub: 'https://harmadik.invalid/stream/337825/sub' } }
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

const rendes = (url: string) =>
  url.includes('/series/') ? { status: 200, body: SOROZAT } : { status: 200, body: KATALOGUS }

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

  it('sub kérésre sem ad forrást — csak beágyazó cím van', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'sub' })
    checkResult(r)
    assert.deepEqual(r.sources, [], 'beágyazó címet adott vissza forrásként')
  })

  it('dub kérésre sem', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'dub' })
    assert.deepEqual(r.sources, [])
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

    const r = await anikoto.anikotoProvider.resolve({ ...REF, number: 25, variant: 'dub' })

    assert.deepEqual(r.sources, [])
    assert.match(naplo.join('\n'), /dub/, 'a napló nem mondja meg, mi hiányzott')
  })

  it('raw kérésre nem ad sub/dub forrást', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, variant: 'raw' })
    assert.deepEqual(r.sources, [])
  })

  it('ismeretlen részre üres eredmény', async () => {
    halozat(rendes)
    const r = await anikoto.anikotoProvider.resolve({ ...REF, number: 999 })
    checkResult(r)
    assert.deepEqual(r.sources, [])
  })

  /*
   * A LEGFONTOSABB ÁLLÍTÁS. Ha valaki egyszer `kind: 'mp4'`-ként adná vissza
   * a beágyazó címet, a lejátszó egy HTML-lapot próbálna videóként
   * dekódolni. Ez a teszt a VISSZAADOTT CÍMEKRE megy rá, nem a kódra.
   */
  it('a beágyazó cím SOHA nem jelenik meg forrásként', async () => {
    halozat(rendes)
    for (const variant of ['sub', 'dub', 'raw', undefined] as const) {
      const r = await anikoto.anikotoProvider.resolve(
        variant ? { ...REF, variant } : REF)
      const cimek = JSON.stringify(r.sources)
      assert.ok(!cimek.includes('harmadik.invalid'),
        `beágyazó cím került a források közé (${variant ?? 'változat nélkül'}): ${cimek}`)
    }
  })

  it('a feloldás eljut a sorozatig — nem a számazonosítón hasal el', async () => {
    const { cimek } = halozat(rendes)
    await anikoto.anikotoProvider.resolve(REF)
    assert.ok(cimek.some(u => u.includes('/series/8717')),
      'a sorozatot meg sem kérdezte — a szám alakú azonosító elveszett: ' + JSON.stringify(cimek))
  })

  it('a diagnosztika megmondja, miért nincs forrás', async () => {
    const naplo: string[] = []
    mock.method(console, 'info', (...a: unknown[]) => { naplo.push(a.join(' ')) })
    halozat(rendes)

    await anikoto.anikotoProvider.resolve(REF)

    const uzenet = naplo.join('\n')
    assert.match(uzenet, /\[anikoto\]/)
    assert.match(uzenet, /beágyazó/, 'a napló nem mondja meg, hogy beágyazás miatt üres')
  })
})
