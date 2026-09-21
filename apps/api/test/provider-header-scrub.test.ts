// A fejlécek megtisztítása — futásidőben.
//
// A `ProviderSource.headers` tartalma a `/v1/anime/episodes/:id/sources`
// válaszában KIMEGY A BÖNGÉSZŐNEK: ez a mező pont azért van, hogy a lejátszó
// ugyanazokkal a fejlécekkel kérje a szegmenseket. Ami ide bekerül, azt minden
// néző látja a hálózati naplójában.
//
// AMI AZ AUDIT ELŐTT VOLT: az egyetlen védelem egy TESZT-SEGÉD
// (`checkNoSecretsInHeaders`), tehát csak akkor futott le, ha az adapter
// szerzője megírta hozzá a tesztet. Aki nem írt, észrevétlenül szivárogtatott.
// A mintája ráadásul hat nevet ismert, pontos egyezéssel — a `Set-Cookie`
// kimaradt belőle, és egy `X-Vendor-Session-Token` átment rajta.

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'provider-scrub-secret-long-enough-0123456789'

let scrub: typeof import('../src/modules/providers/scrub.ts')
let registry: typeof import('../src/modules/providers/registry.ts')
let health: typeof import('../src/modules/providers/health.ts')
let resolveMod: typeof import('../src/modules/providers/resolve.ts')
let pool: { end: () => Promise<void>, query: (sql: string, p?: unknown[]) => Promise<unknown> }

before(async () => {
  const db = await import('../src/infrastructure/database/index.ts')
  pool = db.pool as never
  scrub = await import('../src/modules/providers/scrub.ts')
  registry = await import('../src/modules/providers/registry.ts')
  health = await import('../src/modules/providers/health.ts')
  resolveMod = await import('../src/modules/providers/resolve.ts')
})

after(async () => { await pool?.end() })

describe('a fejlécszűrő szabálya', () => {
  it('kiszűri a klasszikusokat, a kis/nagybetűtől függetlenül', () => {
    for (const nev of [
      'Authorization', 'authorization', 'AUTHORIZATION',
      'Cookie', 'Set-Cookie', 'set-cookie2',
      'Proxy-Authorization', 'WWW-Authenticate',
      'X-API-Key', 'api-key', 'ApiKey',
      'X-Auth-Token', 'X-CSRF-Token', 'X-Session-Id',
      'X-Amz-Security-Token'
    ]) {
      assert.equal(scrub.isSensitiveHeader(nev), true, `átengedte: ${nev}`)
    }
  })

  /*
   * EGY FEJLÉC NEM ATTÓL TITOK, HOGY `Authorization` A NEVE. A pontos lista
   * sosem lesz teljes — egy szolgáltató a saját nevén hívja a sajátját.
   */
  it('kiszűri az egyedi nevű titkokat is', () => {
    for (const nev of [
      'X-Vendor-Session-Token', 'x-refresh-token', 'X-Client-Secret',
      'X-Signed-Credential', 'My-Password', 'X-Bearer', 'x-playback-key'
    ]) {
      assert.equal(scrub.isSensitiveHeader(nev), true, `átengedte: ${nev}`)
    }
  })

  /*
   * A NEGATÍV ESET LEGALÁBB ENNYIRE FONTOS. Egy túl mohó szűrő a `Referer`-t
   * vagy a `User-Agent`-et venné el — és akkor a lejátszólista betöltődik, a
   * videó néma marad, ami a naplóban SIKERNEK látszik.
   */
  it('átengedi azt, ami a lejátszáshoz kell', () => {
    for (const nev of [
      'Referer', 'referer', 'Origin', 'User-Agent', 'Accept',
      'Accept-Language', 'Range', 'X-Forwarded-For', 'X-Monkey-Name'
    ]) {
      assert.equal(scrub.isSensitiveHeader(nev), false, `feleslegesen elvette: ${nev}`)
    }
  })

  it('az értéket soha nem adja vissza, csak a nevet', () => {
    const { kept, removed } = scrub.scrubHeaders({
      Referer: 'https://pelda.invalid/',
      Authorization: 'Bearer NAGYON-TITKOS-ERTEK'
    })
    assert.deepEqual(kept, { Referer: 'https://pelda.invalid/' })
    assert.deepEqual(removed, ['Authorization'])
    assert.ok(!JSON.stringify(removed).includes('NAGYON-TITKOS'),
      'az eltávolított fejléc ÉRTÉKE is kikerült')
  })

  it('hiányzó fejléckészletre nem hasal el', () => {
    assert.deepEqual(scrub.scrubHeaders(undefined), { kept: {}, removed: [] })
  })
})

describe('a lánc megtisztítja az eredményt', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  beforeEach(async () => {
    registry.reset()
    health.reset()
    resolveMod.clearCache()
    await pool.query('DELETE FROM providers')
    registry.forget()
  })

  /** Egy adapter, ami titkot ad vissza — a hiba, amit meg kell fogni. */
  const szivargo = {
    id: 'szivargo',
    label: 'Szivárgó',
    async search () { return [] },
    async episodes () { return [] },
    async resolve () {
      return {
        sources: [{
          kind: 'hls' as const,
          url: 'https://pelda.invalid/x.m3u8',
          variant: 'sub' as const,
          headers: {
            Referer: 'https://pelda.invalid/',
            Authorization: 'Bearer TITOK',
            'X-Vendor-Session-Token': 'SESSION-TITOK'
          }
        }],
        subtitles: [{
          language: 'en',
          kind: 'subtitles' as const,
          format: 'vtt' as const,
          url: 'https://pelda.invalid/en.vtt',
          headers: { Cookie: 'sid=TITOK', Referer: 'https://pelda.invalid/' }
        }]
      }
    }
  }

  const REF = { anilistId: 1, title: 'Bármi', number: 1 }

  it('a forrás fejlécéből eltűnik a titok, a Referer marad', async () => {
    registry.register(szivargo as never)
    const r = await resolveMod.resolveEpisode(REF)

    assert.equal(r.sources.length, 1)
    assert.deepEqual(r.sources[0]?.headers, { Referer: 'https://pelda.invalid/' })
  })

  it('a feliratsáv fejlécéből is', async () => {
    registry.register(szivargo as never)
    const r = await resolveMod.resolveEpisode(REF)
    assert.deepEqual(r.subtitles[0]?.headers, { Referer: 'https://pelda.invalid/' })
  })

  /*
   * NEM CSENDBEN. Az adapter szerzőjének meg kell tudnia, hogy amit beírt,
   * nem megy ki — különben azt hiszi, elküldtük, és a forrást hibásnak látja.
   */
  it('szól róla a naplóban — a nevekkel, az értékek nélkül', async () => {
    const sorok: string[] = []
    const eredeti = console.warn
    console.warn = (...a: unknown[]) => { sorok.push(a.join(' ')) }
    try {
      registry.register(szivargo as never)
      await resolveMod.resolveEpisode(REF)
    } finally {
      console.warn = eredeti
    }

    const uzenet = sorok.join('\n')
    assert.match(uzenet, /szivargo/)
    assert.match(uzenet, /Authorization/)
    assert.ok(!uzenet.includes('TITOK'), 'a napló tartalmazza a fejléc ÉRTÉKÉT')
  })
})
