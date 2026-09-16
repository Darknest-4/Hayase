// Player 2.0 — a mag.
//
// Ez a suite EGYETLEN DOM-HÍVÁS NÉLKÜL fut. Nem véletlenül: a 2.0 vezérelve,
// hogy a logika nem tud a DOM-ról, és ennek az a próbája, hogy tesztelni lehet
// böngésző nélkül. Ami itt csonkot kívánna, az rossz helyen van.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBus, EV } from '../src/features/player2/core/player-events.js'
import { createState, initialState, LOADING_PHASE } from '../src/features/player2/core/player-state.js'
import { ERROR_CODES, PlayerError, fromMediaError, isCrossOrigin } from '../src/features/player2/core/player-errors.js'
import { createPlayer } from '../src/features/player2/core/player.js'

const quiet = { error () {}, warn () {}, log () {} }
/** Épp annyi videóelem, amennyit a mag megérint. */
const fakeVideo = () => {
  const removed = []
  return {
    removed,
    addEventListener () {},
    removeEventListener (type) { removed.push(type) }
  }
}

describe('event bus', () => {
  it('delivers to every listener and stops after unsubscribe', () => {
    const bus = createBus()
    let seen = 0
    const off = bus.on(EV.PLAY, () => seen++)
    bus.emit(EV.PLAY); bus.emit(EV.PLAY)
    off()
    bus.emit(EV.PLAY)
    assert.equal(seen, 2)
    assert.deepEqual(bus.stats(), {})
  })

  /*
   * Egy elhasalt felirat-frissítés nem állíthatja meg a haladásmérést. A busz
   * ezért minden figyelőt külön keretben hív.
   */
  it('one failing listener does not stop the others', () => {
    const bus = createBus()
    let survived = 0
    bus.on('x', () => { throw new Error('szándékos') })
    bus.on('x', () => survived++)
    bus.emit('x')
    assert.equal(survived, 1)
  })

  /*
   * A `once` leiratkozik kibocsátás KÖZBEN. Ha a busz a halmazon iterálna
   * másolat nélkül, a mögötte lévő figyelők kimaradnának.
   */
  it('a listener unsubscribing mid-emit does not skip the rest', () => {
    const bus = createBus()
    const order = []
    bus.once('x', () => order.push('first'))
    bus.on('x', () => order.push('second'))
    bus.emit('x')
    assert.deepEqual(order, ['first', 'second'])
  })

  it('goes silent after destroy', () => {
    const bus = createBus()
    let seen = 0
    bus.on(EV.PLAY, () => seen++)
    bus.destroy()
    bus.emit(EV.PLAY)
    assert.equal(seen, 0)
  })

  it('every event name is unique', () => {
    const values = Object.values(EV)
    assert.equal(new Set(values).size, values.length, 'két esemény ugyanazt a nevet viseli')
  })
})

describe('state', () => {
  it('starts from a complete tree', () => {
    const s = initialState()
    for (const key of ['status', 'playback', 'source', 'quality', 'subtitles', 'audio', 'episode', 'ui', 'network', 'error']) {
      assert.ok(key in s, `hiányzó névtér: ${key}`)
    }
  })

  /*
   * A `timeupdate` másodpercenként négyszer jön, és a `currentTime` néha
   * ugyanaz. Ha minden patch értesítene, a felirat-, haladás- és vezérlőréteg
   * is újrarajzolna olyankor, amikor semmi nem történt.
   */
  it('notifies only on a real change', () => {
    const st = createState(createBus())
    let seen = 0
    st.subscribe(() => seen++)
    st.patch({ playback: { playing: true } })
    st.patch({ playback: { playing: true } })
    assert.equal(seen, 1)
  })

  it('merges one namespace without clearing the others', () => {
    const st = createState(createBus())
    st.patch({ playback: { volume: 0.5 } })
    st.patch({ playback: { muted: true } })
    assert.equal(st.get().playback.volume, 0.5, 'a korábbi mező elveszett')
    assert.equal(st.get().playback.muted, true)
  })

  it('a slice subscriber only fires for its own slice', () => {
    const st = createState(createBus())
    let volumeChanges = 0
    st.select(x => x.playback.volume, () => volumeChanges++)
    st.patch({ playback: { currentTime: 5 } })
    st.patch({ playback: { volume: 0.3 } })
    assert.equal(volumeChanges, 1)
  })

  it('emits STATE_CHANGED on the bus', () => {
    const bus = createBus()
    const st = createState(bus)
    let seen = 0
    bus.on(EV.STATE_CHANGED, () => seen++)
    st.patch({ status: 'ready' })
    assert.equal(seen, 1)
  })

  it('every loading phase is a known constant', () => {
    assert.ok(LOADING_PHASE[initialState().ui.loadingPhase], 'a kiinduló fázis ismeretlen')
  })
})

