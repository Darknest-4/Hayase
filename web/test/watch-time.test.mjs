// Measured watch time.
//
// The bug this replaces: watch time was `progress * (duration || 24)`, so
// marking an episode credited a flat 24 minutes that nobody had spent, and
// dragging the scrubber to the end counted as watching a full episode.
//
// Everything below is about the ways a naive meter over-counts — a background
// tab, a sleeping laptop, a seek, a stalled buffer, a video left looping. Each
// one adds time that was never watched, and each one is silent.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, beforeEach } from 'node:test'
import { createContext, runInNewContext } from 'node:vm'

const SRC = new URL('../js/watch-time.js', import.meta.url)

/** A <video> stand-in with the handful of properties the meter reads. */
function fakeVideo (over = {}) {
  const listeners = new Map()
  return {
    paused: false,
    ended: false,
    seeking: false,
    readyState: 4,
    duration: 1440, // 24 minutes
    currentTime: 0,
    addEventListener (type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener (type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter(f => f !== fn))
    },
    emit (type) { for (const fn of listeners.get(type) ?? []) fn() },
    ...over
  }
}

/**
 * Load the module with controllable time and timers, so a test can advance an
 * hour without waiting for one.
 */
function load () {
  const storage = new Map()
  let now = 1_000_000
  const timers = new Set()

  const context = createContext({
    window: {},
    document: {
      hidden: false,
      addEventListener () {},
      removeEventListener () {}
    },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    Store: { activeProfileId: () => 'p1' },
    Date: { now: () => now },
    setInterval: (fn, ms) => { const t = { fn, ms }; timers.add(t); return t },
    clearInterval: t => timers.delete(t),
    console
  })
  runInNewContext(readFileSync(SRC, 'utf8'), context)

  return {
    WatchTime: context.WatchTime ?? context.window.WatchTime,
    storage,
    /** Advance the clock and fire every live timer once per interval. */
    advance (ms, { fireTicks = true } = {}) {
      if (!fireTicks) { now += ms; return }
      const step = 1000
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        now += step
        for (const t of [...timers]) t.fn()
      }
    },
    /** Move the clock without letting any timer run — a throttled tab. */
    skip (ms) { now += ms },
    tickAll () { for (const t of [...timers]) t.fn() }
  }
}

describe('storage', () => {
  let WatchTime
  beforeEach(() => { ({ WatchTime } = load()) })

  it('starts at zero', () => {
    assert.equal(WatchTime.totalSeconds(), 0)
    assert.equal(WatchTime.forEpisode('a', 1), 0)
  })

  it('accumulates per episode and totals across them', () => {
    WatchTime.add('a', 1, 100)
    WatchTime.add('a', 1, 50)
    WatchTime.add('a', 2, 30)
    assert.equal(WatchTime.forEpisode('a', 1), 150)
    assert.equal(WatchTime.forEpisode('a', 2), 30)
    assert.equal(WatchTime.totalSeconds(), 180)
  })

  it('keeps episodes of different shows apart', () => {
    WatchTime.add('a', 1, 100)
    WatchTime.add('b', 1, 40)
    assert.equal(WatchTime.forEpisode('a', 1), 100)
    assert.equal(WatchTime.forEpisode('b', 1), 40)
  })

  it('caps one episode at its runtime plus a margin', () => {
    // A finished video left looping would otherwise accumulate without bound
    // and one tab would dominate every statistic on the profile.
    WatchTime.add('a', 1, 100_000, 1440)
    assert.equal(WatchTime.forEpisode('a', 1), Math.round(1440 * 1.2))
  })

  it('ignores nonsense instead of storing it', () => {
    for (const value of [0, -50, NaN, null, undefined, 'ten']) WatchTime.add('a', 1, value)
    assert.equal(WatchTime.forEpisode('a', 1), 0)
  })

  it('survives storage that throws', () => {
    const context = createContext({
      window: {},
      document: { hidden: false, addEventListener () {}, removeEventListener () {} },
      localStorage: {
        getItem: () => { throw new Error('blocked') },
        setItem: () => { throw new Error('blocked') },
        removeItem: () => {}
      },
      Store: { activeProfileId: () => 'p1' },
      console
    })
    runInNewContext(readFileSync(SRC, 'utf8'), context)
    const W = context.WatchTime ?? context.window.WatchTime
    assert.doesNotThrow(() => W.add('a', 1, 10))
    assert.equal(W.totalSeconds(), 0)
  })
})

