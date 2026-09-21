// Az általános HTTP-forrásadapter.
//
// Ez az adapter kétféle: MŰKÖDŐ (beállítva valódi forrást szolgál) és VÁZ
// (másolható kiindulópont). Mindkét szerepéhez ugyanaz kell: hogy a
// vízvezeték — időkorlát, 4xx/5xx, üres kontra kivétel, normalizálás — helyes
// legyen, mert épp azt örökli tőle, aki továbbfejleszti.

import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'

import { checkNoSecretsInHeaders, checkResult, checkShape } from './support/provider-contract.ts'

let feed: typeof import('../src/modules/providers/adapters/http-feed.ts')

before(async () => {
  feed = await import('../src/modules/providers/adapters/http-feed.ts')
})

beforeEach(() => { mock.restoreAll() })

const REF = { anilistId: 16498, malId: 16498, kitsuId: 7442, anidbId: 9541, title: 'Próba', number: 3 }
const CONFIG = { urlTemplate: 'https://sajat.pelda/api/{anilistId}/{episode}' }

/** A `fetch` lecserélése. Visszaadja a megkért címeket. */
function halozat (valasz: { status: number, body?: unknown } | Error | 'hang'): { cimek: string[] } {
  const cimek: string[] = []
  mock.method(globalThis, 'fetch', async (url: string, opts?: { signal?: AbortSignal }) => {
    cimek.push(String(url))
    if (valasz === 'hang') {
      return await new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    if (valasz instanceof Error) throw valasz
    return {
      ok: valasz.status >= 200 && valasz.status < 300,
      status: valasz.status,
      json: async () => valasz.body
    }
  })
  return { cimek }
}

const TELJES = {
  sources: [
    { url: 'https://sajat.pelda/1080.m3u8', kind: 'hls', variant: 'sub', label: '1. kiszolgáló', quality: '1080p', language: 'ja', headers: { Referer: 'https://sajat.pelda/' }, expiresAt: '2099-01-01T00:00:00Z' },
    { url: 'https://sajat.pelda/720.mp4', kind: 'mp4', variant: 'dub', language: 'en' }
  ],
  subtitles: [
    { url: 'https://sajat.pelda/en.vtt', language: 'en', format: 'vtt', isDefault: true },
    { url: 'https://sajat.pelda/hu.ass', language: 'hu', format: 'ass' }
  ]
}

describe('a HTTP-forrásadapter', () => {
  it('teljesíti a szerződést', () => {
    checkShape(feed.httpFeedProvider, 'a http-feed adapter')
  })

  /*
   * BEÁLLÍTÁS NÉLKÜL NEM CSINÁL SEMMIT — és ez a fontos rész: nem hibázik,
   * nem is kérdez. Így ártalmatlan bekapcsolva hagyni a láncban, amíg valaki
   * rá nem állítja egy címre.
   */
  it('beállítás nélkül nem kérdez, és nem hibázik', async () => {
    const { cimek } = halozat({ status: 200, body: TELJES })
    const r = await feed.httpFeedProvider.resolve(REF)
    assert.deepEqual(cimek, [], 'beállítás nélkül is kiment egy kérés')
    checkResult(r)
    assert.deepEqual(r.sources, [])
  })

  it('a sablon helyőrzőit kitölti', async () => {
    const { cimek } = halozat({ status: 200, body: TELJES })
    await feed.httpFeedProvider.resolve(REF, {
      urlTemplate: 'https://x/{anilistId}/{malId}/{kitsuId}/{anidbId}/{episode}'
    })
    assert.deepEqual(cimek, ['https://x/16498/16498/7442/9541/3'])
  })

  /*
   * AZ ÉRTÉKEK URL-KÓDOLVA MENNEK BE. Enélkül egy furcsa karakter elrontaná
   * az útvonalat — vagy ki is léphetne belőle.
   */
  it('a behelyettesített értéket kódolja', async () => {
    const { cimek } = halozat({ status: 200, body: TELJES })
    await feed.httpFeedProvider.resolve(
      { ...REF, variant: 'sub' },
      { urlTemplate: 'https://x/{variant}/{episode}' })
    assert.deepEqual(cimek, ['https://x/sub/3'])
  })

  it('a valódi választ a YUME modelljére képezi', async () => {
    halozat({ status: 200, body: TELJES })
    const r = await feed.httpFeedProvider.resolve(REF, CONFIG)

    checkResult(r, { expectSources: true })
    assert.equal(r.sources.length, 2)
    assert.deepEqual(r.sources.map(s => s.kind).sort(), ['hls', 'mp4'])
    assert.deepEqual(r.sources.map(s => s.variant).sort(), ['dub', 'sub'])
    assert.equal(r.sources[0]?.label, '1. kiszolgáló')
    assert.deepEqual(r.sources[0]?.headers, { Referer: 'https://sajat.pelda/' })
    assert.ok(r.sources[0]?.expiresAt instanceof Date)
    assert.equal(r.subtitles.length, 2)
    assert.equal(r.subtitles[0]?.isDefault, true)
  })

  /*
   * AMIT NEM ISMERÜNK FEL, AZT KIHAGYJUK, NEM TALÁLGATJUK. Egy `variant`
   * nélküli forrás nem „valószínűleg sub", és egy ismeretlen `kind` nem
   * „valószínűleg mp4" — abból néma lejátszó lesz.
   */
  it('a hiányos vagy ismeretlen forrást kihagyja', async () => {
    halozat({ status: 200, body: { sources: [
      { url: 'https://x/a.m3u8', kind: 'hls' },                    // nincs variant
      { url: 'https://x/b.mkv', kind: 'mkv', variant: 'sub' },     // ismeretlen kind
      { kind: 'hls', variant: 'sub' },                             // nincs url
      { url: 'https://x/d.m3u8', kind: 'hls', variant: 'sub' }     // ez a jó
    ] } })
    const r = await feed.httpFeedProvider.resolve(REF, CONFIG)
    assert.equal(r.sources.length, 1)
    assert.equal(r.sources[0]?.url, 'https://x/d.m3u8')
  })

  it('az értelmetlen lejáratot eldobja, nem tesz lejárt dátumot', async () => {
    halozat({ status: 200, body: { sources: [
      { url: 'https://x/a.m3u8', kind: 'hls', variant: 'sub', expiresAt: 'nem dátum' }
    ] } })
    const r = await feed.httpFeedProvider.resolve(REF, CONFIG)
    assert.equal(r.sources[0]?.expiresAt, undefined,
      'egy Invalid Date-ből a gyorsítótár azonnal lejárt bejegyzést csinálna')
  })

  // ---- üres eredmény kontra hiba ----

  it('a 404 üres eredmény, nem kivétel', async () => {
    halozat({ status: 404 })
    const r = await feed.httpFeedProvider.resolve(REF, CONFIG)
    checkResult(r)
    assert.deepEqual(r.sources, [])
  })

  it('az 500 KIVÉTEL, hogy a megszakító lássa', async () => {
    halozat({ status: 500 })
    await assert.rejects(() => feed.httpFeedProvider.resolve(REF, CONFIG), /HTTP 500/)
  })

  it('a hálózati hiba is kivétel', async () => {
    halozat(new Error('ECONNREFUSED'))
    await assert.rejects(() => feed.httpFeedProvider.resolve(REF, CONFIG), /ECONNREFUSED/)
  })

  it('az időkorlát megszakítja a kérést', async () => {
    halozat('hang')
    const kezdet = Date.now()
    await assert.rejects(() => feed.httpFeedProvider.resolve(REF, { ...CONFIG, timeoutMs: 150 }))
    assert.ok(Date.now() - kezdet < 3_000, 'az időkorlát nem hatott')
  })

  it('az üres válasz üres eredmény', async () => {
    halozat({ status: 200, body: {} })
    checkResult(await feed.httpFeedProvider.resolve(REF, CONFIG))
  })

  it('hibás alakú beállítás nem dönti össze', async () => {
    for (const c of ['szöveg', 42, true, [1, 2], null]) {
      const r = await feed.httpFeedProvider.resolve(REF, c as never)
      assert.deepEqual(r.sources, [], `elhasalt ezen: ${JSON.stringify(c)}`)
    }
  })

  it('nem szivárogtat titkot a fejlécekben', async () => {
    halozat({ status: 200, body: TELJES })
    checkNoSecretsInHeaders(await feed.httpFeedProvider.resolve(REF, CONFIG))
  })
})
