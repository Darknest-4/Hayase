// The Jellyfin extension.
//
// It returns a real, playable stream, so the failure modes that matter are the
// ones that hand the player something wrong rather than nothing: the wrong
// series (Jellyfin's search is fuzzy and seasons are separate items), an
// image-based subtitle track that can never render, or a `high` accuracy claim
// behind a title guess.
//
// The manifest is checked with the server's own validator — the module the
// publish endpoint uses — so a manifest that would be rejected at publish time
// fails here first.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const DIR = new URL('../../extensions/jellyfin/', import.meta.url)

const OPTIONS = {
  server_url: 'https://jellyfin.example.com',
  api_key: 'SECRET-KEY',
  user_id: '',
  max_height: '1080',
  subtitle_format: 'vtt',
  allow_transcode: false
}

const QUERY = { titles: ['Shingeki no Kyojin', 'Attack on Titan'], episode: 3, anilistId: 16498, malId: 16498 }

/** One episode as Jellyfin returns it, with the streams that matter. */
const EPISODE = {
  Id: 'ep-3',
  IndexNumber: 3,
  SeriesName: 'Shingeki no Kyojin',
  MediaSources: [{
    Id: 'src-1',
    Container: 'mkv',
    MediaStreams: [
      { Type: 'Video', Height: 1080 },
      { Type: 'Audio', Language: 'jpn', IsDefault: true },
      { Type: 'Audio', Language: 'hun' },
      { Type: 'Subtitle', Language: 'hun', Index: 2, IsTextSubtitleStream: true, DisplayTitle: 'Magyar' },
      { Type: 'Subtitle', Language: 'eng', Index: 3, IsTextSubtitleStream: true, DisplayTitle: 'English' },
      { Type: 'Subtitle', Language: 'jpn', Index: 4, IsTextSubtitleStream: false, DisplayTitle: 'PGS' }
    ]
  }]
}

const SERIES_WITH_IDS = { Id: 'series-1', Name: 'Shingeki no Kyojin', ProviderIds: { AniList: '16498', Tvdb: '267440' } }
const SERIES_NO_IDS = { Id: 'series-2', Name: 'Some Other Show', ProviderIds: {} }

/**
 * Load the extension against a fake Jellyfin.
 *
 * `handler` receives the parsed URL and returns a body; anything it does not
 * answer is a 404, which is what a server without the item does.
 */
