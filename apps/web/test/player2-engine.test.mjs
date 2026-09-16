// Player 2.0 — a motor és a forráskezelő.
//
// DOM nélkül fut. A videóelem csonk, mert a motor szerződése szerint az egy
// PARAMÉTER, nem keresés — ha a motornak `document`-re lenne szüksége, az a
// motor hibája volna.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classify, detectQuality, normalise, rank, score, SOURCE_KIND } from '../src/features/player2/engine/source-ranking.js'
import { engineFor, READY_EVENTS, nativeEngine } from '../src/features/player2/engine/engines.js'
import { createSourceManager, SOURCE_STATE } from '../src/features/player2/engine/source-manager.js'
import { createPlayer } from '../src/features/player2/core/player.js'
import { EV } from '../src/features/player2/core/player-events.js'

const quiet = { error () {}, warn () {}, log () {} }

/**
 * Videócsonk, ami megmondható címekre hibázik.
 * A `src` beállítása után egy tickkel tüzel, mint egy valódi elem.
 */
function fakeVideo (failSubstrings = [], errorCode = 2) {
  const listeners = {}
  return {
    error: { code: errorCode },
    addEventListener (type, fn) { (listeners[type] ||= []).push(fn) },
    removeEventListener (type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn) },
    load () {},
    removeAttribute () {},
    set src (url) {
      const bucket = failSubstrings.some(s => String(url).includes(s)) ? 'error' : 'loadedmetadata'
      setTimeout(() => { (listeners[bucket] ?? []).slice().forEach(fn => fn()) }, 2)
    }
  }
}

describe('source classification', () => {
  it('recognises the stream formats', () => {
    assert.equal(classify('https://a.hu/x.m3u8'), SOURCE_KIND.HLS)
    assert.equal(classify('https://a.hu/x.mpd'), SOURCE_KIND.DASH)
    assert.equal(classify('magnet:?xt=urn:btih:abc'), SOURCE_KIND.MAGNET)
    assert.equal(classify('https://a.hu/x.mp4'), SOURCE_KIND.DIRECT)
  })

  /*
   * Az azonos eredetű út azért `direct`, mert a YUME maga is kiszolgál videót.
   * Ha csak a teljes URL számítana, a katalógusba a tartománynevet kellene
   * írni — 364 064 sorba —, és egy költözés mindet egyszerre törné el.
   */
  it('treats a same-origin path as directly playable', () => {
    assert.equal(classify('/assets/videos/x.mp4'), SOURCE_KIND.DIRECT)
  })

  it('does not treat a protocol-relative URL as same-origin', () => {
    assert.notEqual(classify('//idegen.hu/x.mp4'), SOURCE_KIND.DIRECT)
  })

  it('leaves nonsense unknown', () => {
    assert.equal(classify('csak-szoveg'), SOURCE_KIND.UNKNOWN)
    assert.equal(classify(''), SOURCE_KIND.UNKNOWN)
    assert.equal(classify(null), SOURCE_KIND.UNKNOWN)
  })

  it('reads quality from the field or the title', () => {
    assert.equal(detectQuality({ resolution: '1080' }), 1080)
    assert.equal(detectQuality({ title: 'Show - 01 [720p]' }), 720)
    assert.equal(detectQuality({ title: 'Show - 01' }), null)
  })
})

describe('normalisation', () => {
  /*
   * A MÉRT HIBA. `raw.url ?? raw.link` állt a régiben, a homokozó pedig
   * MINDKÉT kulcsot kiküldi, üres sztringgel abban, amelyiket a bővítmény
   * kihagyta. A `??` az üres sztringet jelenlévőnek veszi, tehát minden
   * csak-link eredmény — vagyis minden torrent — eldobódott, némán.
   */
  it('keeps a record that carries only a link', () => {
    const candidate = normalise({ url: '', link: 'magnet:?xt=urn:btih:abc' })
    assert.ok(candidate, 'a csak-link rekord eldobódott')
    assert.equal(candidate.kind, SOURCE_KIND.MAGNET)
  })

  it('accepts the catalogue\'s own field name', () => {
    assert.equal(normalise({ ref: '/assets/videos/x.mp4' })?.url, '/assets/videos/x.mp4')
  })

  it('drops a record with no usable link instead of throwing', () => {
    assert.equal(normalise({ title: 'nincs benne cím' }), null)
    assert.equal(normalise(null), null)
  })
})

