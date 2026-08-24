// Dispatching extension calls by declared type.
//
// Before this existed the engine asked *every* loaded extension for `single()`
// and the worker sanitised every array as a stream result. Three of the six
// declared extension types were therefore unusable, and one was worse than
// unusable: a `subtitle` extension's .vtt URL entered the stream candidate
// list and the player tried to play a subtitle file as video.
//
// These tests are about that boundary — who gets asked what, and what shape
// comes back — because both halves fail silently when they are wrong.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, beforeEach } from 'node:test'
import { createContext, runInContext, runInNewContext } from 'node:vm'

const ENGINE = new URL('../js/stream-engine.js', import.meta.url)
const WORKER = new URL('../js/extension-worker.js', import.meta.url)

const plain = value => JSON.parse(JSON.stringify(value))

function loadEngine (host) {
  const context = createContext({
    window: { ExtensionHost: host },
    document: { createElement: () => ({ canPlayType: () => '' }) },
    console
  })
  runInNewContext(readFileSync(ENGINE, 'utf8'), context)
  return context.StreamEngine ?? context.window.StreamEngine
}

/**
 * Run the worker's sanitisers.
 *
 * The worker is a message-driven module, so rather than driving it through
 * postMessage the sanitisers are exercised directly — they are the part that
 * decides what crosses the sandbox boundary.
 */
function loadWorkerInternals () {
  const posted = []
  // The real URL constructor: safeUrl() calls `new URL(raw)` to check the
  // scheme, so a stubbed object makes every URL look invalid and every
  // assertion below pass for the wrong reason.
  const RealUrl = URL
  const context = createContext({
    self: {
      postMessage: m => posted.push(m),
      addEventListener () {},
      set onmessage (fn) { this._onmessage = fn },
      get onmessage () { return this._onmessage }
    },
    URL: RealUrl,
    Blob: class {},
    console
  })
  runInNewContext(readFileSync(WORKER, 'utf8'), context)

  // Top-level `const` declarations live in the context's global lexical scope
  // rather than on the context object, so they are read by evaluating them in
  // the same context rather than off the returned object.
  const read = expr => runInContext(expr, context)
  return { context, read, posted }
}

describe('the engine only asks types that can answer', () => {
  let calls, host, Engine

  beforeEach(() => {
    calls = []
    host = {
      _types: { streamer: 'http', torrents: 'torrent', subs: 'subtitle', meta: 'metadata', skin: 'theme' },
      typeOf (slug) { return this._types[slug] ?? null },
      async call (slug, method) {
        calls.push({ slug, method })
        return []
      },
      async collect () { return { results: [], errors: [] } }
    }
    Engine = loadEngine(host)
  })

  it('declares which types can produce a source', () => {
    assert.deepEqual(plain(Engine.SOURCE_TYPES), ['http', 'torrent', 'nzb'])
  })

  it('asks http and torrent extensions for candidates', async () => {
    await Engine.candidates({}, 1, { extensions: [{ slug: 'streamer' }, { slug: 'torrents' }] })
    assert.deepEqual(calls.map(c => c.slug).sort(), ['streamer', 'torrents'])
  })

  it('never asks a subtitle extension for a stream', async () => {
    // The bug this replaces: a .vtt URL entered the candidate list and the
    // player tried to play it as video.
    await Engine.candidates({}, 1, { extensions: [{ slug: 'subs' }] })
    assert.deepEqual(calls, [])
  })

  it('never asks a metadata or theme extension for a stream', async () => {
    await Engine.candidates({}, 1, { extensions: [{ slug: 'meta' }, { slug: 'skin' }] })
    assert.deepEqual(calls, [])
  })

  it('still asks an extension whose type is unknown', async () => {
    // An older install record without a type must keep working rather than
    // silently stop producing sources.
    await Engine.candidates({}, 1, { extensions: [{ slug: 'legacy' }] })
    assert.deepEqual(calls.map(c => c.slug), ['legacy'])
  })

  it('keeps manually pasted sources whatever the extensions do', async () => {
    const { results } = await Engine.candidates({}, 1, {
      sources: [{ url: 'https://example.com/a.mp4', title: 'Manual', source: { slug: 'manual' } }],
      extensions: [{ slug: 'subs' }]
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].source.slug, 'manual')
  })
})

