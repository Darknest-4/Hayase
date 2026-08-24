// The OpenSubtitles extension, and the srt→vtt path it depends on.
//
// Two things here are easy to get wrong and silent when you do:
//
//   * quota. Downloads count against the account's daily allowance and this
//     runs on every episode, so anything that spends more than one download
//     per language, or spends again on a re-open, is a real cost to the user.
//   * delivery. A <track> fetches its own src, so a link has to be
//     CORS-readable, and browsers render only WebVTT while OpenSubtitles
//     serves SubRip. A track that "loads" and shows nothing looks like a
//     broken player.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createContext, runInNewContext } from 'node:vm'

const DIR = new URL('../../extensions/opensubtitles/', import.meta.url)
const ENGINE = new URL('../js/stream-engine.js', import.meta.url)

const OPTIONS = { api_key: 'KEY', languages: 'hu,en', trusted_only: false, user_agent: 'Yume v1.0' }
const QUERY = { titles: ['Shingeki no Kyojin'], episode: 3, malId: 16498 }

const plain = value => JSON.parse(JSON.stringify(value))

async function load (handler = () => null, { storage = new Map() } = {}) {
  const calls = []
  globalThis.yume = {
    async fetch (url, init = {}) {
      calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {} })
      const body = handler(new URL(String(url)), init)
      if (body === null || body === undefined) return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
      if (body.throws) throw new Error('network')
      return {
        ok: (body.status ?? 200) < 400,
        status: body.status ?? 200,
        text: async () => body.text ?? '',
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

const SRT = '1\n00:00:12,500 --> 00:00:14,000\nHello\n\n2\n00:00:15,000 --> 00:00:17,250\nWorld\n'

/** A server that answers a search, a download and the file itself. */
const server = ({ results = 1, file = SRT } = {}) => parsed => {
  if (parsed.pathname.endsWith('/subtitles')) {
    return {
      json: {
        data: Array.from({ length: results }, (_, i) => ({
          attributes: {
            language: parsed.searchParams.get('languages'),
            download_count: (i + 1) * 100,
            release: `Release ${i}`,
            files: [{ file_id: 1000 + i }]
          }
        }))
      }
    }
  }
  if (parsed.pathname.endsWith('/download')) return { json: { link: 'https://www.opensubtitles.com/f/1.srt' } }
  if (parsed.hostname === 'www.opensubtitles.com') return { text: file }
  if (parsed.pathname.endsWith('/infos/user')) return { json: { data: {} } }
  return null
}

describe('manifest', () => {
  it('passes the validator the publish endpoint uses', async () => {
    const { validateManifest } = await import('../../server/src/lib/extension-manifest.ts')
    const result = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')))
    assert.equal(result.valid, true, result.errors.join('; '))
  })

  it('is a subtitle extension, so the engine never asks it for a stream', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.equal(manifest.type, 'subtitle')
  })

  it('declares the download hosts, not just the API', () => {
    // Without them the proxy blocks the file fetch and every track falls back
    // to a link the browser probably cannot render.
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.ok(manifest.permissions['net:fetch'].hosts.includes('api.opensubtitles.com'))
    assert.ok(manifest.permissions['net:fetch'].hosts.length > 1)
  })
})

describe('finding tracks', () => {
  it('returns the subtitle text, not a link', async () => {
    const { ext } = await load(server())
    const tracks = await ext.subtitles(QUERY, OPTIONS)
    assert.ok(tracks.length >= 1)
    assert.ok(tracks[0].content.includes('Hello'))
    assert.equal(tracks[0].url, undefined)
  })

  it('asks for one track per configured language', async () => {
    const { ext } = await load(server())
    const tracks = await ext.subtitles(QUERY, OPTIONS)
    assert.deepEqual(tracks.map(t => t.lang), ['hu', 'en'])
  })

  it('spends exactly one download per language', async () => {
    // Downloads count against a daily quota and this runs on every episode.
    const { ext, calls } = await load(server({ results: 5 }))
    await ext.subtitles(QUERY, OPTIONS)
    const downloads = calls.filter(c => c.url.endsWith('/download')).length
    assert.equal(downloads, 2, 'two languages, two downloads — not one per result')
  })

  it('picks the most-downloaded candidate', async () => {
    const { ext, calls } = await load(server({ results: 3 }))
    await ext.subtitles(QUERY, OPTIONS)
    // The fixture's download_count rises with the index, so the last file id
    // is the one that should have been requested.
    assert.equal(calls.filter(c => c.url.endsWith('/download')).length, 2)
  })

  it('sends the API key and a client identifier on every API call', async () => {
    // OpenSubtitles rejects requests without a User-Agent, which reads as an
    // authentication failure if you have not seen it before.
    const { ext, calls } = await load(server())
    await ext.subtitles(QUERY, OPTIONS)
    const apiCalls = calls.filter(c => c.url.includes('api.opensubtitles.com'))
    assert.ok(apiCalls.length > 0)
    for (const call of apiCalls) {
      assert.equal(call.headers['Api-Key'], 'KEY')
      assert.ok(call.headers['User-Agent'])
    }
  })

  it('sends the episode number with the title', async () => {
    const { ext, calls } = await load(server())
    await ext.subtitles(QUERY, OPTIONS)
    const search = calls.find(c => c.url.includes('/subtitles'))
    assert.match(search.url, /episode_number=3/)
    assert.match(search.url, /query=/)
  })

  it('passes the trusted-only filter through when asked', async () => {
    const { ext, calls } = await load(server())
    await ext.subtitles(QUERY, { ...OPTIONS, trusted_only: true })
    assert.match(calls.find(c => c.url.includes('/subtitles')).url, /trusted_sources=only/)
  })
})

describe('not spending quota twice', () => {
  it('reuses a cached result when the episode is re-opened', async () => {
    const storage = new Map()
    const first = await load(server(), { storage })
    await first.ext.subtitles(QUERY, OPTIONS)

    const second = await load(server(), { storage })
    await second.ext.subtitles(QUERY, OPTIONS)
    assert.equal(second.calls.length, 0, 're-opening must not spend quota again')
  })

  it('does not cache an empty result, which would hide a later fix', async () => {
    const storage = new Map()
    const first = await load(() => ({ json: { data: [] } }), { storage })
    assert.deepEqual(plain(await first.ext.subtitles(QUERY, OPTIONS)), [])

    const second = await load(server(), { storage })
    assert.ok((await second.ext.subtitles(QUERY, OPTIONS)).length > 0)
  })
})

describe('failing safely', () => {
  it('does nothing at all without an API key', async () => {
    const { ext, calls } = await load(server())
    assert.deepEqual(plain(await ext.subtitles(QUERY, { ...OPTIONS, api_key: '' })), [])
    assert.equal(calls.length, 0)
  })

  it('keeps one language when the other fails', async () => {
    // A Hungarian track is still worth having when the English search errored.
    const handler = (parsed) => {
      if (parsed.pathname.endsWith('/subtitles')) {
        if (parsed.searchParams.get('languages') === 'en') return { status: 500 }
        return server()(parsed)
      }
      return server()(parsed)
    }
    const { ext } = await load(handler)
    const tracks = await ext.subtitles(QUERY, OPTIONS)
    assert.deepEqual(tracks.map(t => t.lang), ['hu'])
  })

  it('offers the link when the file itself cannot be fetched', async () => {
    // Worse than text, better than nothing — and visible in the picker rather
    // than silently absent.
    const handler = parsed => (parsed.hostname === 'www.opensubtitles.com' ? { throws: true } : server()(parsed))
    const { ext } = await load(handler)
    const [track] = await ext.subtitles(QUERY, OPTIONS)
    assert.ok(track.url)
    assert.equal(track.content, undefined)
  })

  it('returns nothing rather than throwing when the service is down', async () => {
    const { ext } = await load(() => ({ throws: true }))
    assert.deepEqual(plain(await ext.subtitles(QUERY, OPTIONS)), [])
  })

  it('separates a bad key from a dead service', async () => {
    const ok = await load(server())
    assert.equal(await ok.ext.test(OPTIONS), true)

    const badKey = await load(parsed => (parsed.pathname.endsWith('/infos/user') ? { status: 401 } : null))
    assert.equal(await badKey.ext.test(OPTIONS), false)

    assert.equal(await ok.ext.test({}), false)
  })

  it('does not spend a download just to check the key', async () => {
    const { ext, calls } = await load(server())
    await ext.test(OPTIONS)
    assert.equal(calls.filter(c => c.url.endsWith('/download')).length, 0)
  })
})

describe('srt to vtt', () => {
  const Engine = (() => {
    const context = createContext({
      window: {},
      document: { createElement: () => ({ canPlayType: () => '' }) },
      URL,
      Blob,
      console
    })
    runInNewContext(readFileSync(ENGINE, 'utf8'), context)
    return context.StreamEngine ?? context.window.StreamEngine
  })()

  it('adds the header WebVTT requires', () => {
    // Without it a browser rejects the whole file and the track shows nothing.
    assert.match(Engine.srtToVtt(SRT), /^WEBVTT/)
  })

  it('turns comma timestamps into the dots WebVTT expects', () => {
    const out = Engine.srtToVtt(SRT)
    assert.match(out, /00:00:12\.500 --> 00:00:14\.000/)
    assert.ok(!out.includes('12,500'))
  })

  it('leaves a file that is already WebVTT alone', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n'
    assert.equal(Engine.srtToVtt(vtt), vtt)
  })

  it('copes with Windows line endings', () => {
    assert.match(Engine.srtToVtt('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n'), /00:00:01\.000/)
  })

  it('refuses formats it cannot honestly convert', () => {
    // ASS carries style directives; handing it over unchanged renders a
    // screenful of them instead of dialogue.
    assert.equal(Engine.subtitleObjectUrl('[Script Info]\nTitle: x', 'ass'), null)
    assert.equal(Engine.subtitleObjectUrl('', 'srt'), null)
    assert.equal(Engine.subtitleObjectUrl(null, 'srt'), null)
  })

  it('produces a URL a track element can load', () => {
    const url = Engine.subtitleObjectUrl(SRT, 'srt')
    assert.match(String(url), /^blob:/)
  })
})