describe('ranking', () => {
  const reg = url => normalise({ url, origin: 'registered' })
  const manual = url => normalise({ url, origin: 'manual' })

  /*
   * A regisztrált forrást valaki, aki ezt az oldalt üzemelteti, kézzel
   * akasztotta ehhez a részhez. Ez erősebb állítás arról, hogy „ez a helyes
   * videó", mint egy egyszer bemásolt szöveg.
   */
  it('puts a registered source above a pasted one', () => {
    const ordered = rank([manual('https://a/1.mp4'), reg('https://a/2.mp4')])
    assert.ok(ordered[0].url.endsWith('2.mp4'))
  })

  it('prefers the requested variant and penalises the other', () => {
    const sub = normalise({ url: 'https://a/s.mp4', variant: 'sub' })
    const dub = normalise({ url: 'https://a/d.mp4', variant: 'dub' })
    assert.ok(score(sub, { variant: 'sub' }) > score(dub, { variant: 'sub' }))
    assert.ok(score(dub, { variant: 'dub' }) > score(sub, { variant: 'dub' }))
  })

  it('does not penalise anything when the viewer said "any"', () => {
    const sub = normalise({ url: 'https://a/s.mp4', variant: 'sub' })
    const dub = normalise({ url: 'https://a/d.mp4', variant: 'dub' })
    assert.equal(score(sub, { variant: 'any' }), score(dub, { variant: 'any' }))
  })

  it('ranks a magnet last without discarding it', () => {
    const ordered = rank([normalise({ url: 'magnet:?xt=1' }), reg('https://a/x.mp4')])
    assert.equal(ordered.at(-1).kind, SOURCE_KIND.MAGNET)
    assert.equal(ordered.length, 2, 'a magnet eltűnt a listából')
  })

  it('is stable for equal scores', () => {
    const a = reg('https://a/1.mp4'); const b = reg('https://a/2.mp4')
    assert.deepEqual(rank([a, b]).map(c => c.url), [a.url, b.url])
  })
})

describe('engine registry', () => {
  it('routes each kind to an engine, and nothing to none', () => {
    assert.equal(engineFor({ kind: SOURCE_KIND.DIRECT })?.name, 'native')
    assert.equal(engineFor({ kind: SOURCE_KIND.HLS })?.name, 'hls')
    assert.equal(engineFor({ kind: SOURCE_KIND.DASH })?.name, 'dash')
    assert.equal(engineFor({ kind: SOURCE_KIND.MAGNET })?.name, 'magnet')
    assert.equal(engineFor({ kind: SOURCE_KIND.UNKNOWN }), null)
  })

  /*
   * A `loadedmetadata` ELSŐ. Mobilon az autoplay tiltása miatt a böngésző
   * megáll a metaadatnál, a `canplay` és a `loadeddata` pedig képkockát kíván
   * — egyikük sem tüzel, és a régi lejátszón minden forrás elbukott.
   */
  it('accepts metadata alone as proof, and lists it first', () => {
    assert.equal(READY_EVENTS[0], 'loadedmetadata')
    assert.ok(READY_EVENTS.includes('canplay'))
  })

  it('a torrent is refused with a reason, not silently', async () => {
    await assert.rejects(
      engineFor({ kind: SOURCE_KIND.MAGNET }).attach({}, { url: 'magnet:?x' }),
      err => err.code === 'SOURCE_UNSUPPORTED')
  })

  it('the native engine resolves once metadata arrives', async () => {
    const video = fakeVideo()
    const teardown = await nativeEngine.attach(video, { url: 'https://a/x.mp4' }, { timeoutMs: 500 })
    assert.equal(typeof teardown, 'function')
  })
})

