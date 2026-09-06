// Streaming engine tests.
//
// The engine is a plain script that assigns to `window`, so it is loaded here
// against a minimal DOM stub rather than in a browser. That is enough: the
// parts worth testing — normalise, classify, playability, rank — are pure
// apart from one `canPlayType` probe.
//
// This exists because of a bug these tests now pin: normalise read
// `raw.url ?? raw.link`, while the sandbox's sanitiseResult always emits BOTH
// keys and writes an empty string for the one the extension omitted. `??`
// treats '' as present, so every link-only result — which is every torrent
// result — normalised to '' and was dropped with no error. The engine
// returned zero candidates and no failure, so the whole torrent path looked
// like "nothing found" rather than like a bug.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

/** Just enough DOM for the engine to load and for playability to probe codecs. */
function makeContext () {
  const video = {
    canPlayType: (type) => (/mp4|webm|mpegurl/i.test(type) ? 'probably' : '')
  }
  const window = {}
  const context = {
    window,
    document: { createElement: () => video },
    console,
    setTimeout,
    clearTimeout
  }
  context.globalThis = context
  return context
}

let engine
let sandbox

before(() => {
  const context = makeContext()
  runInNewContext(readFileSync(join(here, '../js/stream-engine.js'), 'utf8'), context)
  engine = context.window.StreamEngine
  // Kept so a test can put an extension host on the same `window` the engine
  // closed over; hasProviders reads it at call time.
  sandbox = context.window
  assert.ok(engine, 'the script must expose window.StreamEngine')
})

const source = { slug: 'demo', name: 'Demo', accuracy: 'high', health: 'good' }

describe('normalise', () => {
  it('accepts a result that carries only a link', () => {
    // The regression. sanitiseResult emits url: '' for a torrent result, so
    // this shape is what the engine actually receives — not { link } alone.
    const result = engine.normalise(
      { title: 'Demo torrent', url: '', link: 'magnet:?xt=urn:btih:' + '0'.repeat(40) },
      source
    )
    assert.ok(result, 'a link-only result must not be dropped')
    assert.match(result.url, /^magnet:/)
    assert.equal(result.kind, 'magnet')
  })

  it('accepts a result that carries only a url', () => {
    const result = engine.normalise({ title: 'Demo', url: 'https://example.com/1.mp4', link: '' }, source)
    assert.ok(result)
    assert.equal(result.url, 'https://example.com/1.mp4')
  })

  it('prefers url when both are present', () => {
    const result = engine.normalise(
      { title: 'Demo', url: 'https://example.com/1.mp4', link: 'magnet:?xt=urn:btih:' + '0'.repeat(40) },
      source
    )
    assert.equal(result.url, 'https://example.com/1.mp4')
  })

  it('drops a result that names no location at all', () => {
    for (const raw of [{ title: 'x', url: '', link: '' }, { title: 'x' }, {}, null, undefined]) {
      assert.equal(engine.normalise(raw, source), null, `${JSON.stringify(raw)} names nothing`)
    }
  })

  it('bounds every field it copies from an extension', () => {
    const result = engine.normalise({
      title: 'x'.repeat(5000),
      url: 'https://example.com/1.mp4',
      audio: 'a'.repeat(500),
      container: 'c'.repeat(500),
      subtitles: Array.from({ length: 100 }, () => ({ url: 'https://example.com/s.vtt', label: 'L'.repeat(200) }))
    }, source)
    assert.ok(result.audio.length <= 40)
    assert.ok(result.container.length <= 60)
    assert.ok(result.subtitles.length <= 20)
    assert.ok(result.subtitles.every(s => s.label.length <= 60))
  })

  it('ignores subtitle entries with no url', () => {
    const result = engine.normalise({
      title: 'x',
      url: 'https://example.com/1.mp4',
      subtitles: [{ label: 'no url' }, { url: 'https://example.com/s.vtt', label: 'ok' }, null]
    }, source)
    assert.equal(result.subtitles.length, 1)
  })
})

describe('playability', () => {
  it('reports a torrent as not playable in a browser, with a reason', () => {
    // Honest rather than pretended away: the browser genuinely cannot play it.
    const { playable, reason } = engine.playability('magnet', null)
    assert.equal(playable, false)
    assert.match(reason, /desktop client/)
  })

  it('reports an unrecognised URL as not playable', () => {
    assert.equal(engine.playability('unknown', null).playable, false)
  })
})

describe('rank', () => {
  it('puts playable candidates ahead of unplayable ones', () => {
    const results = [
      engine.normalise({ title: 'torrent', url: '', link: 'magnet:?xt=urn:btih:' + '0'.repeat(40) }, source),
      engine.normalise({ title: 'direct 1080p', url: 'https://example.com/1.mp4', quality: 1080 }, source)
    ]
    const ranked = engine.rank(results)
    assert.equal(ranked[0].url, 'https://example.com/1.mp4')
    assert.equal(ranked[0].playable, true)
  })

  it('does not drop anything it ranks', () => {
    const results = [
      engine.normalise({ title: 'a', url: '', link: 'magnet:?xt=urn:btih:' + '0'.repeat(40) }, source),
      engine.normalise({ title: 'b', url: 'https://example.com/1.mp4' }, source)
    ]
    assert.equal(engine.rank(results).length, 2, 'rank sorts, it must never filter')
  })
})

describe('hasProviders', () => {
  // The episode list asks this before deciding whether an episode with no
  // registered source is worth offering. Getting it wrong in either direction
  // is bad in a different way: false when something could answer hides a
  // playable episode, true when nothing can offers a dead end.

  it('is false when nothing is loaded', () => {
    sandbox.ExtensionHost = undefined
    assert.equal(engine.hasProviders(), false)
    sandbox.ExtensionHost = { loaded: () => [] }
    assert.equal(engine.hasProviders(), false)
  })

  it('is false when the only extensions loaded cannot answer with a source', () => {
    // The same distinction the engine already draws when it decides who to
    // ask: a subtitle extension returning .vtt URLs into the candidate list
    // is the bug that made this typed in the first place.
    sandbox.ExtensionHost = {
      loaded: () => ['subs', 'meta'],
      typeOf: slug => (slug === 'subs' ? 'subtitle' : 'metadata')
    }
    assert.equal(engine.hasProviders(), false)
  })

  it('is true when a source extension is loaded', () => {
    sandbox.ExtensionHost = {
      loaded: () => ['subs', 'finder'],
      typeOf: slug => (slug === 'subs' ? 'subtitle' : 'torrent')
    }
    assert.equal(engine.hasProviders(), true)
  })

  it('treats an untyped extension as able to answer', () => {
    // An older manifest declares no type. Assuming it cannot answer would
    // gate episodes that in fact play, which is the worse of the two errors.
    sandbox.ExtensionHost = { loaded: () => ['legacy'], typeOf: () => null }
    assert.equal(engine.hasProviders(), true)
  })

  it('survives a host that is halfway set up', () => {
    // The host object exists before its methods do during boot, and this is
    // called from a render path that must not throw.
    sandbox.ExtensionHost = {}
    assert.equal(engine.hasProviders(), false)
    sandbox.ExtensionHost = { loaded: () => ['x'] }
    assert.equal(engine.hasProviders(), true, 'no typeOf means the type is unknown, not disqualifying')
  })
})
