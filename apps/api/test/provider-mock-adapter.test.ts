// A minta-adapter — a szerződés bizonyítéka.
//
// Ez a készlet két dolgot csinál egyszerre:
//
//   1. MEGMUTATJA, hogy a `adapters/mock.ts` teljesíti a YUME szerződését —
//      vagyis hogy a dokumentációban leírt lépések tényleg elvezetnek egy
//      működő adapterhez;
//   2. ELLENŐRZI, hogy a szerződés maga nem változott meg a hátunk mögött. Ha
//      valaki holnap átír egy mezőt a `types.ts`-ben, ez a fájl elbukik.
//
// A minta adapter NINCS a `BUILT_IN` listában: `example.invalid` címeket ad,
// tehát éles láncban működő forrásnak látszó, lejátszhatatlan címeket
// szolgálna ki. Itt regisztráljuk, futásidőben — ugyanazzal a
// `registry.register()` hívással, amit a `registerBuiltInProviders()` használ.

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'provider-mock-secret-long-enough-0123456789'

let registry: typeof import('../src/modules/providers/registry.ts')
let health: typeof import('../src/modules/providers/health.ts')
let resolveMod: typeof import('../src/modules/providers/resolve.ts')
let mock: typeof import('../src/modules/providers/adapters/mock.ts')
let pool: { end: () => Promise<void>, query: (sql: string, p?: unknown[]) => Promise<unknown> }

before(async () => {
  const db = await import('../src/infrastructure/database/index.ts')
  pool = db.pool as never
  registry = await import('../src/modules/providers/registry.ts')
  health = await import('../src/modules/providers/health.ts')
  resolveMod = await import('../src/modules/providers/resolve.ts')
  mock = await import('../src/modules/providers/adapters/mock.ts')
})

after(async () => { await pool?.end() })

const REF = { anilistId: 1, title: 'Minta Sorozat', number: 1 }