describe('external subtitle tracks', () => {
  const track = (over = {}) => ({ url: 'https://s.example.com/a.vtt', lang: 'hun', label: 'Magyar', ...over })

  const hostWith = tracks => ({
    typeOf: () => 'subtitle',
    async call () { return [] },
    async collect (method, query, opts) {
      assert.equal(method, 'subtitles')
      assert.deepEqual(plain(opts.types), ['subtitle'])
      return { results: tracks, errors: [] }
    }
  })

  it('asks only subtitle extensions, and for subtitles', async () => {
    const Engine = loadEngine(hostWith([track({ _source: 'opensubs' })]))
    const out = await Engine.externalSubtitles({}, 1)
    assert.equal(out.length, 1)
  })

  it('normalises the language so the picker can match it', async () => {
    const Engine = loadEngine(hostWith([track({ lang: 'hun' })]))
    const [out] = await Engine.externalSubtitles({}, 1)
    assert.equal(out.lang, 'hu')
  })

  it('names the provider, so two "Magyar" tracks are tellable apart', async () => {
    const Engine = loadEngine(hostWith([track({ _source: 'opensubs' })]))
    const [out] = await Engine.externalSubtitles({}, 1)
    assert.match(out.label, /opensubs/)
  })

  it('drops a track with no URL', async () => {
    const Engine = loadEngine(hostWith([{ lang: 'hu', label: 'broken' }]))
    assert.deepEqual(plain(await Engine.externalSubtitles({}, 1)), [])
  })

  it('returns nothing rather than throwing when a provider fails', async () => {
    // A missing subtitle is a smaller problem than a player that will not start.
    const Engine = loadEngine({
      typeOf: () => 'subtitle',
      async call () { return [] },
      async collect () { throw new Error('provider down') }
    })
    assert.deepEqual(plain(await Engine.externalSubtitles({}, 1)), [])
  })

  it('works when no host is present at all', async () => {
    const Engine = loadEngine(undefined)
    assert.deepEqual(plain(await Engine.externalSubtitles({}, 1)), [])
  })
})

describe('merging tracks into a candidate', () => {
  const Engine = loadEngine({ typeOf: () => 'http', async call () { return [] } })

  it('appends external tracks to the stream own tracks', () => {
    const candidate = { url: 'x', subtitles: [{ url: 'a.vtt', lang: 'ja' }] }
    const merged = Engine.withExternalSubtitles(candidate, [{ url: 'b.vtt', lang: 'hu' }])
    assert.equal(merged.subtitles.length, 2)
  })

  it('does not list the same file twice', () => {
    // The same subtitle offered by two providers is one track; listing it
    // twice in the picker looks broken.
    const candidate = { url: 'x', subtitles: [{ url: 'a.vtt', lang: 'hu' }] }
    const merged = Engine.withExternalSubtitles(candidate, [{ url: 'a.vtt', lang: 'hu' }])
    assert.equal(merged.subtitles.length, 1)
  })

  it('leaves the candidate untouched when there is nothing to add', () => {
    const candidate = { url: 'x', subtitles: [] }
    assert.equal(Engine.withExternalSubtitles(candidate, []), candidate)
    assert.equal(Engine.withExternalSubtitles(candidate, null), candidate)
  })

  it('does not mutate the candidate it was given', () => {
    const candidate = { url: 'x', subtitles: [] }
    Engine.withExternalSubtitles(candidate, [{ url: 'b.vtt', lang: 'hu' }])
    assert.equal(candidate.subtitles.length, 0)
  })

  it('copes with a candidate that has no subtitles array', () => {
    const merged = Engine.withExternalSubtitles({ url: 'x' }, [{ url: 'b.vtt', lang: 'hu' }])
    assert.equal(merged.subtitles.length, 1)
  })
})