async function load (handler = () => null, { storage = new Map() } = {}) {
  const calls = []
  globalThis.yume = {
    async fetch (url, init = {}) {
      const parsed = new URL(String(url))
      calls.push({ url: String(url), path: parsed.pathname, params: parsed.searchParams, init })
      const body = handler(parsed, init)
      if (body === null || body === undefined) {
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
      }
      if (body.throws) throw new Error('network')
      return {
        ok: (body.status ?? 200) < 400,
        status: body.status ?? 200,
        text: async () => JSON.stringify(body.json ?? {}),
        json: async () => body.json ?? {}
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

/** A server that answers the whole lookup for the id-matched series. */
const happyServer = (series = SERIES_WITH_IDS, episodes = [EPISODE]) => parsed => {
  if (parsed.pathname === '/Items') return { json: { Items: [series] } }
  if (parsed.pathname.startsWith('/Shows/')) return { json: { Items: episodes } }
  if (parsed.pathname === '/System/Info') return { json: { Version: '10.9.0' } }
  return null
}

describe('manifest', () => {
  it('passes the validator the publish endpoint uses', async () => {
    const { validateManifest } = await import('../../server/src/lib/extension-manifest.ts')
    const result = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')))
    assert.equal(result.valid, true, result.errors.join('; '))
  })

  it('declares exactly one reachable host', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.deepEqual(manifest.permissions['net:fetch'].hosts, ['jellyfin.example.com'])
  })

  it('names every option its code reads', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    const source = readFileSync(new URL('index.js', DIR), 'utf8')
    for (const key of Object.keys(manifest.options)) {
      assert.ok(source.includes(`opts.${key}`), `option ${key} is declared but never read`)
    }
  })
})

describe('returning a playable stream', () => {
  it('returns a direct stream URL for the episode', async () => {
    const { ext } = await load(happyServer())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.ok(result, 'expected a source')
    const url = new URL(result.url)
    assert.equal(url.pathname, '/Videos/ep-3/stream')
    assert.equal(url.searchParams.get('static'), 'true', 'direct play unless transcoding is enabled')
    assert.equal(url.searchParams.get('mediaSourceId'), 'src-1')
  })

  it('reports the real resolution from the video stream', async () => {
    const { ext } = await load(happyServer())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.quality, '1080')
  })

  it('asks for a transcode only when that is turned on', async () => {
    const { ext } = await load(happyServer())
    const [result] = await ext.single(QUERY, { ...OPTIONS, allow_transcode: true })
    const url = new URL(result.url)
    assert.equal(url.searchParams.get('static'), null)
    assert.equal(url.searchParams.get('maxHeight'), '1080')
  })

  it('offers one candidate per media source, so the engine can rank them', async () => {
    const twoSources = {
      ...EPISODE,
      MediaSources: [
        { Id: 'a', Container: 'mkv', MediaStreams: [{ Type: 'Video', Height: 1080 }] },
        { Id: 'b', Container: 'mp4', MediaStreams: [{ Type: 'Video', Height: 720 }] }
      ]
    }
    const { ext } = await load(happyServer(SERIES_WITH_IDS, [twoSources]))
    const results = await ext.single(QUERY, OPTIONS)
    assert.equal(results.length, 2)
    assert.deepEqual(results.map(r => r.quality), ['1080', '720'])
  })
})

describe('audio and subtitle tracks', () => {
  it('reports the default audio language, which drives the sub/dub switch', async () => {
    const { ext } = await load(happyServer())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.audio, 'ja', 'jpn must normalise to ja')
    assert.match(result.title, /\[Sub\]/)
  })

  it('calls it a dub when the default audio is not Japanese', async () => {
    const dubbed = {
      ...EPISODE,
      MediaSources: [{
        Id: 'src-1',
        MediaStreams: [
          { Type: 'Video', Height: 1080 },
          { Type: 'Audio', Language: 'hun', IsDefault: true }
        ]
      }]
    }
    const { ext } = await load(happyServer(SERIES_WITH_IDS, [dubbed]))
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.audio, 'hu')
    assert.match(result.title, /\[Dub\]/)
  })

  it('returns text subtitle tracks with two-letter language codes', async () => {
    const { ext } = await load(happyServer())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.deepEqual(result.subtitles.map(s => s.lang), ['hu', 'en'])
    assert.equal(result.subtitles[0].label, 'Magyar')
  })

  it('skips image-based subtitles, which can never render in a track element', async () => {
    // Offering one produces a subtitle button that does nothing, which is
    // worse than not listing it.
    const { ext } = await load(happyServer())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.subtitles.length, 2, 'the PGS track must not be offered')
    assert.ok(!result.subtitles.some(s => s.label === 'PGS'))
  })

  it('builds a subtitle URL Jellyfin will convert to vtt', async () => {
    const { ext } = await load(happyServer())
    const [result] = await ext.single(QUERY, OPTIONS)
    const url = new URL(result.subtitles[0].url)
    assert.equal(url.pathname, '/Videos/ep-3/src-1/Subtitles/2/Stream.vtt')
  })
})

describe('matching honestly', () => {
  it('claims high accuracy only for an external-id match', async () => {
    const { ext } = await load(happyServer(SERIES_WITH_IDS))
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.accuracy, 'high')
  })

  it('drops to medium when it only matched a title', async () => {
    // Jellyfin's search is fuzzy and seasons are separate items, so a title
    // match is a guess — and a wrong episode is worse than none.
    const { ext } = await load(happyServer(SERIES_NO_IDS))
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.accuracy, 'medium')
  })

  it('prefers an id match over an earlier title hit', async () => {
    const handler = parsed => {
      if (parsed.pathname === '/Items') return { json: { Items: [SERIES_NO_IDS, SERIES_WITH_IDS] } }
      if (parsed.pathname.startsWith('/Shows/series-1')) return { json: { Items: [EPISODE] } }
      if (parsed.pathname.startsWith('/Shows/')) return { json: { Items: [] } }
      return null
    }
    const { ext } = await load(handler)
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(result.accuracy, 'high', 'the id match must win even though it is second in the list')
  })

  it('offers nothing when the episode is not in the library', async () => {
    const { ext } = await load(happyServer(SERIES_WITH_IDS, [{ ...EPISODE, IndexNumber: 7 }]))
    assert.deepEqual(await ext.single(QUERY, OPTIONS), [])
  })

  it('offers nothing when no series matches at all', async () => {
    const { ext } = await load(parsed => (parsed.pathname === '/Items' ? { json: { Items: [] } } : null))
    assert.deepEqual(await ext.single(QUERY, OPTIONS), [])
  })
})

