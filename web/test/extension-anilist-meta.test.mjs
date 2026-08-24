// The AniList Extras extension.
//
// It feeds two tabs that are otherwise permanently empty for locally-served
// titles, so the failure that matters is filling them with the wrong show's
// cast — which looks completely plausible and is completely wrong.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const DIR = new URL('../../extensions/anilist-meta/', import.meta.url)
const OPTIONS = { characters: true, staff: true, recommendations: true, limit: 24 }
const QUERY = { anilistId: 16498, malId: 16498, titles: ['Shingeki no Kyojin'] }

const plain = value => JSON.parse(JSON.stringify(value))

const MEDIA = {
  id: 16498,
  characters: {
    edges: [
      {
        role: 'MAIN',
        node: { id: 40882, name: { userPreferred: 'Eren Yeager' }, image: { large: 'https://cdn.anilist.co/eren.jpg' } },
        voiceActors: [{ id: 1, name: { userPreferred: 'Yuki Kaji' }, image: { large: 'https://cdn.anilist.co/kaji.jpg' } }]
      },
      { role: 'SUPPORTING', node: { id: 2, name: { userPreferred: 'Armin Arlert' }, image: { large: 'https://cdn.anilist.co/armin.jpg' } }, voiceActors: [] },
      { role: 'MAIN', node: { id: 3, name: null } }
    ]
  },
  staff: {
    edges: [
      { role: 'Director', node: { id: 9, name: { userPreferred: 'Tetsuro Araki' }, image: { large: 'https://cdn.anilist.co/araki.jpg' } } },
      { role: 'Composer', node: { id: 10, name: null } }
    ]
  },
  recommendations: {
    nodes: [
      { mediaRecommendation: { id: 21, title: { userPreferred: 'One Piece', romaji: 'One Piece', english: 'One Piece' }, coverImage: { large: 'https://cdn.anilist.co/op.jpg' }, format: 'TV', averageScore: 88, episodes: 1100 } },
      { mediaRecommendation: null }
    ]
  }
}

async function load (handler = () => ({ json: { data: { Media: MEDIA } } }), { storage = new Map() } = {}) {
  const calls = []
  globalThis.yume = {
    async fetch (url, init = {}) {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body })
      const body = handler(String(url), init)
      if (body === null || body === undefined) return { ok: false, status: 404, json: async () => ({}) }
      if (body.throws) throw new Error('network')
      return { ok: (body.status ?? 200) < 400, status: body.status ?? 200, json: async () => body.json ?? {} }
    },
    storage: {
      get: async k => storage.get(k),
      set: async (k, v) => { storage.set(k, v) },
      remove: async k => { storage.delete(k) }
    },
    log () {}
  }
  const mod = await import(new URL('index.js?t=' + Math.random(), DIR))
  return { ext: mod.default, calls, storage }
}

describe('manifest', () => {
  it('passes the validator the publish endpoint uses', async () => {
    const { validateManifest } = await import('../../server/src/lib/extension-manifest.ts')
    const result = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')))
    assert.equal(result.valid, true, result.errors.join('; '))
  })

  it('is a metadata extension, so the engine never asks it for a stream', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.equal(manifest.type, 'metadata')
  })

  it('reaches only AniList', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.deepEqual(manifest.permissions['net:fetch'].hosts, ['graphql.anilist.co'])
  })
})

describe('what it returns', () => {
  it('returns cast, staff and recommendations from one call', async () => {
    // AniList rate-limits by request count, so one query for three answers is
    // strictly cheaper than three queries.
    const { ext, calls } = await load()
    const records = await ext.metadata(QUERY, OPTIONS)
    assert.equal(calls.length, 1)
    const kinds = new Set(records.map(r => r.kind))
    assert.deepEqual([...kinds].sort(), ['character', 'recommendation', 'staff'])
  })

  it('carries the voice actor flat, since only primitives cross the sandbox', async () => {
    const { ext } = await load()
    const [eren] = (await ext.metadata(QUERY, OPTIONS)).filter(r => r.kind === 'character')
    assert.equal(eren.name, 'Eren Yeager')
    assert.equal(eren.role, 'MAIN')
    assert.equal(eren.voiceActor, 'Yuki Kaji')
    assert.equal(typeof eren.voiceActorImage, 'string')
  })

  it('skips entries with no name rather than rendering a blank card', async () => {
    const { ext } = await load()
    const records = await ext.metadata(QUERY, OPTIONS)
    assert.equal(records.filter(r => r.kind === 'character').length, 2)
    assert.equal(records.filter(r => r.kind === 'staff').length, 1)
  })

  it('skips a null recommendation', async () => {
    const { ext } = await load()
    assert.equal((await ext.metadata(QUERY, OPTIONS)).filter(r => r.kind === 'recommendation').length, 1)
  })

  it('carries enough of a recommendation to draw the usual card', async () => {
    const { ext } = await load()
    const [rec] = (await ext.metadata(QUERY, OPTIONS)).filter(r => r.kind === 'recommendation')
    assert.equal(rec.anilistId, 21)
    assert.equal(rec.title, 'One Piece')
    assert.equal(rec.format, 'TV')
    assert.equal(rec.score, 88)
  })

  it('honours each section being turned off', async () => {
    const { ext } = await load()
    const noStaff = await ext.metadata(QUERY, { ...OPTIONS, staff: false })
    assert.equal(noStaff.filter(r => r.kind === 'staff').length, 0)
    assert.ok(noStaff.filter(r => r.kind === 'character').length > 0)

    const only = await ext.metadata(QUERY, { characters: false, staff: false, recommendations: true, limit: 5 })
    assert.deepEqual([...new Set(only.map(r => r.kind))], ['recommendation'])
  })

  it('bounds how much it asks for', async () => {
    const { ext, calls } = await load()
    await ext.metadata(QUERY, { ...OPTIONS, limit: 9999 })
    const body = JSON.parse(calls[0].body)
    assert.ok(body.variables.perPage <= 50)

    const { ext: e2, calls: c2 } = await load()
    await e2.metadata(QUERY, { ...OPTIONS, limit: 'abc' })
    assert.equal(JSON.parse(c2[0].body).variables.perPage, 24)
  })
})

