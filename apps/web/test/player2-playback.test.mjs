// Player 2.0 — lejátszásvezérlés, haladás, folytatás.
//
// DOM nélkül. A videóelem csonk, mert a vezérlő szerződése szerint ő a
// videóelem EGYETLEN gazdája — és egy gazdát pontosan úgy lehet tesztelni,
// hogy megnézzük, mit tesz a rábízott dologgal.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPlayer } from '../src/features/player2/core/player.js'
import { createPlaybackController, RATES } from '../src/features/player2/playback/playback-controller.js'
import { createProgressTracker, COMPLETION_RATIO } from '../src/features/player2/playback/progress.js'
import { createResume, MIN_RESUME_SEC, END_MARGIN_SEC } from '../src/features/player2/playback/resume.js'
import { EV } from '../src/features/player2/core/player-events.js'

const quiet = { error () {}, warn () {}, log () {} }

function fakeVideo (overrides = {}) {
  const listeners = {}
  const video = {
    paused: true,
    ended: false,
    seeking: false,
    currentTime: 0,
    duration: 100,
    volume: 1,
    muted: false,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    addEventListener (type, fn) { (listeners[type] ||= []).push(fn) },
    removeEventListener (type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn) },
    play () { this.paused = false; video.fire('play'); return Promise.resolve() },
    pause () { this.paused = true; video.fire('pause') },
    fire (type) { (listeners[type] ?? []).slice().forEach(fn => fn()) },
    ...overrides
  }
  return video
}

describe('playback controller', () => {
  const build = (overrides) => {
    const video = fakeVideo(overrides)
    const player = createPlayer({ video, logger: quiet })
    return { video, player, controller: createPlaybackController(player) }
  }

  it('mirrors the element into the state tree', async () => {
    const { player, controller } = build()
    await controller.play()
    assert.equal(player.state.get().playback.playing, true)
    player.destroy()
  })

  /*
   * A `play()` ígérete MOBILON ELUTASÍTHATÓ az autoplay tiltása miatt. Az nem
   * hiba, amit jelenteni kell — a néző majd megnyomja a gombot —, de az
   * állapotnak szinkronban kell maradnia, különben a vezérlősáv „megy"
   * állapotot mutat egy álló videóhoz.
   */
  it('reports a blocked autoplay without treating it as a failure', async () => {
    const { player, controller } = build({
      play () { return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) }
    })
    const result = await controller.play()
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'NotAllowedError')
    assert.equal(player.state.get().playback.playing, false)
    assert.equal(player.state.get().status, 'initializing', 'a tiltott autoplay hibaállapotba vitte a lejátszót')
    player.destroy()
  })

  it('clamps a seek to the duration', () => {
    const { video, player, controller } = build()
    controller.seekTo(500)
    assert.equal(video.currentTime, 100)
    controller.seekTo(-10)
    assert.equal(video.currentTime, 0)
    player.destroy()
  })

  it('seeks relatively for keyboard and gestures', () => {
    const { video, player, controller } = build()
    controller.seekTo(50)
    controller.seekBy(-5)
    assert.equal(video.currentTime, 45)
    player.destroy()
  })

  /*
   * Enélkül a csúszka húzása némán történne, és a néző azt hinné, elromlott.
   */
  it('unmutes when the volume is raised', () => {
    const { video, player, controller } = build({ muted: true })
    controller.setVolume(0.5)
    assert.equal(video.muted, false)
    assert.equal(video.volume, 0.5)
    player.destroy()
  })

  it('refuses a speed outside the allowed steps', () => {
    const { player, controller } = build()
    assert.equal(controller.setRate(3), 1)
    assert.equal(controller.setRate(1.5), 1.5)
    assert.ok(RATES.includes(1) && RATES.includes(2))
    player.destroy()
  })

  it('announces playback on the bus', async () => {
    const { player, controller } = build()
    const seen = []
    player.bus.on(EV.PLAY, () => seen.push('play'))
    player.bus.on(EV.PAUSE, () => seen.push('pause'))
    await controller.play()
    controller.pause()
    assert.deepEqual(seen, ['play', 'pause'])
    player.destroy()
  })

  it('lets go of every element listener on destroy', () => {
    const { player } = build()
    assert.ok(player.owned > 0)
    player.destroy()
    assert.equal(player.owned, 0)
  })
})