describe('errors', () => {
  it('every code carries a retry decision and a message factory', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      assert.equal(typeof spec.retryable, 'boolean', `${code}: hiányzó retryable`)
      assert.equal(typeof spec.message, 'function', `${code}: hiányzó üzenet`)
    }
  })

  /*
   * A LÉNYEG. A `detail` belső URL-t, hívásvermet és tokent is tartalmazhat —
   * a 43. pont szerint annak a képernyőn nincs helye. A `toUser()` ezért
   * kizárólag a taxonómia szövegét adja vissza.
   */
  it('never leaks developer detail to the user', () => {
    const err = new PlayerError('SOURCE_TIMEOUT',
      'https://belso.invalid/titkos?token=abc123 — stack: at foo (bar.js:1)')
    const shown = String(err.toUser() ?? '')
    assert.ok(!shown.includes('token'), 'token a felhasználói üzenetben')
    assert.ok(!shown.includes('belso.invalid'), 'belső URL a felhasználói üzenetben')
    assert.ok(!shown.includes('stack'), 'hívásverem a felhasználói üzenetben')
  })

  it('telemetry carries no free text', () => {
    const err = new PlayerError('MEDIA_ERROR', 'https://belso.invalid/x?token=abc')
    assert.deepEqual(Object.keys(new PlayerError('MEDIA_ERROR').toTelemetry()).sort(), ['at', 'code'])
    assert.ok(!JSON.stringify(err.toTelemetry()).includes('token'))
  })

  it('an unknown code degrades to UNKNOWN instead of throwing', () => {
    assert.equal(new PlayerError('NINCS_ILYEN').code, 'UNKNOWN')
  })

  it('a deliberate abort shows the viewer nothing', () => {
    assert.equal(new PlayerError('ABORTED').toUser(), null)
  })

  /*
   * A böngésző negyedik hibakódja kétértelmű: ismeretlen formátum VAGY
   * eredetközi tiltás. A cím dönti el, mert máshonnan nem tudható — és a
   * kettő más beavatkozást kíván.
   */
  it('maps the four media error codes, splitting the ambiguous one', () => {
    assert.equal(fromMediaError({ code: 1 }).code, 'ABORTED')
    assert.equal(fromMediaError({ code: 2 }).code, 'NETWORK_ERROR')
    assert.equal(fromMediaError({ code: 3 }).code, 'MEDIA_ERROR')
    assert.equal(fromMediaError({ code: 4 }, '/assets/videos/x.mp4').code, 'SOURCE_UNSUPPORTED')
    assert.equal(fromMediaError({ code: 4 }, 'https://idegen.invalid/x.mp4').code, 'CORS_ERROR')
  })

  it('a same-origin path is never cross-origin', () => {
    assert.equal(isCrossOrigin('/assets/videos/x.mp4'), false)
    assert.equal(isCrossOrigin(''), false)
  })

  it('a timeout is retryable, an unsupported format is not', () => {
    assert.equal(new PlayerError('SOURCE_TIMEOUT').retryable, true)
    assert.equal(new PlayerError('SOURCE_UNSUPPORTED').retryable, false)
  })
})

describe('lifecycle', () => {
  it('refuses to start without a video element', () => {
    assert.throws(() => createPlayer({ logger: quiet }), /videóelem/)
  })

  /*
   * A 29. pont szivárgás-tilalma ezen múlik: minden foglalás egy
   * nyilvántartáson megy át, és a `destroy()` végigmegy rajta.
   */
  it('releases every listener and timer on destroy', () => {
    const video = fakeVideo()
    const player = createPlayer({ video, logger: quiet })
    player.listen(video, 'play', () => {})
    player.listen(video, 'pause', () => {})
    player.timer(() => {}, 100000)
    player.interval(() => {}, 100000)
    assert.equal(player.owned, 4)
    player.destroy()
    assert.equal(player.owned, 0)
    assert.deepEqual(video.removed.sort(), ['pause', 'play'])
  })

  /*
   * Fordított sorrendben: ami utoljára foglalt, az függhet a korábbiaktól.
   * A motor például a videóelem figyelőire épül, tehát előbb kell elbontani.
   */
  it('tears down in reverse order', () => {
    const player = createPlayer({ video: fakeVideo(), logger: quiet })
    const order = []
    player.own(() => order.push(1))
    player.own(() => order.push(2))
    player.own(() => order.push(3))
    player.destroy()
    assert.deepEqual(order, [3, 2, 1])
  })

  it('a failing teardown does not stop the rest', () => {
    const player = createPlayer({ video: fakeVideo(), logger: quiet })
    let reached = false
    player.own(() => { reached = true })
    player.own(() => { throw new Error('szándékos') })
    player.destroy()
    assert.equal(reached, true)
  })

  it('destroy is idempotent', () => {
    const player = createPlayer({ video: fakeVideo(), logger: quiet })
    player.destroy()
    assert.doesNotThrow(() => player.destroy())
  })

  it('owning after destroy runs the teardown immediately rather than leaking', () => {
    const player = createPlayer({ video: fakeVideo(), logger: quiet })
    player.destroy()
    let cleaned = false
    player.own(() => { cleaned = true })
    assert.equal(cleaned, true, 'a destroy utáni foglalás bennragadt')
    assert.equal(player.owned, 0)
  })

  it('an error lands in state as user text, never as developer detail', () => {
    const player = createPlayer({ video: fakeVideo(), logger: quiet })
    player.fail(new PlayerError('NETWORK_ERROR', 'https://belso.invalid?token=xyz'))
    assert.equal(player.state.get().status, 'error')
    assert.ok(!JSON.stringify(player.state.get().error).includes('token'))
  })
})