describe('refusing to guess', () => {
  it('asks nothing without an AniList id', async () => {
    // Searching by title would return a different show's cast, which looks
    // entirely plausible and is entirely wrong.
    const { ext, calls } = await load()
    assert.deepEqual(plain(await ext.metadata({ ...QUERY, anilistId: undefined }, OPTIONS)), [])
    assert.equal(calls.length, 0)
  })

  it('rejects a malformed id instead of putting it in a query', async () => {
    const { ext, calls } = await load()
    for (const anilistId of [0, -1, 'abc', null, 1.5]) {
      await ext.metadata({ ...QUERY, anilistId }, OPTIONS)
    }
    assert.equal(calls.length, 0)
  })
})

describe('failing safely', () => {
  it('treats a GraphQL error as no data, not as success', async () => {
    // AniList returns errors with HTTP 200, so the status alone proves nothing.
    const { ext } = await load(() => ({ json: { errors: [{ message: 'Not Found' }] } }))
    assert.deepEqual(plain(await ext.metadata(QUERY, OPTIONS)), [])
  })

  it('returns nothing rather than throwing when AniList is down', async () => {
    const { ext } = await load(() => ({ throws: true }))
    assert.deepEqual(plain(await ext.metadata(QUERY, OPTIONS)), [])

    const rateLimited = await load(() => ({ status: 429 }))
    assert.deepEqual(plain(await rateLimited.ext.metadata(QUERY, OPTIONS)), [])
  })

  it('copes with a media object that has none of the sections', async () => {
    const { ext } = await load(() => ({ json: { data: { Media: { id: 1 } } } }))
    assert.deepEqual(plain(await ext.metadata(QUERY, OPTIONS)), [])
  })

  it('reports the service up or down', async () => {
    const up = await load(() => ({ json: { data: { Media: { id: 1 } } } }))
    assert.equal(await up.ext.test(), true)

    const down = await load(() => ({ throws: true }))
    assert.equal(await down.ext.test(), false)
  })

  it('queries with POST, which is the only method the endpoint speaks', async () => {
    const { ext, calls } = await load()
    await ext.test()
    assert.equal(calls[0].method, 'POST')
  })
})

describe('not spending rate limit twice', () => {
  it('caches a result across re-opens', async () => {
    // A detail page is re-opened constantly and none of this changes hour to
    // hour; a request per visit would exhaust the budget on nothing.
    const storage = new Map()
    const first = await load(undefined, { storage })
    await first.ext.metadata(QUERY, OPTIONS)

    const second = await load(undefined, { storage })
    await second.ext.metadata(QUERY, OPTIONS)
    assert.equal(second.calls.length, 0)
  })

  it('does not cache an empty result, which would hide a later fix', async () => {
    const storage = new Map()
    const first = await load(() => ({ json: { data: { Media: { id: 1 } } } }), { storage })
    assert.deepEqual(plain(await first.ext.metadata(QUERY, OPTIONS)), [])

    const second = await load(undefined, { storage })
    assert.ok((await second.ext.metadata(QUERY, OPTIONS)).length > 0)
  })
})

describe('the detail page consumes it', () => {
  const source = readFileSync(new URL('../js/pages/anime.js', import.meta.url), 'utf8')

  it('asks only metadata extensions', () => {
    assert.match(source, /collect\('metadata',[\s\S]{0,80}types:\s*\['metadata'\]/)
  })

  it('asks once for both tabs rather than once per tab', () => {
    assert.match(source, /_metaCache/)
  })

  it('maps a recommendation back into the shape the usual card draws', () => {
    // Otherwise these become a second kind of card that looks almost right.
    assert.match(source, /coverImage:\s*\{\s*large:/)
  })

  it('catches a failing tab so it cannot become an unhandled rejection', () => {
    assert.match(source, /\.catch\(error => console\.warn\('\[anime\] tab failed:'/)
  })
})
