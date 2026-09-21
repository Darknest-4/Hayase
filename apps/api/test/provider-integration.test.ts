// A TELJES LÁNC — az adatbázistól a végpont válaszáig.
//
// Nem egy réteget mér, hanem az utat: mi jut el ténylegesen az adapterhez, és
// mi jut vissza a kliensnek. Ezt egy megfigyelő adapterrel csinálja, ami
// FELJEGYZI, amit kapott — így nem a kód olvasásából következtetünk arra,
// hogy egy mező átmegy, hanem látjuk.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { publicInstance } from './support/instance.ts'

import type { FastifyInstance } from 'fastify'
import type { EpisodeRef } from '../src/modules/providers/types.ts'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'provider-integration-secret-long-enough-0123456789'

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
let registry: typeof import('../src/modules/providers/registry.ts')
let health: typeof import('../src/modules/providers/health.ts')
let resolveMod: typeof import('../src/modules/providers/resolve.ts')

let animeId: string
let episodeId: string
const tag = 'pint_' + randomBytes(4).toString('hex')

/** Amit az adapter KAPOTT. Ez a mérőműszer. */
let kapott: { ref: EpisodeRef | null, config: unknown } = { ref: null, config: undefined }

const megfigyelo = {
  id: 'megfigyelo',
  label: 'Megfigyelő',
  defaultPriority: 1,
  async search () { return [] },
  async episodes () { return [] },
  async resolve (ref: EpisodeRef, config?: Record<string, unknown>) {
    kapott = { ref, config }
    return {
      sources: [{
        kind: 'hls' as const,
        url: 'https://pelda.invalid/megfigyelo.m3u8',
        label: 'Megfigyelt forrás',
        variant: 'sub' as const,
        headers: { Referer: 'https://pelda.invalid/' }
      }],
      subtitles: []
    }
  }
}