describe('metering real playback', () => {
  it('counts seconds while the video plays', () => {
    const { WatchTime, advance } = load()
    const video = fakeVideo()
    WatchTime.attach(video, { animeId: 'a', episode: 1 })
    video.emit('play')
    advance(10_000)
    assert.equal(WatchTime.forEpisode('a', 1), 10)
  })

  it('stops counting while paused', () => {
    const { WatchTime, advance } = load()
    const video = fakeVideo()
    WatchTime.attach(video, { animeId: 'a', episode: 1 })
    video.emit('play')
    advance(5000)
    video.paused = true
    video.emit('pause')
    advance(60_000)
    assert.equal(WatchTime.forEpisode('a', 1), 5, 'a paused tab must not accumulate')
  })

  it('does not count a seek', () => {
    // The old rule was positional, so jumping to the end was a full episode.
    const { WatchTime, advance } = load()
    const video = fakeVideo()
    WatchTime.attach(video, { animeId: 'a', episode: 1 })
    video.emit('play')
    video.seeking = true
    advance(30_000)
    assert.equal(WatchTime.forEpisode('a', 1), 0)
    video.currentTime = 1400
    video.seeking = false
    advance(3000)
    assert.equal(WatchTime.forEpisode('a', 1), 3, 'only the seconds after the seek count')
  })

  it('does not count a stalled buffer', () => {
    const { WatchTime, advance } = load()
    const video = fakeVideo({ readyState: 1 })
    WatchTime.attach(video, { animeId: 'a', episode: 1 })
    video.emit('play')
    advance(20_000)
    assert.equal(WatchTime.forEpisode('a', 1), 0, 'buffering is not watching')
  })

  it('credits only one interval for a gap the timer slept through', () => {
    // A throttled background tab or a sleeping laptop produces one tick with
    // an hour of wall clock behind it. Unbounded, that hour lands in the
    // total; bounded, it is worth one tick.
    const { WatchTime, skip, tickAll } = load()
    const video = fakeVideo()
    WatchTime.attach(video, { animeId: 'a', episode: 1 })
    video.emit('play')
    skip(3_600_000)
    tickAll()
    assert.ok(WatchTime.forEpisode('a', 1) <= 3, `credited ${WatchTime.forEpisode('a', 1)}s for an hour-long gap`)
  })

  it('stops counting once detached', () => {
    const { WatchTime, advance } = load()
    const video = fakeVideo()
    const detach = WatchTime.attach(video, { animeId: 'a', episode: 1 })
    video.emit('play')
    advance(5000)
    detach()
    advance(60_000)
    assert.equal(WatchTime.forEpisode('a', 1), 5)
  })

  it('does nothing without a video or an id', () => {
    const { WatchTime } = load()
    assert.doesNotThrow(() => WatchTime.attach(null, { animeId: 'a', episode: 1 })())
    assert.doesNotThrow(() => WatchTime.attach(fakeVideo(), {})())
  })
})

