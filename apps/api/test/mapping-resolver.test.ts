// A külső azonosítók feloldója.
//
// Amit őriz, az nem egy szolgáltatás válasza — az holnap más lehet —, hanem a
// VISELKEDÉS: mikor kérdezünk, mikor nem, mi történik hibánál, és mit írunk
// vissza az adatbázisba. A hálózatot hamis leképezőkkel helyettesítjük; az
// igazi szolgáltatások élő ellenőrzése a `mapping-live.test.ts`-ben van.
//
// FUTÁSONKÉNT EGYEDI AZONOSÍTÓK. Az `anime_mappings` UNIQUE megszorítást tart
// az `anilist_id`, `mal_id` és `anidb_id` oszlopon. Rögzített próbaszámokkal
// (101, 102…) a készlet MÁSODIK futása elhasal a saját maradékán — ezt az
// első nekifutásom meg is tette, tizenkét bukással. Az alap véletlen, tehát
// minden futás a saját számtartományában dolgozik.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'mapping-resolver-secret-long-enough-0123456789'

let resolver: typeof import('../src/modules/providers/mapping/resolver.ts')
let types: typeof import('../src/modules/providers/mapping/types.ts')
let arm: typeof import('../src/modules/providers/mapping/upstreams/arm.ts')
let malsync: typeof import('../src/modules/providers/mapping/upstreams/malsync.ts')
let pool: { end: () => Promise<void>, query: (sql: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

const tag = 'map_' + randomBytes(4).toString('hex')
const keszult: string[] = []

const BASE = 3_000_000 + Math.floor(Math.random() * 400_000) * 10
let szamlalo = 0
/** Egy biztosan szabad azonosító. */
const uj = (): number => BASE + (szamlalo += 1)

type Mapping = Partial<Record<'anilist_id' | 'mal_id' | 'kitsu_id' | 'anidb_id', number>>

async function anime (mapping?: Mapping): Promise<string> {
  const id = String((await pool.query(
    `INSERT INTO anime (canonical_title, format, status, visibility)
     VALUES ($1, 'TV'::anime_format, 'FINISHED', 'public') RETURNING id`,
    [`${tag} ${keszult.length}`]
  )).rows[0]!.id)
  keszult.push(id)
  if (mapping) {
    await pool.query(
      'INSERT INTO anime_mappings (anime_id, anilist_id, mal_id, kitsu_id, anidb_id) VALUES ($1, $2, $3, $4, $5)',
      [id, mapping.anilist_id ?? null, mapping.mal_id ?? null, mapping.kitsu_id ?? null, mapping.anidb_id ?? null]
    )
  }
  return id
}

before(async () => {
  const db = await import('../src/infrastructure/database/index.ts')
  pool = db.pool as never
  resolver = await import('../src/modules/providers/mapping/resolver.ts')
  types = await import('../src/modules/providers/mapping/types.ts')
  arm = await import('../src/modules/providers/mapping/upstreams/arm.ts')
  malsync = await import('../src/modules/providers/mapping/upstreams/malsync.ts')
})

after(async () => {
  for (const id of keszult) await pool.query('DELETE FROM anime WHERE id = $1', [id]).catch(() => {})
  await pool?.end()
})

beforeEach(() => {
  mock.restoreAll()
  resolver.clearMappingCache()
})

/** A `fetch` lecserélése. `'hang'` = sosem válaszol (az időkorlátot méri). */
function halozat (valasz: (url: string) => { status: number, body?: unknown } | Error | 'hang'): { hivasok: string[] } {
  const hivasok: string[] = []
  mock.method(globalThis, 'fetch', async (url: string, opts?: { signal?: AbortSignal }) => {
    hivasok.push(String(url))
    const v = valasz(String(url))
    if (v === 'hang') {
      return await new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    if (v instanceof Error) throw v
    return {
      ok: v.status >= 200 && v.status < 300,
      status: v.status,
      json: async () => v.body,
      text: async () => JSON.stringify(v.body)
    }
  })
  return { hivasok }
}

describe('a leképezés feloldója', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  // ---- mikor NEM kérdezünk ----

  it('teljes leképezésnél EGYETLEN külső hívás sincs', async () => {
    const [a, b, c, d] = [uj(), uj(), uj(), uj()]
    const id = await anime({ anilist_id: a, mal_id: b, kitsu_id: c, anidb_id: d })
    const { hivasok } = halozat(() => ({ status: 200, body: { anilist: uj() } }))

    const ids = await resolver.resolveExternalIds(id)

    assert.deepEqual(hivasok, [], 'fölöslegesen megkérdeztük a leképezőt')
    assert.deepEqual(ids, { anilistId: a, malId: b, kitsuId: c, anidbId: d })
  })

  /*
   * Egy leképező AZONOSÍTÓBÓL indul. Horgony nélkül cím szerint kellene
   * keresni — és épp az a tévedés, amit el akarunk kerülni.
   */
  it('horgony nélkül sem kérdezünk', async () => {
    const id = await anime()
    const { hivasok } = halozat(() => ({ status: 200, body: { anilist: uj() } }))

    const ids = await resolver.resolveExternalIds(id)

    assert.deepEqual(hivasok, [])
    assert.deepEqual(ids, types.noIds())
  })

  // ---- részleges kiegészítés ----

  it('részleges leképezést kiegészít, és be is írja', async () => {
    const [a, b, c, d] = [uj(), uj(), uj(), uj()]
    const id = await anime({ anilist_id: a })
    halozat(() => ({ status: 200, body: { anilist: a, myanimelist: b, kitsu: c, anidb: d } }))

    const ids = await resolver.resolveExternalIds(id)
    assert.deepEqual(ids, { anilistId: a, malId: b, kitsuId: c, anidbId: d })

    const { rows } = await pool.query(
      'SELECT anilist_id, mal_id, kitsu_id, anidb_id FROM anime_mappings WHERE anime_id = $1', [id])
    assert.deepEqual(rows[0], { anilist_id: a, mal_id: b, kitsu_id: c, anidb_id: d })
  })

  /*
   * A LEKÉPEZÉS KIEGÉSZÍT, NEM JAVÍT. Amit a táblánk tud, azt valaki beírta
   * vagy egy metaadat-futás töltötte fel; egy külső szolgáltatás tévedése nem
   * írhatja felül.
   */
  it('a meglévő azonosítót NEM írja felül', async () => {
    const [a, b, c, d] = [uj(), uj(), uj(), uj()]
    const id = await anime({ anilist_id: a, mal_id: b })
    halozat(() => ({ status: 200, body: { anilist: uj(), myanimelist: uj(), kitsu: c, anidb: d } }))

    const ids = await resolver.resolveExternalIds(id)

    assert.equal(ids.anilistId, a, 'felülírta a meglévő AniList-azonosítót')
    assert.equal(ids.malId, b, 'felülírta a meglévő MAL-azonosítót')
    assert.equal(ids.kitsuId, c)
  })

  // ---- hibák ----

  it('üres upstream-válasz: marad, ami volt', async () => {
    const a = uj()
    const id = await anime({ anilist_id: a })
    halozat(() => ({ status: 200, body: {} }))
    assert.deepEqual(await resolver.resolveExternalIds(id), { anilistId: a, malId: null, kitsuId: null, anidbId: null })
  })

  it('HTTP 404: „nem ismeri", nem hiba', async () => {
    const a = uj()
    const id = await anime({ anilist_id: a })
    const { hivasok } = halozat(() => ({ status: 404, body: { message: 'nincs' } }))
    assert.equal((await resolver.resolveExternalIds(id)).anilistId, a)
    assert.ok(hivasok.length > 0, 'meg sem kérdeztük')
  })

  it('HTTP 500: a következő leképezőre lép', async () => {
    const [a, b, c] = [uj(), uj(), uj()]
    const id = await anime({ anilist_id: a, mal_id: b })
    const { hivasok } = halozat(url =>
      url.includes('arm.haglund.dev') ? { status: 500 } : { status: 200, body: { id: b, anidbId: c } })

    const ids = await resolver.resolveExternalIds(id)

    assert.ok(hivasok.some(u => u.includes('malsync')), 'nem lépett tovább a második leképezőre')
    assert.equal(ids.anidbId, c)
  })

  it('hálózati hiba: nem dob, azt adja, amit a tábla tud', async () => {
    const a = uj()
    const id = await anime({ anilist_id: a })
    halozat(() => new Error('ECONNREFUSED'))
    mock.method(console, 'warn', () => {})
    assert.equal((await resolver.resolveExternalIds(id)).anilistId, a)
  })

  it('értelmezhetetlen JSON: nem dönti össze', async () => {
    const a = uj()
    const id = await anime({ anilist_id: a })
    mock.method(globalThis, 'fetch', async () => ({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError('Unexpected token') },
      text: async () => 'nem json'
    }))
    mock.method(console, 'warn', () => {})
    assert.equal((await resolver.resolveExternalIds(id)).anilistId, a)
  })

  it('időtúllépés: megszakítjuk, és megyünk tovább', async () => {
    const a = uj()
    const id = await anime({ anilist_id: a })
    halozat(() => 'hang')
    mock.method(console, 'warn', () => {})
    const kezdet = Date.now()
    const ids = await resolver.resolveExternalIds(id)
    const eltelt = Date.now() - kezdet
    assert.equal(ids.anilistId, a)
    assert.ok(eltelt < 20_000, `${eltelt} ms — az időkorlát nem hatott`)
  })

  it('érvénytelen értéket (nulla, negatív, szöveg) eldob', async () => {
    const a = uj()
    const id = await anime({ anilist_id: a })
    halozat(() => ({ status: 200, body: { anilist: a, myanimelist: 0, kitsu: -5, anidb: 'x' } }))
    const ids = await resolver.resolveExternalIds(id)
    assert.equal(ids.malId, null, 'a nullát elfogadta azonosítónak')
    assert.equal(ids.kitsuId, null, 'a negatívat elfogadta')
    assert.equal(ids.anidbId, null, 'a szöveget elfogadta')
  })

  // ---- gyorsítótár és összevonás ----

  it('a második kérés a gyorsítótárból jön', async () => {
    const [a, b, c, d] = [uj(), uj(), uj(), uj()]
    const id = await anime({ anilist_id: a })
    const { hivasok } = halozat(() => ({ status: 200, body: { anilist: a, myanimelist: b, kitsu: c, anidb: d } }))

    await resolver.resolveExternalIds(id)
    const elso = hivasok.length
    await resolver.resolveExternalIds(id)

    assert.equal(hivasok.length, elso, 'a gyorsítótár nem fogott')
  })

  /*
   * HÚSZ KÉRÉS HELYETT EGY. Enélkül egy népszerű cím megjelenése húsz
   * egyforma kérést küldene egy ingyenes, önkéntes szolgáltatásnak.
   */
  it('húsz egyidejű kérésből egyetlen hívás lesz', async () => {
    const [a, b, c, d] = [uj(), uj(), uj(), uj()]
    const id = await anime({ anilist_id: a })
    let hivasok = 0
    mock.method(globalThis, 'fetch', async () => {
      hivasok++
      await new Promise(r => setTimeout(r, 60))
      return { ok: true, status: 200, json: async () => ({ anilist: a, myanimelist: b, kitsu: c, anidb: d }), text: async () => '' }
    })

    const eredmenyek = await Promise.all(Array.from({ length: 20 }, () => resolver.resolveExternalIds(id)))

    assert.equal(hivasok, 1, `${hivasok} kérés ment ki húsz helyett`)
    for (const r of eredmenyek) assert.equal(r.anidbId, d)
  })

  it('a futó kérés végén kiürül a nyilvántartás', async () => {
    const [a, b, c, d] = [uj(), uj(), uj(), uj()]
    const id = await anime({ anilist_id: a })
    halozat(() => ({ status: 200, body: { anilist: a, myanimelist: b, kitsu: c, anidb: d } }))
    await resolver.resolveExternalIds(id)
    assert.equal(resolver.mappingStats().inFlight, 0, 'ottmaradt egy futó kérés')
  })

  // ---- a beírás biztonsága ----

  /*
   * Az `anilist_id`, `mal_id` és `anidb_id` oszlopon UNIQUE áll. Ha egy
   * leképező olyan azonosítót ad, ami MÁR más címhez tartozik, az írás
   * megsértené a megszorítást — de a kiegészítés kényelem, nem az a dolga,
   * hogy egy lejátszásindítást megbuktasson.
   */
  it('ütköző azonosítónál nem hasal el, csak nem ír', async () => {
    const [a, b, c, d, e] = [uj(), uj(), uj(), uj(), uj()]
    await anime({ anilist_id: a, mal_id: b, kitsu_id: c, anidb_id: d })
    const masodik = await anime({ anilist_id: e })

    // A leképező az ELSŐ cím MAL-azonosítóját adja a másodikra — ütközés.
    halozat(() => ({ status: 200, body: { anilist: e, myanimelist: b, kitsu: uj(), anidb: uj() } }))
    mock.method(console, 'warn', () => {})

    const ids = await resolver.resolveExternalIds(masodik)

    // A memóriában megvan, amit megtudtunk — a lejátszás mehet tovább.
    assert.equal(ids.malId, b)
    // A táblában viszont nem lett ütközés.
    const { rows } = await pool.query('SELECT mal_id FROM anime_mappings WHERE anime_id = $1', [masodik])
    assert.notEqual(rows[0]?.mal_id, b, 'ütköző azonosítót írtunk be')
  })

  it('kétszeri feloldás nem hoz létre második sort', async () => {
    const [a, b, c, d] = [uj(), uj(), uj(), uj()]
    const id = await anime({ anilist_id: a })
    halozat(() => ({ status: 200, body: { anilist: a, myanimelist: b, kitsu: c, anidb: d } }))
    await resolver.resolveExternalIds(id)
    resolver.clearMappingCache()
    await resolver.resolveExternalIds(id)
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM anime_mappings WHERE anime_id = $1', [id])
    assert.equal(rows[0]!.n, 1)
  })

  // ---- az upstream adapterek külön ----

  it('az `arm` a 4xx-et nem hibának veszi', async () => {
    halozat(() => ({ status: 400, body: { message: 'Validation error' } }))
    const r = await arm.armUpstream.lookup({ anilistId: 1, malId: null, kitsuId: null, anidbId: null }, new AbortController().signal)
    assert.deepEqual(r, types.noIds())
  })

  it('a `malsync` MAL-azonosító nélkül meg sem szólal', async () => {
    const { hivasok } = halozat(() => ({ status: 200, body: {} }))
    const r = await malsync.malsyncUpstream.lookup(types.noIds(), new AbortController().signal)
    assert.deepEqual(hivasok, [])
    assert.deepEqual(r, types.noIds())
  })
})