describe('the sandbox shapes results per method', () => {
  const { read } = loadWorkerInternals()
  const ctx = {
    METHODS: read('METHODS'),
    sanitiseSubtitle: read('sanitiseSubtitle'),
    sanitiseMetadata: read('sanitiseMetadata')
  }

  it('offers every method an extension may implement', () => {
    assert.deepEqual(plain(ctx.METHODS).sort(),
      ['batch', 'metadata', 'movie', 'single', 'subtitles', 'test', 'theme'].sort())
  })

  it('shapes a subtitle as a track, not as a stream', () => {
    const out = ctx.sanitiseSubtitle({ url: 'https://s.example.com/a.vtt', lang: 'hu', label: 'Magyar' })
    assert.equal(out.url, 'https://s.example.com/a.vtt')
    assert.equal(out.format, 'vtt')
    assert.ok(!('seeders' in out), 'a subtitle is not a torrent')
    assert.ok(!('quality' in out), 'a subtitle has no resolution')
  })

  it('rejects a subtitle with no usable URL', () => {
    assert.equal(ctx.sanitiseSubtitle({ lang: 'hu' }), null)
    assert.equal(ctx.sanitiseSubtitle({ url: 'javascript:alert(1)' }), null)
    assert.equal(ctx.sanitiseSubtitle(null), null)
  })

  it('keeps only the subtitle formats a browser can render', () => {
    assert.equal(ctx.sanitiseSubtitle({ url: 'https://a.b/x', format: 'ass' }).format, 'ass')
    assert.equal(ctx.sanitiseSubtitle({ url: 'https://a.b/x', format: 'exe' }).format, 'vtt')
  })

  it('carries a metadata record as a flat bounded bag', () => {
    const out = ctx.sanitiseMetadata({ kind: 'skip', skipType: 'op', start: 12.5, end: 102, ok: true })
    assert.equal(out.kind, 'skip')
    assert.equal(out.start, 12.5)
    assert.equal(out.ok, true)
  })

  it('refuses a metadata record that does not say what it is', () => {
    assert.equal(ctx.sanitiseMetadata({ start: 1 }), null)
    assert.equal(ctx.sanitiseMetadata(null), null)
  })

  it('drops nested values instead of letting them cross', () => {
    // A nested object is an easy route to a prototype-pollution bug on the
    // other side of the boundary, and nothing needs one.
    const out = ctx.sanitiseMetadata({ kind: 'character', nested: { evil: true }, list: [1, 2] })
    assert.ok(!('nested' in out))
    assert.ok(!('list' in out))
  })

  it('never lets a prototype key through', () => {
    // Built with defineProperty because `{ __proto__: 'bad' }` in a literal is
    // ignored by the language — it would create no own key at all and the test
    // would pass without testing anything.
    const input = { kind: 'x', harmless: 1 }
    Object.defineProperty(input, '__proto__', { value: 'bad', enumerable: true, configurable: true })
    Object.defineProperty(input, 'constructor', { value: 'bad', enumerable: true, configurable: true })

    const out = ctx.sanitiseMetadata(input)
    const keys = Object.keys(out)
    assert.deepEqual(keys.sort(), ['harmless', 'kind'])
    // Prototype identity is not asserted: the record is built inside the vm
    // realm, so its Object.prototype is that realm's and never this one's.
  })

  it('validates URL-shaped fields the way stream URLs are validated', () => {
    const ok = ctx.sanitiseMetadata({ kind: 'character', image: 'https://cdn.example.com/a.jpg' })
    assert.equal(ok.image, 'https://cdn.example.com/a.jpg')

    const bad = ctx.sanitiseMetadata({ kind: 'character', image: 'javascript:alert(1)' })
    assert.ok(!('image' in bad), 'an unsafe URL must not cross just because it is metadata')
  })

  it('bounds how much one record may carry', () => {
    const huge = { kind: 'x' }
    for (let i = 0; i < 100; i++) huge['f' + i] = i
    assert.ok(Object.keys(ctx.sanitiseMetadata(huge)).length <= 25)

    const long = ctx.sanitiseMetadata({ kind: 'x', text: 'a'.repeat(5000) })
    assert.ok(long.text.length <= 1000)
  })
})