describe('progress', () => {
  const build = () => {
    const video = fakeVideo({ paused: false })
    const player = createPlayer({ video, logger: quiet })
    return { video, player, tracker: createProgressTracker(player) }
  }

  /*
   * EZ A LÉNYEG, és ez a különbség a becslés és a mérés között. A régi számítás
   * megjelölt epizódok × névleges hossz volt, 24 perces tartalékkal — abban a
   * pillanatban, ahogy egy epizód megjelölődött, a profil kapott egy lapos 24
   * percet, akkor is, ha a néző két percet látott belőle.
   */
  it('cannot be inflated by seeking', async () => {
    const { video, tracker, player } = build()
    video.fire('timeupdate')
    await new Promise(resolve => setTimeout(resolve, 80))
    video.fire('timeupdate')
    const afterRealPlayback = tracker.watchedSec

    video.currentTime = 99 // a néző a végére húzza a csúszkát
    video.fire('timeupdate')

    assert.ok(afterRealPlayback > 0, 'a valódi lejátszás nem számolódott')
    assert.ok(tracker.watchedSec - afterRealPlayback < 0.05,
      'a tekerés nézett időnek számított')
    assert.equal(tracker.completed, false, 'tekeréssel végignézettnek jelölődött')
    player.destroy()
  })

  /*
   * A `timeupdate` egy háttérben lévő fülön perceket ugorhat. Az nem nézés: a
   * néző nem is látta a képernyőt.
   */
  it('ignores a suspiciously long gap between ticks', async () => {
    const { video, tracker, player } = build()
    video.fire('timeupdate')
    await new Promise(resolve => setTimeout(resolve, 60))
    video.fire('timeupdate')
    const before = tracker.watchedSec
    // Kézzel visszaállítjuk az órát, mintha öt perc telt volna el
    await new Promise(resolve => setTimeout(resolve, 10))
    video.fire('timeupdate')
    assert.ok(tracker.watchedSec - before < 0.5, 'egy hosszú szünet nézett időnek számított')
    player.destroy()
  })

  it('does not count while paused', async () => {
    const { video, tracker, player } = build()
    video.fire('timeupdate')
    video.paused = true
    await new Promise(resolve => setTimeout(resolve, 60))
    video.fire('timeupdate')
    assert.equal(tracker.watchedSec, 0)
    player.destroy()
  })

  it('a restored session continues rather than restarting from zero', () => {
    const { tracker, player } = build()
    tracker.restore(600)
    assert.equal(tracker.watchedSec, 600)
    player.destroy()
  })

  it('completion needs the measured ratio, not the position', () => {
    const { video, tracker, player } = build()
    tracker.restore(COMPLETION_RATIO * video.duration + 1)
    video.fire('timeupdate')
    assert.equal(tracker.completed, true)
    player.destroy()
  })

  it('flushes on pause and on page hide', async () => {
    const { video, player } = build()
    let saves = 0
    player.bus.on(EV.WATCH_PROGRESS, () => saves++)
    video.fire('timeupdate')
    await new Promise(resolve => setTimeout(resolve, 20))
    video.fire('timeupdate')
    const tracker2 = createProgressTracker(player, {})
    tracker2.restore(10)
    video.fire('pause')
    assert.ok(saves > 0, 'a szüneteltetés nem mentett')
    player.destroy()
  })
})

describe('resume', () => {
  const build = (store) => {
    const video = fakeVideo()
    const player = createPlayer({ video, logger: quiet })
    return { video, player, resume: createResume(player, { store, key: 'k' }) }
  }

  it('does not offer a resume from the very beginning', () => {
    const { resume, player } = build()
    assert.equal(resume.isResumable(MIN_RESUME_SEC - 1, 100), false)
    assert.equal(resume.isResumable(MIN_RESUME_SEC + 1, 100), true)
    player.destroy()
  })

  /*
   * Aki a legvégén hagyta abba, annak az epizód kész — visszaugrani oda
   * bosszantó, nem szolgáltatás.
   */
  it('does not offer a resume from the very end', () => {
    const { resume, player } = build()
    assert.equal(resume.isResumable(100 - END_MARGIN_SEC + 1, 100), false)
    player.destroy()
  })

  it('applies a stored position once the duration is known', () => {
    const store = new Map([['k', { seconds: 42 }]])
    const { video, resume, player } = build({ get: k => store.get(k), set: (k, v) => store.set(k, v) })
    assert.equal(resume.apply(), true)
    assert.equal(video.currentTime, 42)
    player.destroy()
  })

  /*
   * A tároló hibája (privát ablak, tiltott sütik) nem lehet kiesés: a néző
   * elveszíti a pozícióját, de a lejátszó elindul.
   */
  it('survives a storage that throws', () => {
    const throwing = { get () { throw new Error('nincs tárhely') }, set () { throw new Error('nincs tárhely') } }
    const { resume, player } = build(throwing)
    assert.equal(resume.saved(), 0)
    assert.doesNotThrow(() => resume.remember(10))
    player.destroy()
  })

  it('works with no store at all', () => {
    const { resume, player } = build(null)
    assert.equal(resume.saved(), 0)
    assert.equal(resume.apply(), false)
    player.destroy()
  })
})
