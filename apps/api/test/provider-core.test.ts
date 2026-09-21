// A providerréteg — a szerződés, a lánc és a kapcsoló.
//
// HÁROM DOLGOT ŐRIZ, ÉS MIND A HÁROM OLYAN, AMIN EGY ILYEN RÉTEG ELBUKIK:
//
//   1. A SZERZŐDÉS. Minden adapternek ugyanazt kell jelentenie ugyanarra a
//      helyzetre. A leggyakoribb hiba az, hogy egy adapter egy hibára üres
//      tömböt ad — attól a megszakító sosem nyit ki, és egy halott
//      szolgáltató örökre a lánc elején marad.
//
//   2. A LÁNC. Az első, aki forrást ad, nyer; aki hibázik, azt átlépjük; aki
//      lassú, az időtúllépéssel esik ki. És MINDEGYIK lépés naplóba kerül —
//      egy „nincs forrás" válaszra a kérdés az, hogy miért, és arra egy üres
//      tömb nem felelet.
//
//   3. A KAPCSOLÓ. Egy kikapcsolt szolgáltatót meg sem szabad kérdezni. Ez a
//      rendszer egyetlen ígérete arra, hogy egy megszűnt oldal eltávolítása
//      nem telepítés.
//
// A tesztek HAMIS adaptereket használnak, nem hálózatot: a mérés tárgya a
// réteg viselkedése, nem egy külső kiszolgáló elérhetősége.

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'provider-core-test-secret-long-enough-0123456789'

let registry: typeof import('../src/modules/providers/registry.ts')
let health: typeof import('../src/modules/providers/health.ts')
let resolveMod: typeof import('../src/modules/providers/resolve.ts')
let types: typeof import('../src/modules/providers/types.ts')
let pool: { end: () => Promise<void>, query: (sql: string, p?: unknown[]) => Promise<unknown> }

before(async () => {
  const db = await import('../src/infrastructure/database/index.ts')
  pool = db.pool as never
  registry = await import('../src/modules/providers/registry.ts')
  health = await import('../src/modules/providers/health.ts')
  resolveMod = await import('../src/modules/providers/resolve.ts')
  types = await import('../src/modules/providers/types.ts')
})

after(async () => { await pool?.end() })

/** Egy hamis adapter, aminek megmondjuk, hogyan viselkedjen. */
function fake (id: string, viselkedes: {
  sources?: number
  dobjon?: boolean
  lassu?: number
  priority?: number
}): import('../src/modules/providers/types.ts').AnimeProvider {
  return {
    id,
    label: id,
    defaultPriority: viselkedes.priority ?? 100,
    async search () { return [] },
    async episodes () { return [] },
    async resolve () {
      if (viselkedes.lassu) await new Promise(r => setTimeout(r, viselkedes.lassu))
      if (viselkedes.dobjon) throw new Error('szándékos hiba: ' + id)
      const n = viselkedes.sources ?? 0
      return {
        sources: Array.from({ length: n }, (_, i) => ({
          kind: 'hls' as const, url: `https://pelda.invalid/${id}/${i}.m3u8`, variant: 'sub' as const
        })),
        subtitles: []
      }
    }
  }
}

const REF = { anilistId: 1, title: 'Próba', number: 1, variant: 'sub' as const }

