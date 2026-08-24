// The Plex extension.
//
// Plex differs from Jellyfin where it matters most: results are wrapped in a
// MediaContainer, XML unless JSON is asked for, and the file is reached through
// a Part key rather than a stream endpoint. Each of those is a place to get it
// quietly wrong — a wrong path returns 404 and looks like "no sources", which
// is indistinguishable from an episode the library does not have.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const DIR = new URL('../../extensions/plex/', import.meta.url)

const OPTIONS = {
  server_url: 'https://plex.example.com:32400',
  token: 'PLEX-TOKEN',
  section: '',
  max_height: '1080'
}

const QUERY = { titles: ['Shingeki no Kyojin'], episode: 3, anidbId: 9541, malId: 16498 }

const plain = value => JSON.parse(JSON.stringify(value))

const PART = {
  key: '/library/parts/501/file.mkv',
  container: 'mkv',
  Stream: [
    { streamType: 1, height: 1080 },
    { streamType: 2, languageCode: 'jpn', selected: true },
    { streamType: 2, languageCode: 'hun' },
    { streamType: 3, languageCode: 'hun', key: '/library/streams/900', codec: 'srt', displayTitle: 'Magyar' },
    { streamType: 3, languageCode: 'eng', key: '/library/streams/901', codec: 'srt', displayTitle: 'English' },
    { streamType: 3, languageCode: 'jpn', codec: 'pgs', displayTitle: 'PGS' }
  ]
}
const EPISODE = { ratingKey: '77', index: 3, grandparentTitle: 'Shingeki no Kyojin', Media: [{ videoResolution: '1080', container: 'mkv', Part: [PART] }] }

const SHOW_HAMA = { ratingKey: '42', title: 'Shingeki no Kyojin', guid: 'com.plexapp.agents.hama://anidb-9541?lang=en' }
const SHOW_NEW = { ratingKey: '43', title: 'Shingeki no Kyojin', Guid: [{ id: 'tvdb://267440' }, { id: 'anidb://9541' }] }
const SHOW_NO_IDS = { ratingKey: '44', title: 'Some Other Show' }

async function load (handler = () => null, { storage = new Map() } = {}) {
  const calls = []
  globalThis.yume = {
    async fetch (url, init = {}) {
      const parsed = new URL(String(url))
      calls.push({ url: String(url), path: parsed.pathname, params: parsed.searchParams, headers: init.headers ?? {} })
      const body = handler(parsed)
      if (body === null || body === undefined) return { ok: false, status: 404, json: async () => ({}) }
      if (body.throws) throw new Error('network')
      return {
        ok: (body.status ?? 200) < 400,
        status: body.status ?? 200,
        json: async () => ({ MediaContainer: body.container ?? {} })
      }
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

const server = (show = SHOW_HAMA, episodes = [EPISODE]) => parsed => {
  if (parsed.pathname === '/library/sections') return { container: { Directory: [{ key: '1', type: 'show' }, { key: '2', type: 'movie' }] } }
  if (parsed.pathname.endsWith('/all')) return { container: { Metadata: [show] } }
  if (parsed.pathname.endsWith('/allLeaves')) return { container: { Metadata: episodes } }
  return null
}

describe('manifest', () => {
  it('passes the validator the publish endpoint uses', async () => {
    const { validateManifest } = await import('../../server/src/lib/extension-manifest.ts')
    const result = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')))
    assert.equal(result.valid, true, result.errors.join('; '))
  })

  it('names every option its code reads', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    const source = readFileSync(new URL('index.js', DIR), 'utf8')
    for (const key of Object.keys(manifest.options)) {
      assert.ok(source.includes(`opts.${key}`), `option ${key} is declared but never read`)
    }
  })
})

describe('speaking Plex', () => {
  it('asks for JSON, which Plex only gives when told', async () => {
    // Without the Accept header Plex answers XML and every parse fails.
    const { ext, calls } = await load(server())
    await ext.single(QUERY, OPTIONS)
    assert.ok(calls.length > 0)
    for (const call of calls) assert.equal(call.headers.Accept, 'application/json')
  })

  it('sends the token as a header on API calls', async () => {
    const { ext, calls } = await load(server())
    await ext.single(QUERY, OPTIONS)
    for (const call of calls) assert.equal(call.headers['X-Plex-Token'], 'PLEX-TOKEN')
  })

  it('searches only show libraries', async () => {
    const { ext, calls } = await load(server())
    await ext.single(QUERY, OPTIONS)
    // Section 2 is a movie library in the fixture and must not be walked.
    assert.ok(!calls.some(c => c.path.includes('/sections/2/')))
  })

  it('searches only the configured section when one is set', async () => {
    const { ext, calls } = await load(server())
    await ext.single(QUERY, { ...OPTIONS, section: '7' })
    assert.ok(!calls.some(c => c.path === '/library/sections'), 'no need to list sections')
    assert.ok(calls.some(c => c.path.includes('/sections/7/')))
  })
})

describe('returning a playable file', () => {
  it('returns the original file through its Part key', async () => {
    // The file, not a transcode — this is where Plex differs from Jellyfin.
    const { ext } = await load(server())
    const [result] = await ext.single(QUERY, OPTIONS)
    const url = new URL(result.url)
    assert.equal(url.pathname, '/library/parts/501/file.mkv')
    assert.equal(url.searchParams.get('X-Plex-Token'), 'PLEX-TOKEN')
  })

  it('reports the resolution Plex recorded', async () => {
    const { ext } = await load(server())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.quality, '1080')
  })

  it('offers one candidate per file', async () => {
    const twoParts = {
      ...EPISODE,
      Media: [
        { videoResolution: '1080', container: 'mkv', Part: [{ key: '/a', Stream: [] }] },
        { videoResolution: '720', container: 'mp4', Part: [{ key: '/b', Stream: [] }] }
      ]
    }
    const { ext } = await load(server(SHOW_HAMA, [twoParts]))
    assert.equal((await ext.single(QUERY, OPTIONS)).length, 2)
  })
})

describe('audio and subtitles', () => {
  it('reports the selected audio language, which drives the sub/dub switch', async () => {
    const { ext } = await load(server())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.audio, 'ja')
    assert.match(result.title, /\[Sub\]/)
  })

  it('calls it a dub when the selected audio is not Japanese', async () => {
    const dubbed = {
      ...EPISODE,
      Media: [{ Part: [{ key: '/x', Stream: [{ streamType: 2, languageCode: 'hun', selected: true }] }] }]
    }
    const { ext } = await load(server(SHOW_HAMA, [dubbed]))
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.audio, 'hu')
    assert.match(result.title, /\[Dub\]/)
  })

  it('offers only subtitle streams that have something to fetch', async () => {
    // An embedded track has no key of its own and an image-based one could not
    // render in a track element; either would be a button that does nothing.
    const { ext } = await load(server())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.deepEqual(result.subtitles.map(s => s.lang), ['hu', 'en'])
    assert.ok(!result.subtitles.some(s => s.label === 'PGS'))
  })

  it('carries the subtitle format so the engine knows to convert', async () => {
    const { ext } = await load(server())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.subtitles[0].format, 'srt')
  })
})