describe('source manager', () => {
  const build = (failing = [], code = 2) => {
    const player = createPlayer({ video: fakeVideo(failing, code), logger: quiet })
    return { player, manager: createSourceManager(player, { timeoutMs: 300 }) }
  }

  it('reports NO_SOURCE when there is nothing to try', async () => {
    const { player, manager } = build()
    manager.load([])
    const result = await manager.start()
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'NO_SOURCE')
    player.destroy()
  })

  /*
   * ELŐBB MINDENKI KAP EGY ESÉLYT. Ha egy újrapróbálható hiba után azonnal
   * ugyanazt próbálnánk, a néző kétszer várná ki ugyanazt az időtúllépést,
   * mielőtt egy működő forráshoz jutna — tizenkét másodperces határidőnél ez
   * huszonnégy másodperc fekete képernyő egy helyett.
   */
  it('falls through to the next candidate before retrying the first', async () => {
    const { player, manager } = build(['rossz'])
    manager.load([{ url: 'https://a/rossz.mp4' }, { url: 'https://a/jo.mp4' }])
    const result = await manager.start()
    assert.equal(result.ok, true)
    assert.ok(result.candidate.url.includes('jo'))
    assert.deepEqual(manager.entries.map(e => e.attempts), [1, 1], 'az elsőt újrapróbálta a második előtt')
    player.destroy()
  })

  it('records a structured reason for every failure, not a string', async () => {
    const { player, manager } = build(['rossz'])
    manager.load([{ url: 'https://a/rossz.mp4' }, { url: 'https://a/jo.mp4' }])
    await manager.start()
    const failure = manager.entries[0].failure
    assert.equal(failure.code, 'NETWORK_ERROR')
    assert.equal(typeof failure.attempts, 'number')
    assert.equal(typeof failure.at, 'number')
    player.destroy()
  })

  it('stops after a bounded number of attempts rather than looping', async () => {
    const { player, manager } = build(['a', 'b'])
    manager.load([{ url: 'https://x/a.mp4' }, { url: 'https://x/b.mp4' }])
    const result = await manager.start()
    assert.equal(result.ok, false)
    for (const entry of manager.entries) {
      assert.ok(entry.attempts <= 2, `${entry.attempts} kísérlet — a korlát nem tartott`)
      assert.equal(entry.state, SOURCE_STATE.DISABLED)
    }
    player.destroy()
  })

  /*
   * Egy nem újrapróbálható hiba (nem támogatott formátum) után nincs értelme
   * másodszor is nekifutni ugyanannak a falnak.
   */
  it('gives up immediately on a non-retryable failure', async () => {
    const { player, manager } = build(['x'], 4) // 4 = SRC_NOT_SUPPORTED
    manager.load([{ url: 'https://a/x.mp4' }])
    await manager.start()
    assert.equal(manager.entries[0].attempts, 1, 'újrapróbálta a nem újrapróbálhatót')
    assert.equal(manager.entries[0].state, SOURCE_STATE.DISABLED)
    player.destroy()
  })

  it('publishes candidate state into the tree for the UI', async () => {
    const { player, manager } = build(['rossz'])
    manager.load([{ url: 'https://a/rossz.mp4' }, { url: 'https://a/jo.mp4' }])
    await manager.start()
    const published = player.state.get().source
    assert.equal(published.candidates.length, 2)
    assert.equal(published.current.url.includes('jo'), true)
    assert.equal(published.type, SOURCE_KIND.DIRECT)
    player.destroy()
  })

  it('announces failures and the final selection on the bus', async () => {
    const { player, manager } = build(['rossz'])
    const seen = []
    player.bus.on(EV.SOURCE_FAILED, () => seen.push('failed'))
    player.bus.on(EV.SOURCE_SELECTED, () => seen.push('selected'))
    manager.load([{ url: 'https://a/rossz.mp4' }, { url: 'https://a/jo.mp4' }])
    await manager.start()
    assert.deepEqual(seen, ['selected', 'failed', 'selected'])
    player.destroy()
  })

  /*
   * A kézi választás ÚJ ESÉLYT ad: a néző szándéka fölülírja a korábbi
   * bukást, mert azóta változhatott a hálózat.
   */
  it('a manual switch resets a previously failed candidate', async () => {
    const { player, manager } = build([])
    manager.load([{ url: 'https://a/1.mp4', id: 'a' }, { url: 'https://a/2.mp4', id: 'b' }])
    await manager.start()
    const result = await manager.switchTo('b')
    assert.equal(result.ok, true)
    assert.equal(manager.active.id, 'b')
    player.destroy()
  })

  it('destroying the player stops the manager', async () => {
    const { player, manager } = build()
    manager.load([{ url: 'https://a/x.mp4' }])
    player.destroy()
    assert.equal(player.owned, 0)
  })
})