describe('a providerréteg', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  beforeEach(async () => {
    registry.reset()
    health.reset()
    resolveMod.clearCache()
    await pool.query('DELETE FROM providers')
    await pool.query('DELETE FROM provider_events')
    registry.forget()
  })

  // ---- a lánc ----

  it('az első, aki forrást ad, nyer — a többit meg sem kérdezzük', async () => {
    let masodikatKerdeztek = false
    registry.register(fake('elso', { sources: 2, priority: 1 }))
    registry.register({
      ...fake('masodik', { sources: 5, priority: 2 }),
      async resolve () { masodikatKerdeztek = true; return types.noResult() }
    })

    const r = await resolveMod.resolveEpisode(REF)

    assert.equal(r.provider, 'elso')
    assert.equal(r.sources.length, 2)
    assert.equal(masodikatKerdeztek, false, 'a lánc a találat után is továbbment')
  })

  it('a hibázót átlépi, és a következő adja az eredményt', async () => {
    registry.register(fake('rossz', { dobjon: true, priority: 1 }))
    registry.register(fake('jo', { sources: 1, priority: 2 }))

    const r = await resolveMod.resolveEpisode(REF)

    assert.equal(r.provider, 'jo')
    assert.deepEqual(r.attempts.map(a => [a.provider, a.outcome]), [['rossz', 'error'], ['jo', 'ok']])
  })

  /*
   * Az ÜRES VÁLASZ NEM HIBA — a szolgáltató felelt, csak nincs nála semmi.
   * Ha ezt is büntetnénk, egy ritka cím kizárná az egész szolgáltatót.
   */
  it('az üres válasz nem hiba, és nem nyitja ki a megszakítót', async () => {
    registry.register(fake('ures', { sources: 0 }))

    for (let i = 0; i < 5; i++) await resolveMod.resolveEpisode({ ...REF, number: i + 1 })

    assert.equal(health.state('ures'), 'up', 'egy üres válasz kizárta a szolgáltatót')
  })

  it('minden lépés a naplóba kerül, akkor is, ha senki nem ad semmit', async () => {
    registry.register(fake('a', { sources: 0, priority: 1 }))
    registry.register(fake('b', { dobjon: true, priority: 2 }))

    const r = await resolveMod.resolveEpisode(REF)

    assert.equal(r.provider, null)
    assert.equal(r.sources.length, 0)
    assert.deepEqual(r.attempts.map(a => a.provider), ['a', 'b'],
      'egy „nincs forrás" válaszra a kérdés az, hogy miért — erre az üres tömb nem felelet')
  })

  it('a lassú szolgáltató időtúllépéssel esik ki, nem várakoztat örökké', async () => {
    registry.register(fake('lassu', { lassu: 9_000, sources: 1, priority: 1 }))
    registry.register(fake('gyors', { sources: 1, priority: 2 }))

    const kezdet = Date.now()
    const r = await resolveMod.resolveEpisode(REF)
    const eltelt = Date.now() - kezdet

    assert.equal(r.provider, 'gyors')
    assert.equal(r.attempts[0]?.outcome, 'timeout')
    assert.ok(eltelt < 8_900, `a lánc ${eltelt} ms-ig tartott — a korlát nem hatott`)
  })

  // ---- a kapcsoló ----

  it('a kikapcsolt szolgáltatót MEG SEM KÉRDEZZÜK', async () => {
    let kerdeztek = false
    registry.register({
      ...fake('kikapcsolt', { sources: 1, priority: 1 }),
      async resolve () { kerdeztek = true; return { sources: [], subtitles: [] } }
    })
    registry.register(fake('masik', { sources: 1, priority: 2 }))

    await registry.setState('kikapcsolt', { enabled: false })
    resolveMod.clearCache()
    const r = await resolveMod.resolveEpisode(REF)

    assert.equal(kerdeztek, false, 'a kikapcsolt szolgáltatót meghívtuk')
    assert.equal(r.provider, 'masik')
    assert.ok(!r.attempts.some(a => a.provider === 'kikapcsolt'),
      'a kikapcsolt szolgáltató még a láncban is szerepel')
  })

  it('a visszakapcsolás ugyanígy azonnal hat', async () => {
    registry.register(fake('sz', { sources: 1 }))
    await registry.setState('sz', { enabled: false })
    resolveMod.clearCache()
    assert.equal((await resolveMod.resolveEpisode(REF)).provider, null)

    await registry.setState('sz', { enabled: true })
    resolveMod.clearCache()
    assert.equal((await resolveMod.resolveEpisode(REF)).provider, 'sz')
  })

  it('a sorrendet a prioritás dönti, nem a regisztráció sorrendje', async () => {
    registry.register(fake('kesobb', { sources: 1, priority: 5 }))
    registry.register(fake('elobb', { sources: 1, priority: 1 }))

    assert.equal((await resolveMod.resolveEpisode(REF)).provider, 'elobb')

    await registry.setState('kesobb', { priority: 0 })
    resolveMod.clearCache()
    assert.equal((await resolveMod.resolveEpisode(REF)).provider, 'kesobb')
  })

  /*
   * A sor HIÁNYA nem kikapcsolás. Egy frissen telepített adapter működjön
   * anélkül, hogy valaki kézzel felvenné — a kikapcsolás a kifejezett döntés.
   */
  it('a táblában nem szereplő szolgáltató be van kapcsolva', async () => {
    registry.register(fake('uj', { sources: 1 }))
    assert.equal((await resolveMod.resolveEpisode(REF)).provider, 'uj')
  })

  // ---- a megszakító ----

  it('három egymás utáni hiba után kizárja a szolgáltatót', async () => {
    registry.register(fake('romlo', { dobjon: true }))

    for (let i = 0; i < 3; i++) await resolveMod.resolveEpisode({ ...REF, number: i + 1 })
    assert.equal(health.state('romlo'), 'down')

    const r = await resolveMod.resolveEpisode({ ...REF, number: 99 })
    assert.equal(r.attempts[0]?.outcome, 'skipped',
      'a kizárt szolgáltatót továbbra is megkérdezzük — a megszakító nem véd semmitől')
  })

  it('egy sikeres válasz után nullázza a hibasorozatot', async () => {
    let dobjon = true
    registry.register({
      ...fake('ingadozo', {}),
      async resolve () {
        if (dobjon) throw new Error('most hiba')
        return { sources: [{ kind: 'hls' as const, url: 'https://pelda.invalid/x.m3u8', variant: 'sub' as const }], subtitles: [] }
      }
    })

    await resolveMod.resolveEpisode({ ...REF, number: 1 })
    await resolveMod.resolveEpisode({ ...REF, number: 2 })
    dobjon = false
    await resolveMod.resolveEpisode({ ...REF, number: 3 })
    dobjon = true
    await resolveMod.resolveEpisode({ ...REF, number: 4 })

    assert.equal(health.state('ingadozo'), 'up',
      'a hibasorozat nem nullázódott — két régi hiba egy friss sikerrel együtt kizárást okoz')
  })

  it('az állapotváltozás naplóba kerül, hogy legyen mit megnézni utólag', async () => {
    registry.register(fake('naplozo', { dobjon: true }))
    for (let i = 0; i < 3; i++) await resolveMod.resolveEpisode({ ...REF, number: i + 1 })
    // A naplóírás nem blokkol; adunk neki egy kört.
    await new Promise(r => setTimeout(r, 300))

    const sorok = await health.history('naplozo')
    assert.ok(sorok.length > 0, 'a kizárásról nem keletkezett esemény')
    assert.equal(sorok[0]?.event, 'down')
  })

  // ---- a gyorsítótár ----

  it('a második kérés a gyorsítótárból jön, nem a szolgáltatótól', async () => {
    let hivasok = 0
    registry.register({
      ...fake('cache', {}),
      async resolve () {
        hivasok++
        return { sources: [{ kind: 'hls' as const, url: 'https://pelda.invalid/c.m3u8', variant: 'sub' as const }], subtitles: [] }
      }
    })

    const a = await resolveMod.resolveEpisode(REF)
    const b = await resolveMod.resolveEpisode(REF)

    assert.equal(hivasok, 1, 'a gyorsítótár nem fogott')
    assert.equal(a.fromCache, false)
    assert.equal(b.fromCache, true)
  })

  /*
   * A VÁLTOZAT A KULCS RÉSZE. Enélkül egy feliratos kérés válaszát kapná
   * vissza az is, aki szinkronosat kért — és a hiba csak a lejátszóban
   * derülne ki, rossz hangsávként.
   */
  it('a feliratos és a szinkronos kérés nem keveredik a gyorsítótárban', async () => {
    const kertek: string[] = []
    registry.register({
      ...fake('valtozat', {}),
      async resolve (ref) {
        kertek.push(ref.variant ?? 'sub')
        return { sources: [{ kind: 'hls' as const, url: 'https://pelda.invalid/v.m3u8', variant: ref.variant ?? 'sub' }], subtitles: [] }
      }
    })

    await resolveMod.resolveEpisode({ ...REF, variant: 'sub' })
    await resolveMod.resolveEpisode({ ...REF, variant: 'dub' })

    assert.deepEqual(kertek, ['sub', 'dub'], 'a szinkronos kérés a feliratos válaszát kapta')
  })

  /*
   * A HIÁNYT NEM TÁROLJUK. Különben amikor öt perc múlva egy szolgáltató
   * helyreáll, a néző még mindig azt látja, hogy nincs forrás.
   */
  it('az üres eredmény nem kerül a gyorsítótárba', async () => {
    let hivasok = 0
    registry.register({
      ...fake('semmi', {}),
      async resolve () { hivasok++; return types.noResult() }
    })

    await resolveMod.resolveEpisode(REF)
    await resolveMod.resolveEpisode(REF)

    assert.equal(hivasok, 2, 'a hiányt gyorsítótáraztuk — egy helyreállt szolgáltató sem látszana')
  })

  it('a szolgáltató lejárata erősebb, mint a saját élettartamunk', async () => {
    let hivasok = 0
    registry.register({
      ...fake('lejaro', {}),
      async resolve () {
        hivasok++
        return {
          sources: [{
            kind: 'hls' as const, url: 'https://pelda.invalid/l.m3u8', variant: 'sub' as const,
            expiresAt: new Date(Date.now() + 120) // 120 ms
          }],
          subtitles: []
        }
      }
    })

    await resolveMod.resolveEpisode(REF)
    await new Promise(r => setTimeout(r, 250))
    await resolveMod.resolveEpisode(REF)

    assert.equal(hivasok, 2, 'lejárt címet szolgáltunk ki a saját öt perces élettartamunk miatt')
  })
})