describe('a teljes lánc', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
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
    health = await import('../src/modules/providers/health.ts')
    resolveMod = await import('../src/modules/providers/resolve.ts')

    animeId = String((await pool.query(
      `INSERT INTO anime (canonical_title, format, status, visibility)
       VALUES ($1, 'TV'::anime_format, 'FINISHED', 'public') RETURNING id`,
      [tag + ' 2. évad']
    )).rows[0]!.id)

    // MIND A NÉGY külső azonosító — ezen áll vagy bukik a 2. pont.
    await pool.query(
      `INSERT INTO anime_mappings (anime_id, anilist_id, mal_id, kitsu_id, anidb_id)
       VALUES ($1, 111111, 222222, 333333, 444444)`,
      [animeId]
    )

    episodeId = String((await pool.query(
      "INSERT INTO episodes (anime_id, number, title, visibility) VALUES ($1, 5, 'Öt', 'public') RETURNING id",
      [animeId]
    )).rows[0]!.id)

    await pool.query(
      `INSERT INTO video_sources (episode_id, kind, ref, provider, variant, accuracy)
       VALUES ($1, 'http', $2, 'Tárolt tükör', 'sub', 'high')`,
      [episodeId, 'https://pelda.invalid/tarolt.m3u8']
    )
  })

  after(async () => {
    await pool.query('DELETE FROM anime WHERE id = $1', [animeId]).catch(() => {})
    await pool.query("DELETE FROM providers WHERE slug IN ('megfigyelo','yume-local')").catch(() => {})
    registry.forget()
    await app?.close()
    await pool?.end()
  })

  beforeEach(async () => {
    registry.reset()
    health.reset()
    resolveMod.clearCache()
    kapott = { ref: null, config: undefined }
    await pool.query('DELETE FROM providers')
    registry.forget()
  })

  const hivas = async (q = '') => {
    resolveMod.clearCache()
    const res = await app.inject({ url: `/v1/anime/episodes/${episodeId}/sources${q}` })
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as {
      data: Array<{ ref: string, provider: string | null, headers: Record<string, string> | null, variant: string }>
      provider: string | null, cached: boolean, attempts: Array<{ provider: string, outcome: string }>
    }
  }

  // ---- 2. pont: a külső azonosítók ----

  it('MIND A NÉGY külső azonosító megérkezik az adapterhez', async () => {
    registry.register(megfigyelo as never)
    await hivas()

    assert.ok(kapott.ref, 'az adapter meg sem lett hívva')
    assert.equal(kapott.ref.anilistId, 111111)
    assert.equal(kapott.ref.malId, 222222)
    assert.equal(kapott.ref.kitsuId, 333333)
    assert.equal(kapott.ref.anidbId, 444444)
  })

  it('a saját epizódazonosítónk és a rész száma is', async () => {
    registry.register(megfigyelo as never)
    await hivas()
    assert.equal(kapott.ref?.episodeId, episodeId)
    assert.equal(kapott.ref?.number, 5)
    assert.equal(kapott.ref?.title, tag + ' 2. évad')
  })

  /*
   * TÖBB ÉVADOS CÍM: a párosításnak van jobb horgonya a címnél. Ez az
   * állítás azt őrzi, hogy az azonosító MEGVAN — ha csak a cím menne át, egy
   * „2. évad" végződésű cím könnyen az elsőre illene.
   */
  it('nem csak a cím megy át, hanem azonosító is', async () => {
    registry.register(megfigyelo as never)
    await hivas()
    const horgonyok = [kapott.ref?.anilistId, kapott.ref?.malId, kapott.ref?.kitsuId, kapott.ref?.anidbId]
    assert.ok(horgonyok.some(x => typeof x === 'number'),
      'csak a cím ment át — két évadnál ez rendre téved')
  })

  it('hiányzó leképezésnél mind `null`, és az adapter attól még lefut', async () => {
    const masik = String((await pool.query(
      `INSERT INTO anime (canonical_title, format, status, visibility)
       VALUES ($1, 'TV'::anime_format, 'FINISHED', 'public') RETURNING id`,
      [tag + ' leképezés nélkül']
    )).rows[0]!.id)
    const masikEp = String((await pool.query(
      "INSERT INTO episodes (anime_id, number, visibility) VALUES ($1, 1, 'public') RETURNING id",
      [masik]
    )).rows[0]!.id)
    try {
      registry.register(megfigyelo as never)
      const res = await app.inject({ url: `/v1/anime/episodes/${masikEp}/sources` })
      assert.equal(res.statusCode, 200)
      assert.equal(kapott.ref?.anilistId, null)
      assert.equal(kapott.ref?.malId, null)
      assert.equal(kapott.ref?.anidbId, null)
    } finally {
      await pool.query('DELETE FROM anime WHERE id = $1', [masik])
    }
  })

  // ---- 1. pont: a config adatfolyama ----

  it('a beállítás eljut az adapterhez, és FRISS', async () => {
    registry.register(megfigyelo as never)
    await pool.query(
      "INSERT INTO providers (slug, enabled, priority, config) VALUES ('megfigyelo', true, 1, '{\"baseUrl\":\"https://elso.invalid\"}'::jsonb)"
    )
    registry.forget()
    await hivas()
    assert.deepEqual(kapott.config, { baseUrl: 'https://elso.invalid' })

    await pool.query("UPDATE providers SET config = '{\"baseUrl\":\"https://masodik.invalid\"}'::jsonb WHERE slug = 'megfigyelo'")
    registry.forget()
    await hivas()
    assert.deepEqual(kapott.config, { baseUrl: 'https://masodik.invalid' },
      'a régi beállítást használtuk — egy adminfelületen átírt érték nem hatna')
  })

  /*
   * A `config` `jsonb`, tehát SKALÁRT is tárolhat (`"szöveg"`, `42`, `true`).
   * A típusa `Record<string, unknown>`-t ígér — egy adapter, ami
   * `config.baseUrl`-t olvas, ettől nem hasalhat el.
   */
  it('hibás alakú beállítás nem dönti össze a láncot', async () => {
    registry.register(megfigyelo as never)
    for (const ertek of ['"csak egy szöveg"', '42', 'true', '[1,2,3]', 'null']) {
      await pool.query('DELETE FROM providers')
      await pool.query(
        `INSERT INTO providers (slug, enabled, priority, config) VALUES ('megfigyelo', true, 1, '${ertek}'::jsonb)`
      )
      registry.forget()
      const body = await hivas()
      assert.equal(body.provider, 'megfigyelo', `elhasalt ezen: ${ertek}`)
    }
  })

  // ---- 5. pont: a teljes útvonal ----

  it('sikeres feloldás: a forrás eljut a végpontig', async () => {
    registry.register(megfigyelo as never)
    const body = await hivas()
    assert.equal(body.provider, 'megfigyelo')
    assert.equal(body.data.length, 1)
    assert.equal(body.data[0]?.ref, 'https://pelda.invalid/megfigyelo.m3u8')
    assert.equal(body.data[0]?.provider, 'Megfigyelt forrás')
    assert.deepEqual(body.data[0]?.headers, { Referer: 'https://pelda.invalid/' })
  })

  it('kikapcsolt szolgáltató: nincs feloldás, a SOROK maradnak, a válasz alakja is', async () => {
    registry.register(megfigyelo as never)
    await registry.setState('megfigyelo', { enabled: false })
    const body = await hivas()

    assert.deepEqual(body.data, [])
    assert.equal(body.provider, null)
    assert.ok(Array.isArray(body.attempts), 'a válasz alakja megváltozott')

    const { rows } = await pool.query('SELECT count(*) AS n FROM video_sources WHERE episode_id = $1', [episodeId])
    assert.ok(Number(rows[0]!.n) >= 1, 'a kikapcsolás törölte az adatbázis-sorokat')
  })

  it('a lánc továbbmegy, ha az első hibázik', async () => {
    registry.register({ ...megfigyelo, id: 'hibas', defaultPriority: 1, async resolve () { throw new Error('szándékos') } } as never)
    registry.register({ ...megfigyelo, id: 'jo', defaultPriority: 2 } as never)
    const body = await hivas()
    assert.equal(body.provider, 'jo')
    assert.deepEqual(body.attempts.map(a => [a.provider, a.outcome]), [['hibas', 'error'], ['jo', 'ok']])
  })

  it('a gyorsítótár nem keveri a változatokat a végponton át sem', async () => {
    const kertek: string[] = []
    registry.register({
      ...megfigyelo,
      async resolve (ref: EpisodeRef) {
        kertek.push(ref.variant ?? 'any')
        return { sources: [{ kind: 'hls' as const, url: 'https://pelda.invalid/v.m3u8', variant: ref.variant ?? 'sub' }], subtitles: [] }
      }
    } as never)
    await hivas('?variant=sub')
    await hivas('?variant=dub')
    assert.deepEqual(kertek, ['sub', 'dub'], 'a szinkronos kérés a feliratos válaszát kapta')
  })

  // ---- biztonság a végponton ----

  it('titkos fejléc nem jut ki a végponton', async () => {
    registry.register({
      ...megfigyelo,
      async resolve () {
        return {
          sources: [{
            kind: 'hls' as const, url: 'https://pelda.invalid/x.m3u8', variant: 'sub' as const,
            headers: { Referer: 'https://pelda.invalid/', Authorization: 'Bearer TITOK', 'Set-Cookie': 'sid=TITOK' }
          }],
          subtitles: []
        }
      }
    } as never)
    const body = await hivas()
    const nyers = JSON.stringify(body)
    assert.ok(!nyers.includes('TITOK'), 'titok került a kliensnek küldött válaszba')
    assert.deepEqual(body.data[0]?.headers, { Referer: 'https://pelda.invalid/' })
  })

  it('a szolgáltató beállítása nem jelenik meg a nyilvános válaszban', async () => {
    registry.register(megfigyelo as never)
    await pool.query(
      "INSERT INTO providers (slug, enabled, priority, config) VALUES ('megfigyelo', true, 1, '{\"belso\":\"NE-LATSZODJ\"}'::jsonb)"
    )
    registry.forget()
    const body = await hivas()
    assert.ok(!JSON.stringify(body).includes('NE-LATSZODJ'),
      'a szolgáltató beállítása kiszivárgott a nyilvános végponton')
  })
})
