// A forrásvégpont a szolgáltatói láncon át.
//
// A `/v1/anime/episodes/:id/sources` eddig KÖZVETLENÜL olvasta a
// `video_sources` táblát. Most a lánc szolgálja ki — és ez négy új ígéret,
// amit a régi tesztek nem mérnek, mert akkor még nem volt mit:
//
//   1. a válasz megmondja, KI oldotta fel, és mi történt a láncban;
//   2. egy kikapcsolt szolgáltató forrásai eltűnnek, akkor is, ha a sorok
//      ott vannak a táblában — ez a kapcsoló egyetlen érdemi ígérete;
//   3. a forrás NEVE megmarad (amit az üzemeltető beírt), nem cserélődik le a
//      feloldó szolgáltató nevére;
//   4. a `?variant=` szűr, a hiánya viszont MINDENT ad — nem `sub`-ot.
//
// A 3. és a 4. pont nem elméleti: mindkettőt a bekötés közben rontottam el
// először, és mindkettőt egy meglévő teszt fogta meg.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { publicInstance } from './support/instance.ts'

import type { FastifyInstance } from 'fastify'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'provider-endpoint-secret-long-enough-0123456789'

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
let registry: typeof import('../src/modules/providers/registry.ts')
let resolveMod: typeof import('../src/modules/providers/resolve.ts')
let health: typeof import('../src/modules/providers/health.ts')

let animeId: string
let episodeId: string
const tag = 'psrc_' + randomBytes(4).toString('hex')

interface Body {
  data: Array<{ ref: string, provider: string | null, resolved_by: string | null, variant: string, kind: string }>
  provider: string | null
  cached: boolean
  attempts: Array<{ provider: string, outcome: string }>
}

describe('a forrásvégpont a láncon át', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  publicInstance()

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
    registry = await import('../src/modules/providers/registry.ts')
    resolveMod = await import('../src/modules/providers/resolve.ts')
    health = await import('../src/modules/providers/health.ts')

    animeId = String((await pool.query(
      `INSERT INTO anime (canonical_title, format, status, visibility)
       VALUES ($1, 'TV'::anime_format, 'FINISHED', 'public') RETURNING id`,
      [tag + ' cím']
    )).rows[0]!.id)
    episodeId = String((await pool.query(
      "INSERT INTO episodes (anime_id, number, title, visibility) VALUES ($1, 1, 'Egy', 'public') RETURNING id",
      [animeId]
    )).rows[0]!.id)

    // Két forrás, kétféle változattal és SAJÁT NÉVVEL.
    for (const [ref, provider, variant] of [
      ['https://pelda.invalid/sub.m3u8', 'Első tükör', 'sub'],
      ['https://pelda.invalid/dub.m3u8', 'Második tükör', 'dub']
    ]) {
      await pool.query(
        `INSERT INTO video_sources (episode_id, kind, ref, provider, variant, accuracy)
         VALUES ($1, 'http', $2, $3, $4, 'high')`,
        [episodeId, ref, provider, variant]
      )
    }
  })

  after(async () => {
    await pool.query('DELETE FROM anime WHERE id = $1', [animeId]).catch(() => {})
    await pool.query("DELETE FROM providers WHERE slug = 'yume-local'").catch(() => {})
    registry.forget()
    await app?.close()
    await pool?.end()
  })

  const get = async (q = ''): Promise<Body> => {
    resolveMod.clearCache()
    health.reset()
    const res = await app.inject({ url: `/v1/anime/episodes/${episodeId}/sources${q}` })
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as Body
  }

  it('a lánc szolgálja ki, és meg is mondja, ki oldotta fel', async () => {
    const body = await get()
    assert.equal(body.provider, 'yume-local')
    assert.ok(body.data.length > 0, 'a lánc nem adott vissza forrást')
    assert.ok(body.data.every(s => s.resolved_by === 'yume-local'))
  })

  /*
   * Egy „nincs forrás" válaszra a kérdés az, hogy MIÉRT — erre az üres tömb
   * nem felelet. A lánc naplója azért van a válaszban, hogy legyen.
   */
  it('a lánc minden lépése benne van a válaszban', async () => {
    const body = await get()
    assert.ok(Array.isArray(body.attempts))
    assert.deepEqual(body.attempts.map(a => [a.provider, a.outcome]), [['yume-local', 'ok']])
  })

  /*
   * A KAPCSOLÓ EGYETLEN ÉRDEMI ÍGÉRETE. A sorok a táblában maradnak — mégsem
   * jut belőlük semmi a nézőhöz.
   */
  it('kikapcsolt szolgáltatóval nincs forrás, pedig a sorok ott vannak', async () => {
    await registry.setState('yume-local', { enabled: false })
    try {
      const body = await get()
      assert.deepEqual(body.data, [])
      assert.equal(body.provider, null)
      assert.deepEqual(body.attempts, [], 'a kikapcsolt szolgáltató még a láncban is szerepel')

      const { rows } = await pool.query('SELECT count(*) AS n FROM video_sources WHERE episode_id = $1', [episodeId])
      assert.ok(Number(rows[0]!.n) >= 2, 'a kikapcsolás törölte a sorokat — nem ezt kértük')
    } finally {
      await registry.setState('yume-local', { enabled: true })
      resolveMod.clearCache()
    }
  })

  /*
   * A FORRÁS NEVE MEGMARAD. Ha ide a feloldó szolgáltató neve kerülne, három
   * különböző kiszolgáló háromszor ugyanannak látszana, és a nézőnek nem
   * lenne mi alapján választania.
   */
  it('a forrás neve az marad, amit az üzemeltető beírt', async () => {
    const body = await get()
    const nevek = body.data.map(s => s.provider).sort()
    assert.deepEqual(nevek, ['Első tükör', 'Második tükör'])
  })

  it('a `?variant=` szűr', async () => {
    const dub = await get('?variant=dub')
    assert.deepEqual(dub.data.map(s => s.variant), ['dub'])
    const sub = await get('?variant=sub')
    assert.deepEqual(sub.data.map(s => s.variant), ['sub'])
  })

  /*
   * A HIÁNYZÓ VÁLTOZAT MINDENT JELENT, nem `sub`-ot. Ha `sub`-ot jelentene,
   * a bekötés csendben kizárta volna a szinkronos forrásokat — a néző pedig
   * azt látná, hogy nincs, miközben van.
   */
  it('változat nélkül mindkettő megjön', async () => {
    const body = await get()
    assert.deepEqual(body.data.map(s => s.variant).sort(), ['dub', 'sub'])
  })

  it('a szállítási forma is kimegy, hogy a lejátszó tudja, mit indítson', async () => {
    const body = await get()
    assert.ok(body.data.every(s => ['hls', 'dash', 'mp4'].includes(s.kind)), JSON.stringify(body.data))
  })
})