describe('a minta-adapter', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  beforeEach(async () => {
    registry.reset()
    health.reset()
    resolveMod.clearCache()
    await pool.query('DELETE FROM providers')
    registry.forget()
    registry.register(mock.mockProvider)
  })

  // ---- 1. a szerződés alakja ----

  it('teljesíti az `AnimeProvider` szerződést', () => {
    const p = mock.mockProvider
    assert.equal(typeof p.id, 'string')
    assert.equal(typeof p.label, 'string')
    for (const metodus of ['search', 'episodes', 'resolve'] as const) {
      assert.equal(typeof p[metodus], 'function', `hiányzik a(z) ${metodus}`)
    }
  })

  it('NINCS a BUILT_IN listában — éles láncba nem kerülhet', async () => {
    const { readFileSync } = await import('node:fs')
    const index = readFileSync(new URL('../src/modules/providers/index.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(index, /mockProvider/,
      'a minta-adapter bekerült a BUILT_IN listába — `example.invalid` címeket szolgálna ki éles nézőknek')
  })

  // ---- 2. keresés ----

  it('AniList-azonosítóra keres, ha van', async () => {
    const talalat = await mock.mockProvider.search('teljesen más szöveg', { anilistId: 1 })
    assert.equal(talalat.length, 1)
    assert.equal(talalat[0]?.anilistId, 1)
  })

  it('találat nélkül ÜRES TÖMBÖT ad, nem hibát', async () => {
    assert.deepEqual(await mock.mockProvider.search('ilyen cím nincs'), [])
  })

  // ---- 3. epizódok ----

  it('ismeretlen azonosítóra KIVÉTELT dob, nem üres listát', async () => {
    await assert.rejects(() => mock.mockProvider.episodes('nincs-ilyen'), /ismeretlen azonosító/)
  })

  it('az epizód azonosítója a SZOLGÁLTATÓÉ, nem a miénk', async () => {
    const lista = await mock.mockProvider.episodes('mock-1')
    assert.equal(lista.length, 12)
    assert.equal(lista[0]?.number, 1)
    assert.match(String(lista[0]?.id), /^mock-1-ep1$/)
  })

  // ---- 4. feloldás: források ----

  it('a láncon át is feloldódik', async () => {
    const r = await resolveMod.resolveEpisode(REF)
    assert.equal(r.provider, 'mock')
    assert.ok(r.sources.length >= 3, JSON.stringify(r.attempts))
  })

  it('minden forrás deklarál változatot — ez KÖTELEZŐ mező', async () => {
    const r = await resolveMod.resolveEpisode(REF)
    for (const s of r.sources) {
      assert.ok(['sub', 'dub', 'raw'].includes(s.variant), `hiányzó vagy rossz változat: ${JSON.stringify(s)}`)
    }
  })

  it('HLS-t és MP4-et is ad, és mindkettő ismert szállítási forma', async () => {
    const r = await resolveMod.resolveEpisode(REF)
    const formak = new Set(r.sources.map(s => s.kind))
    assert.ok(formak.has('hls'), 'nincs HLS')
    assert.ok(formak.has('mp4'), 'nincs MP4 tartalék')
    for (const k of formak) assert.ok(['hls', 'dash', 'mp4'].includes(k), `ismeretlen forma: ${k}`)
  })

  it('minden forrásnak van saját NEVE, hogy a néző választani tudjon', async () => {
    const r = await resolveMod.resolveEpisode(REF)
    const nevek = r.sources.map(s => s.label)
    assert.ok(nevek.every(Boolean), 'névtelen forrás: ' + JSON.stringify(nevek))
    assert.equal(new Set(nevek).size, nevek.length, 'két forrás ugyanazt a nevet viseli')
  })

  it('a fejlécek átjönnek — enélkül a lejátszó néma marad', async () => {
    const r = await resolveMod.resolveEpisode(REF)
    assert.ok(r.sources.every(s => s.headers?.Referer), 'hiányzó Referer fejléc')
  })

  // ---- 5. változatok ----

  it('változat nélkül mindkettőt adja', async () => {
    const r = await resolveMod.resolveEpisode(REF)
    const v = new Set(r.sources.map(s => s.variant))
    assert.deepEqual([...v].sort(), ['dub', 'sub'])
  })

  it('a `?variant=dub` csak szinkronosat ad', async () => {
    const r = await resolveMod.resolveEpisode({ ...REF, variant: 'dub' })
    assert.ok(r.sources.length > 0)
    assert.ok(r.sources.every(s => s.variant === 'dub'))
  })

  // ---- 6. feliratok ----

  it('MINDEGYIK angol sáv megmarad, nem választ helyettünk', async () => {
    const r = await resolveMod.resolveEpisode(REF)
    const en = r.subtitles.filter(s => s.language === 'en')
    assert.equal(en.length, 2, 'egy angol sáv eltűnt — a szűrés nem az adapter dolga')
    assert.deepEqual(en.map(s => s.format).sort(), ['ass', 'vtt'])
  })

  it('a feliratsávok formátuma a szerződésben szereplő három egyike', async () => {
    const r = await resolveMod.resolveEpisode(REF)
    for (const s of r.subtitles) {
      assert.ok(['vtt', 'ass', 'srt'].includes(s.format), `ismeretlen formátum: ${s.format}`)
      assert.ok(['subtitles', 'captions'].includes(s.kind))
      assert.equal(typeof s.language, 'string')
      assert.ok(s.url.length > 0)
    }
  })

  // ---- 7. lejárat ----

  it('a lejáratot a resolver veszi át, nem a saját élettartamát', async () => {
    const r = await resolveMod.resolveEpisode(REF)
    const alairt = r.sources.find(s => s.expiresAt)
    assert.ok(alairt, 'a minta nem adott lejáratot egyetlen forráshoz sem')
    assert.ok(new Date(alairt.expiresAt as Date).getTime() > Date.now())
  })

  // ---- 8. üres eredmény kontra hiba ----

  it('ismeretlen címre ÜRES EREDMÉNY jön, és ez nem rontja az egészséget', async () => {
    const r = await resolveMod.resolveEpisode({ anilistId: 9999, title: 'Nincs ilyen', number: 1 })
    assert.equal(r.provider, null)
    assert.deepEqual(r.attempts.map(a => a.outcome), ['empty'])
    assert.equal(health.state('mock'), 'up', 'az üres eredmény kizárta a szolgáltatót')
  })

  it('hibára KIVÉTEL megy, és az rontja az egészséget', async () => {
    for (let i = 0; i < 3; i++) await resolveMod.resolveEpisode({ ...REF, number: 13 })
    assert.equal(health.state('mock'), 'down',
      'a kivételt elnyeltük valahol — a megszakító sosem nyitna ki')
  })

  // ---- 9. kapcsoló ----

  it('kikapcsolva meg sem kérdezzük', async () => {
    await registry.setState('mock', { enabled: false })
    resolveMod.clearCache()
    const r = await resolveMod.resolveEpisode(REF)
    assert.equal(r.provider, null)
    assert.deepEqual(r.attempts, [])
  })
})
