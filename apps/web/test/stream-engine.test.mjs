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
import { describe, it, before } from 'node:test'

import { install } from './support/browser.mjs'

/** Just enough DOM for playability to probe codecs. */
const videoElement = {
  canPlayType: type => (/mp4|webm|mpegurl/i.test(type) ? 'probably' : '')
}

let engine

before(async () => {
  install({ document: { createElement: () => videoElement } })
  ;({ StreamEngine: engine } = await import('../src/features/player/stream-engine.js'))
  assert.ok(engine, 'stream-engine.js must export StreamEngine')
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

/*
 * AZONOS EREDETŰ ÚT — a saját kiszolgálású videók.
 *
 * A `classify` korábban csak a `http(s):`-sel kezdődő hivatkozást fogadta el
 * `direct`-ként, tehát egy YUME által kiszolgált fájl (`/assets/videos/x.mp4`)
 * „unknown" lett, és a lejátszó „unrecognised stream URL"-lel utasította el.
 *
 * A kézenfekvő kerülőút a teljes URL lett volna a katalógusban — csakhogy az a
 * TARTOMÁNYNEVET égeti bele minden sorba, és egy költözés (duckdns → saját
 * domain) egyszerre tenné tönkre az összeset. Az azonos eredetű út ezért nem
 * kivétel, hanem a helyes alak: a böngésző a `<video src>`-ben az oldal
 * eredetéhez képest oldja fel.
 */
describe('same-origin sources', () => {
  it('treats a root-relative path as directly playable', () => {
    assert.equal(engine.classify('/assets/videos/amv-counting-stars.mp4'), 'direct')
  })

  it('still recognises absolute URLs', () => {
    assert.equal(engine.classify('https://pelda.hu/video.mp4'), 'direct')
  })

  /*
   * A `//pelda.hu/x.mp4` MÁS kiszolgálóra mutat. Ha azonos eredetűnek vennénk,
   * egy idegen host címe csúszna át azon az ágon, ami a sajátunknak készült.
   */
  it('does not treat a protocol-relative URL as same-origin', () => {
    assert.notEqual(engine.classify('//pelda.hu/video.mp4'), 'direct')
  })

  it('keeps stream formats distinct on a relative path', () => {
    assert.equal(engine.classify('/assets/videos/x.m3u8'), 'hls')
    assert.equal(engine.classify('/assets/videos/x.mpd'), 'dash')
    assert.equal(engine.classify('/assets/videos/x.m3u8?token=abc'), 'hls')
  })

  it('leaves a bare string unrecognised', () => {
    assert.equal(engine.classify('csak-egy-szoveg'), 'unknown')
    assert.equal(engine.classify(''), 'unknown')
  })
})

/*
 * MOBIL: a metaadat is bizonyíték.
 *
 * A HIBA, AMIT EZ MEGFOG: telefonon minden forrás „the stream did not start in
 * time"-mal bukott el, miközben asztali böngészőben ugyanaz a fájl azonnal
 * elindult. Az ok nem a hálózat és nem a fájl volt.
 *
 * A mobil böngészők nem indítanak automatikus lejátszást hangos videónál, és
 * ilyenkor MEGÁLLNAK A METAADATNÁL — képkocka-adatot csak felhasználói
 * gesztusra töltenek. A `canplay` és a `loadeddata` viszont mindkettő
 * `readyState >= 2`-t kíván, vagyis tényleges képkockát. Egyik sem következett
 * be, és a tizenkét másodperces határidő minden jelöltet megbuktatott.
 */
describe('ready events', () => {
  it('accepts loadedmetadata as proof a source works', async () => {
    const listeners = new Map()
    const video = {
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: type => listeners.delete(type),
      querySelectorAll: () => [],
      error: null,
      set src (value) { this._src = value },
      get src () { return this._src },
      load () {}
    }
    const candidate = { kind: 'direct', url: '/assets/videos/x.mp4', subtitles: [] }

    const attaching = engine._attach(video, candidate)
    // Csak metaadat érkezik — pontosan az a mobil eset, ami elbukott.
    assert.ok(listeners.has('loadedmetadata'),
      'a motor nem is figyel a loadedmetadata eseményre')
    listeners.get('loadedmetadata')()

    await attaching // feloldódik, nem jár le a határidő
  })

  it('still fails a candidate that errors', async () => {
    const listeners = new Map()
    const video = {
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: type => listeners.delete(type),
      querySelectorAll: () => [],
      error: { message: 'decode failed' },
      set src (value) { this._src = value },
      get src () { return this._src },
      load () {}
    }
    const attaching = engine._attach(video, { kind: 'direct', url: '/x.mp4', subtitles: [] })
    listeners.get('error')()
    await assert.rejects(attaching, /decode failed/)
  })
})