describe('crediting an episode', () => {
  it('fires once the measured time clears the bar', () => {
    const { WatchTime, advance } = load()
    const video = fakeVideo({ duration: 100 })
    const fired = []
    WatchTime.attach(video, { animeId: 'a', episode: 1, onComplete: e => fired.push(e) })
    video.emit('play')
    advance(79_000)
    assert.equal(fired.length, 0, '79% is not enough')
    advance(2000)
    assert.equal(fired.length, 1, '80% is')
  })

  it('fires exactly once', () => {
    const { WatchTime, advance } = load()
    const video = fakeVideo({ duration: 100 })
    const fired = []
    WatchTime.attach(video, { animeId: 'a', episode: 1, onComplete: e => fired.push(e) })
    video.emit('play')
    advance(200_000)
    assert.equal(fired.length, 1)
  })

  it('does not credit an episode that was only seeked through', () => {
    // This is the reported bug: open the episode, poke at it, and the profile
    // gains a watched episode and 24 minutes.
    const { WatchTime, advance } = load()
    const video = fakeVideo({ duration: 1440 })
    const fired = []
    WatchTime.attach(video, { animeId: 'a', episode: 1, onComplete: e => fired.push(e) })
    video.emit('play')
    video.seeking = true
    advance(5000)
    video.currentTime = 1439
    video.seeking = false
    advance(2000)
    assert.equal(fired.length, 0)
    assert.ok(WatchTime.forEpisode('a', 1) < 10)
  })

  it('applies a lower bar once the video has genuinely ended', () => {
    // Skipping the intro, a recap and the ending is legitimate and lands well
    // under 80% of the runtime.
    const { WatchTime, advance } = load()
    const video = fakeVideo({ duration: 100 })
    const fired = []
    WatchTime.attach(video, { animeId: 'a', episode: 1, onComplete: e => fired.push(e) })
    video.emit('play')
    advance(55_000)
    assert.equal(fired.length, 0)
    video.ended = true
    video.emit('ended')
    assert.equal(fired.length, 1, '55% plus reaching the end counts')
  })

  it('still refuses when the end is reached with almost nothing watched', () => {
    const { WatchTime, advance } = load()
    const video = fakeVideo({ duration: 100 })
    const fired = []
    WatchTime.attach(video, { animeId: 'a', episode: 1, onComplete: e => fired.push(e) })
    video.emit('play')
    advance(4000)
    video.ended = true
    video.emit('ended')
    assert.equal(fired.length, 0, '4% is not an episode however it ended')
  })

  it('does not credit when the runtime is unknown', () => {
    // With no duration there is no bar to clear, and guessing one is how the
    // 24-minute default got there in the first place.
    const { WatchTime, advance } = load()
    const video = fakeVideo({ duration: NaN })
    const fired = []
    WatchTime.attach(video, { animeId: 'a', episode: 1, onComplete: e => fired.push(e) })
    video.emit('play')
    advance(600_000)
    assert.equal(fired.length, 0)
  })
})

describe('reporting', () => {
  it('reports measured minutes', () => {
    const { WatchTime } = load()
    WatchTime.add('a', 1, 1200)
    WatchTime.add('a', 2, 600)
    const out = WatchTime.minutesFor([])
    assert.equal(out.measuredMinutes, 30)
    assert.equal(out.estimatedMinutes, 0)
    assert.equal(out.totalMinutes, 30)
  })

  it('falls back to the estimate only for episodes with no measurement', () => {
    // Without this, every existing profile's history drops to zero on
    // upgrade; with it, nothing new is ever estimated.
    const { WatchTime } = load()
    WatchTime.add('a', 1, 1200) // 20 measured minutes for episode 1
    const out = WatchTime.minutesFor([
      { progress: 3, media: { id: 'a', duration: 24 } }
    ])
    assert.equal(out.measuredMinutes, 20)
    assert.equal(out.estimatedMinutes, 48, 'episodes 2 and 3 only')
    assert.equal(out.totalMinutes, 68)
  })

  it('keeps measured and estimated separable so a screen can say which is which', () => {
    const { WatchTime } = load()
    WatchTime.add('a', 1, 600)
    const out = WatchTime.minutesFor([{ progress: 2, media: { id: 'a', duration: 24 } }])
    assert.ok(out.measuredMinutes > 0 && out.estimatedMinutes > 0)
    assert.equal(out.totalMinutes, out.measuredMinutes + out.estimatedMinutes)
  })

  it('handles an empty or malformed library', () => {
    const { WatchTime } = load()
    for (const entries of [[], null, undefined, [{}], [{ progress: null }]]) {
      assert.doesNotThrow(() => WatchTime.minutesFor(entries))
    }
    assert.equal(WatchTime.minutesFor([]).totalMinutes, 0)
  })

  it('counts episodes that have any measured time', () => {
    const { WatchTime } = load()
    WatchTime.add('a', 1, 300)
    WatchTime.add('a', 2, 10)
    assert.equal(WatchTime.episodesTouched(), 2)
  })
})