describe('credentials', () => {
  it('sends the key as a header on API calls, not in the query string', async () => {
    const { ext, calls } = await load(happyServer())
    await ext.single(QUERY, OPTIONS)
    const apiCalls = calls.filter(c => c.path === '/Items' || c.path.startsWith('/Shows/'))
    assert.ok(apiCalls.length > 0)
    for (const call of apiCalls) {
      assert.equal(call.init.headers['X-Emby-Token'], 'SECRET-KEY')
      assert.equal(call.params.get('api_key'), null, `${call.path} leaked the key into the URL`)
    }
  })

  it('puts the key in media URLs, which is the only way a video element can send it', async () => {
    // Browsers give no way to attach headers to a <video src>, so Jellyfin's
    // own api_key parameter is the only option there. Asserted so the tradeoff
    // stays deliberate rather than becoming an accident.
    const { ext } = await load(happyServer())
    const [result] = await ext.single(QUERY, OPTIONS)
    assert.equal(new URL(result.url).searchParams.get('api_key'), 'SECRET-KEY')
    assert.equal(new URL(result.subtitles[0].url).searchParams.get('api_key'), 'SECRET-KEY')
  })

  it('does nothing at all without a server or a key', async () => {
    const { ext, calls } = await load(happyServer())
    assert.deepEqual(await ext.single(QUERY, { ...OPTIONS, api_key: '' }), [])
    assert.deepEqual(await ext.single(QUERY, { ...OPTIONS, server_url: '' }), [])
    assert.equal(calls.length, 0)
  })
})

describe('failure', () => {
  it('returns no sources rather than throwing when the server is down', async () => {
    const { ext } = await load(() => ({ throws: true }))
    assert.deepEqual(await ext.single(QUERY, OPTIONS), [])
  })

  it('returns no sources when the key was revoked', async () => {
    const { ext } = await load(() => ({ status: 401 }))
    assert.deepEqual(await ext.single(QUERY, OPTIONS), [])
  })

  it('reports the server reachable only when the key is accepted too', async () => {
    // /System/Info needs authentication, so this separates "server down" from
    // "key wrong" — identical symptoms, completely different fixes.
    const up = await load(parsed => (parsed.pathname === '/System/Info' ? { json: { Version: '10.9.0' } } : null))
    assert.equal(await up.ext.test(OPTIONS), true)

    const badKey = await load(parsed => (parsed.pathname === '/System/Info' ? { status: 401 } : null))
    assert.equal(await badKey.ext.test(OPTIONS), false)

    const down = await load(() => ({ throws: true }))
    assert.equal(await down.ext.test(OPTIONS), false)

    const unconfigured = await load(happyServer())
    assert.equal(await unconfigured.ext.test({}), false)
  })
})

describe('caching', () => {
  it('looks a series up once across episodes', async () => {
    const { ext, calls } = await load(happyServer())
    await ext.single(QUERY, OPTIONS)
    await ext.single({ ...QUERY, episode: 4 }, OPTIONS)
    const searches = calls.filter(c => c.path === '/Items').length
    assert.equal(searches, 1, 'the second episode must reuse the cached series')
  })
})

describe('movies', () => {
  it('resolves a movie as a single item', async () => {
    const movie = {
      Id: 'movie-1',
      Name: 'A Silent Voice',
      ProviderIds: { AniList: '20954' },
      MediaSources: [{ Id: 'm-src', Container: 'mkv', MediaStreams: [{ Type: 'Video', Height: 1080 }, { Type: 'Audio', Language: 'jpn', IsDefault: true }] }]
    }
    const { ext } = await load(parsed => (parsed.pathname === '/Items' ? { json: { Items: [movie] } } : null))
    const [result] = await ext.movie({ titles: ['A Silent Voice'], anilistId: 20954 }, OPTIONS)
    assert.equal(new URL(result.url).pathname, '/Videos/movie-1/stream')
    assert.equal(result.accuracy, 'high')
  })

  it('has nothing to batch', async () => {
    const { ext } = await load(happyServer())
    assert.deepEqual(await ext.batch(QUERY, OPTIONS), [])
  })
})