describe('matching honestly', () => {
  it('matches a HAMA guid, which is what anime libraries carry', async () => {
    const { ext } = await load(server(SHOW_HAMA))
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.accuracy, 'high')
  })

  it('matches a modern Guid array too', async () => {
    const { ext } = await load(server(SHOW_NEW))
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.accuracy, 'high')
  })

  it('drops to medium for a title-only match', async () => {
    const { ext } = await load(server(SHOW_NO_IDS))
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.accuracy, 'medium')
  })

  it('prefers the id match over an earlier title hit', async () => {
    const handler = parsed => {
      if (parsed.pathname === '/library/sections') return { container: { Directory: [{ key: '1', type: 'show' }] } }
      if (parsed.pathname.endsWith('/all')) return { container: { Metadata: [SHOW_NO_IDS, SHOW_HAMA] } }
      if (parsed.pathname.endsWith('/allLeaves')) return { container: { Metadata: [EPISODE] } }
      return null
    }
    const { ext } = await load(handler)
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.accuracy, 'high')
  })

  it('offers nothing for an episode the library does not have', async () => {
    const { ext } = await load(server(SHOW_HAMA, [{ ...EPISODE, index: 9 }]))
    assert.deepEqual(plain(await ext.single(QUERY, OPTIONS)), [])
  })
})

describe('failing safely', () => {
  it('does nothing without a server or a token', async () => {
    const { ext, calls } = await load(server())
    assert.deepEqual(plain(await ext.single(QUERY, { ...OPTIONS, token: '' })), [])
    assert.deepEqual(plain(await ext.single(QUERY, { ...OPTIONS, server_url: '' })), [])
    assert.equal(calls.length, 0)
  })

  it('returns no sources rather than throwing when the server is down', async () => {
    const { ext } = await load(() => ({ throws: true }))
    assert.deepEqual(plain(await ext.single(QUERY, OPTIONS)), [])
  })

  it('separates a bad token from a dead server', async () => {
    // /library/sections needs a token, unlike /identity.
    const ok = await load(server())
    assert.equal(await ok.ext.test(OPTIONS), true)

    const badToken = await load(() => ({ status: 401 }))
    assert.equal(await badToken.ext.test(OPTIONS), false)

    assert.equal(await ok.ext.test({}), false)
  })
})

describe('caching', () => {
  it('looks a show up once across episodes', async () => {
    const { ext, calls } = await load(server())
    await ext.single(QUERY, OPTIONS)
    const first = calls.length
    await ext.single({ ...QUERY, episode: 4 }, OPTIONS)
    const second = calls.length - first
    assert.equal(second, 1, 'only the episode list should be fetched again')
  })
})
